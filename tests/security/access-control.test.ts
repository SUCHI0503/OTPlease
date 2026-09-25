import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { SCOPES } from "../../apps/server/src/lib/apikeys";
import { ADMIN_TOKEN, buildTestApp, flushTestRedis } from "../helpers";

// These tests are generated from the routes the server actually registers, so a route added
// later without authentication or tenant checks fails here without anyone remembering to test it.
const app = buildTestApp({ logger: false, limits: { authFailuresPerIp: { limit: 100000, windowSeconds: 600 } } });
const NOAUTH = { "x-test-no-auth": "1" };
const admin = { "x-admin-token": ADMIN_TOKEN, ...NOAUTH };
const ZERO = "00000000-0000-4000-8000-000000000000";

// Routes that are meant to be reachable without an API key or admin token
const PUBLIC = new Set(["GET /health", "GET /health/ready", "GET /docs", "GET /openapi.json", "POST /auth/refresh"]);

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
  await prisma.auditLog.deleteMany();
  await prisma.riskDecision.deleteMany();
  await prisma.riskConfig.deleteMany();
  await prisma.webhookLog.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.device.deleteMany();
  await prisma.seenIp.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await app.close();
});

const routes = () =>
  app.registeredRoutes.filter((r) => r.method !== "HEAD" && r.method !== "OPTIONS" && !PUBLIC.has(`${r.method} ${r.url}`));
const fill = (url: string, applicationId: string) => url.replace(":applicationId", applicationId).replace(/:\w+/g, ZERO);
const label = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

async function tenant(name: string, scopes: readonly string[] = SCOPES) {
  const id = ((await app.inject({ method: "POST", url: "/applications", payload: { name }, headers: admin })).json() as { id: string }).id;
  const key = ((await app.inject({ method: "POST", url: `/applications/${id}/api-keys`, headers: admin, payload: { name: "k", scopes } })).json() as { key: string }).key;
  return { id, key };
}

const call = (r: { method: string; url: string }, applicationId: string, headers: Record<string, string>) =>
  app.inject({ method: r.method as "GET", url: fill(r.url, applicationId), headers: { ...headers, ...NOAUTH }, payload: r.method === "GET" || r.method === "DELETE" ? undefined : {} });

describe("every route requires credentials", () => {
  it("covers a meaningful number of routes", () => {
    expect(routes().length).toBeGreaterThan(25);
  });

  it("rejects every non-public route when no credentials are sent", async () => {
    const a = await tenant("A");
    const failures: string[] = [];
    for (const r of routes()) {
      const res = await call(r, a.id, {});
      // The Twilio callback has its own signature check instead of a key
      const expected = label(r) === "POST /webhooks/twilio/status" ? 403 : 401;
      if (res.statusCode !== expected) failures.push(`${label(r)} -> ${res.statusCode} (expected ${expected})`);
    }
    expect(failures).toEqual([]);
  });

  it("rejects every non-public route for a garbage API key and a garbage admin token", async () => {
    const a = await tenant("A");
    const fake = `otpl_${"a1b2c3d4e5f6"}_${"Zx9".repeat(15)}`;
    const failures: string[] = [];
    for (const r of routes()) {
      if (label(r) === "POST /webhooks/twilio/status") continue;
      const variants: Record<string, string>[] = [{ "x-api-key": fake }, { "x-admin-token": "not-the-token" }, { "x-api-key": "' OR '1'='1" }];
      for (const headers of variants) {
        const res = await call(r, a.id, headers);
        if (res.statusCode !== 401) failures.push(`${label(r)} with ${Object.keys(headers)[0]} -> ${res.statusCode}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("tenant isolation across every route", () => {
  it("a key from tenant B is refused (403) on every route of tenant A", async () => {
    const a = await tenant("A");
    const b = await tenant("B");
    const failures: string[] = [];
    let checked = 0;
    for (const r of routes().filter((x) => x.url.includes(":applicationId"))) {
      checked++;
      const res = await call(r, a.id, { "x-api-key": b.key });
      if (res.statusCode !== 403) failures.push(`${label(r)} -> ${res.statusCode}`);
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });

  it("a revoked key is refused everywhere", async () => {
    const a = await tenant("A");
    const keys = await prisma.apiKey.findMany();
    await prisma.apiKey.updateMany({ where: { id: { in: keys.map((k) => k.id) } }, data: { revokedAt: new Date() } });
    const failures: string[] = [];
    for (const r of routes().filter((x) => x.url.includes(":applicationId"))) {
      const res = await call(r, a.id, { "x-api-key": a.key });
      if (res.statusCode !== 401) failures.push(`${label(r)} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("scopes are enforced on every route", () => {
  it("a key with only analytics:read is refused wherever another scope is documented as required", async () => {
    const doc = (await app.inject({ method: "GET", url: "/openapi.json", headers: NOAUTH })).json() as { paths: Record<string, Record<string, any>> };
    const a = await tenant("A", ["analytics:read"]);
    const failures: string[] = [];
    let refused = 0;

    for (const r of routes().filter((x) => x.url.includes(":applicationId"))) {
      const documented = doc.paths[r.url.replace(/:(\w+)/g, "{$1}")]?.[r.method.toLowerCase()];
      const needs = documented?.["x-required-scope"] as string | undefined;
      const res = await call(r, a.id, { "x-api-key": a.key });
      if (needs === undefined) {
        failures.push(`${label(r)} has no documented scope`);
      } else if (needs === "analytics:read") {
        if (res.statusCode === 401 || res.statusCode === 403) failures.push(`${label(r)} should allow analytics:read, got ${res.statusCode}`);
      } else {
        refused++;
        if (res.statusCode !== 403) failures.push(`${label(r)} needs ${needs} but analytics:read got ${res.statusCode}`);
      }
    }
    expect(refused).toBeGreaterThan(15);
    expect(failures).toEqual([]);
  });

  it("an API key, even with every scope, cannot use operator-only routes", async () => {
    const a = await tenant("A");
    for (const [method, url] of [["POST", "/applications"], ["GET", "/applications"], ["GET", "/analytics/overview"], ["GET", "/audit-logs"]] as const) {
      const res = await app.inject({ method, url, headers: { "x-api-key": a.key, ...NOAUTH }, payload: method === "POST" ? { name: "x" } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await prisma.application.count()).toBe(1);
  });
});
