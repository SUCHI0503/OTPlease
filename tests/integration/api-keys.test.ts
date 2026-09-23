import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { ADMIN_TOKEN, buildTestApp, flushTestRedis } from "../helpers";

const app = buildTestApp();
const PHONE = "+919876543210";
const NOAUTH = { "x-test-no-auth": "1" };

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
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

const admin = { "x-admin-token": ADMIN_TOKEN };
const withKey = (key: string) => ({ "x-api-key": key });

async function createApplication(name = "Zomato") {
  const res = await app.inject({ method: "POST", url: "/applications", payload: { name }, headers: admin });
  return (res.json() as { id: string }).id;
}

async function createKey(applicationId: string, scopes: string[], name = "backend") {
  const res = await app.inject({
    method: "POST",
    url: `/applications/${applicationId}/api-keys`,
    payload: { name, scopes },
    headers: admin,
  });
  return res.json() as { id: string; key: string; prefix: string };
}

describe("API keys (Phase 11)", () => {
  it("rejects platform routes without the admin token", async () => {
    const created = await app.inject({ method: "POST", url: "/applications", payload: { name: "X" }, headers: NOAUTH });
    expect(created.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/applications", headers: NOAUTH })).statusCode).toBe(401);
    const wrong = await app.inject({ method: "GET", url: "/applications", headers: { "x-admin-token": "nope" } });
    expect(wrong.statusCode).toBe(401);
  });

  it("authenticates a request with a valid key and scope", async () => {
    const id = await createApplication();
    const { key } = await createKey(id, ["otp:request"]);
    const res = await app.inject({
      method: "POST",
      url: `/applications/${id}/otp/request`,
      payload: { phone: PHONE },
      headers: withKey(key),
    });
    expect(res.statusCode).toBe(202);
  });

  it("rejects requests with no key, a malformed key or an unknown key", async () => {
    const id = await createApplication();
    const url = `/applications/${id}/otp/request`;
    const payload = { phone: PHONE };
    expect((await app.inject({ method: "POST", url, payload, headers: NOAUTH })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, payload, headers: withKey("garbage") })).statusCode).toBe(401);
    const forged = `otpl_${"a".repeat(12)}_${"b".repeat(43)}`;
    expect((await app.inject({ method: "POST", url, payload, headers: withKey(forged) })).statusCode).toBe(401);
  });

  it("enforces scopes", async () => {
    const id = await createApplication();
    const { key } = await createKey(id, ["otp:verify"]);
    const res = await app.inject({
      method: "POST",
      url: `/applications/${id}/otp/request`,
      payload: { phone: PHONE },
      headers: withKey(key),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("never lets one tenant's key work on another tenant", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const { key } = await createKey(a, ["users:read", "users:write", "otp:request", "keys:manage"]);
    const headers = withKey(key);
    expect((await app.inject({ method: "GET", url: `/applications/${b}/users`, headers })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: `/applications/${b}/otp/request`, payload: { phone: PHONE }, headers }))
        .statusCode
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: `/applications/${b}/api-keys`, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/applications/${a}/users`, headers })).statusCode).toBe(200);
  });

  it("stops working immediately once revoked", async () => {
    const id = await createApplication();
    const { key, id: keyId } = await createKey(id, ["users:read", "keys:manage"]);
    const url = `/applications/${id}/users`;
    expect((await app.inject({ method: "GET", url, headers: withKey(key) })).statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/applications/${id}/api-keys/${keyId}`, headers: admin });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url, headers: withKey(key) })).statusCode).toBe(401);
    // revoking twice reports not found
    expect((await app.inject({ method: "DELETE", url: `/applications/${id}/api-keys/${keyId}`, headers: admin })).statusCode).toBe(404);
  });

  it("shows the full key only at creation and stores only a hash", async () => {
    const id = await createApplication();
    const created = await createKey(id, ["users:read"]);
    expect(created.key).toMatch(/^otpl_[0-9a-f]{12}_/);

    const row = await prisma.apiKey.findFirstOrThrow();
    expect(row.keyHash).not.toContain(created.key);
    expect(row.keyHash).not.toContain(created.key.slice("otpl_".length + 13));

    const list = await app.inject({ method: "GET", url: `/applications/${id}/api-keys`, headers: admin });
    expect(list.body).not.toContain(created.key);
    expect(list.body).not.toContain(row.keyHash);
    expect(list.json()[0]).toMatchObject({ prefix: created.prefix, name: "backend", scopes: ["users:read"] });
  });

  it("lets a key with keys:manage manage its own application's keys", async () => {
    const id = await createApplication();
    const { key } = await createKey(id, ["keys:manage"]);
    const res = await app.inject({
      method: "POST",
      url: `/applications/${id}/api-keys`,
      payload: { name: "second", scopes: ["otp:verify"] },
      headers: withKey(key),
    });
    expect(res.statusCode).toBe(201);
  });

  it("validates key creation input", async () => {
    const id = await createApplication();
    const bad = (payload: object) =>
      app.inject({ method: "POST", url: `/applications/${id}/api-keys`, payload, headers: admin });
    expect((await bad({ name: "x", scopes: [] })).statusCode).toBe(400);
    expect((await bad({ name: "x", scopes: ["root"] })).statusCode).toBe(400);
    expect((await bad({ scopes: ["users:read"] })).statusCode).toBe(400);
  });

  it("records last use", async () => {
    const id = await createApplication();
    const { key, id: keyId } = await createKey(id, ["users:read"]);
    await app.inject({ method: "GET", url: `/applications/${id}/users`, headers: withKey(key) });
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } });
    expect(row.lastUsedAt).not.toBeNull();
  });
});
