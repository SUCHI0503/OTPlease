import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { hashOtpCode } from "../../apps/server/src/lib/otp";
import { ADMIN_TOKEN, buildTestApp, flushTestRedis } from "../helpers";

const app = buildTestApp({
  logger: false,
  limits: { otpRequestPerPhone: { limit: 1000, windowSeconds: 600 }, otpRequestPerIp: { limit: 1000, windowSeconds: 600 }, otpRequestPerCountry: { limit: 1000, windowSeconds: 600 } },
});
const NOAUTH = { "x-test-no-auth": "1" };
const admin = { "x-admin-token": ADMIN_TOKEN, ...NOAUTH };
const PHONE = "+919876543210";

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

async function createApplication(name = "Zomato") {
  return ((await app.inject({ method: "POST", url: "/applications", payload: { name } })).json() as { id: string }).id;
}
const setConfig = (id: string, config: object) => app.inject({ method: "PUT", url: `/applications/${id}/risk-config`, payload: config });
const requestOtp = (id: string, phone: string) => app.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload: { phone } });

describe("per-tenant send cap", () => {
  it("lets each application set its own hourly cap, and blocks with 429 beyond it", async () => {
    const id = await createApplication();
    await setConfig(id, { sendCapPerHour: 2 });
    const codes: number[] = [];
    for (const phone of ["+919876543210", "+919876543211", "+919876543212"]) codes.push((await requestOtp(id, phone)).statusCode);
    expect(codes).toEqual([202, 202, 429]);
    expect((await requestOtp(id, "+919876543213")).headers["retry-after"]).toBeDefined();
    expect(await prisma.delivery.count()).toBe(2); // nothing was sent beyond the cap
  });

  it("caps tenants independently: one tenant hitting its cap does not affect another", async () => {
    const tight = await createApplication("Tight");
    const roomy = await createApplication("Roomy");
    await setConfig(tight, { sendCapPerHour: 1 });
    await setConfig(roomy, { sendCapPerHour: 50 });
    await requestOtp(tight, "+919876543210");
    expect((await requestOtp(tight, "+919876543211")).statusCode).toBe(429);
    expect((await requestOtp(roomy, "+919876543212")).statusCode).toBe(202);
  });

  it("applies even when risk evaluation is off", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "off", sendCapPerHour: 1 });
    await requestOtp(id, "+919876543210");
    expect((await requestOtp(id, "+919876543211")).statusCode).toBe(429);
  });

  it("does not use up the allowance for requests that other limits already refused", async () => {
    const id = await createApplication();
    await setConfig(id, { sendCapPerHour: 2 });
    const strict = buildTestApp({ logger: false, disconnectPrisma: false, limits: { otpRequestPerPhone: { limit: 1, windowSeconds: 600 }, otpRequestPerIp: { limit: 1000, windowSeconds: 600 }, otpRequestPerCountry: { limit: 1000, windowSeconds: 600 } } });
    await strict.ready();
    const post = (phone: string) => strict.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload: { phone } });
    expect((await post("+919876543210")).statusCode).toBe(202);
    for (let i = 0; i < 5; i++) expect((await post("+919876543210")).statusCode).toBe(429); // per-phone limit
    expect((await post("+919876543211")).statusCode).toBe(202); // the tenant still has its second send
    await strict.close();
  });

  it("uses the platform default when no cap is set, and validates the setting", async () => {
    const id = await createApplication();
    const saved = await setConfig(id, {});
    expect(saved.json().sendCapPerHour).toBeUndefined();
    for (const bad of [0, -5, 1.5, 2_000_000, "many"]) {
      expect((await setConfig(id, { sendCapPerHour: bad })).statusCode, String(bad)).toBe(400);
    }
    expect((await setConfig(id, { sendCapPerHour: 500 })).json().sendCapPerHour).toBe(500);
  });
});

describe("email requests", () => {
  it("rejects a recipient address that tries to inject mail headers", async () => {
    const id = await createApplication();
    for (const email of ["a@example.com\nBcc: evil@example.com", "a@example.com\r\nSubject: hacked", "a@example.com,evil@example.com", "a b@example.com"]) {
      const res = await app.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload: { phone: PHONE, channel: "email", email } });
      expect(res.statusCode, JSON.stringify(email)).toBe(400);
    }
    expect(await prisma.delivery.count()).toBe(0);
  });
});

describe("revoking all of a user's sessions", () => {
  async function loggedIn(applicationId: string, phone: string) {
    await app.inject({ method: "POST", url: `/applications/${applicationId}/users`, payload: { phone } });
    const user = await prisma.user.findFirstOrThrow({ where: { applicationId, phone } });
    await prisma.otpCode.create({ data: { applicationId, userId: user.id, codeHash: hashOtpCode("123456"), expiresAt: new Date(Date.now() + 300_000) } });
    const body = (await app.inject({ method: "POST", url: `/applications/${applicationId}/otp/verify`, payload: { phone, code: "123456" } })).json() as { accessToken: string; refreshToken: string };
    return { user, ...body };
  }
  const me = (token: string) => app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}`, ...NOAUTH } });
  const revoke = (applicationId: string, userId: string, headers?: Record<string, string>) =>
    app.inject({ method: "DELETE", url: `/applications/${applicationId}/users/${userId}/sessions`, ...(headers ? { headers } : {}) });

  it("ends every session of that user at once: tokens and refresh both stop working", async () => {
    const id = await createApplication();
    const first = await loggedIn(id, PHONE);
    // a second login (another device) for the same user
    await prisma.otpCode.create({ data: { applicationId: id, userId: first.user.id, codeHash: hashOtpCode("222222"), expiresAt: new Date(Date.now() + 300_000) } });
    const second = (await app.inject({ method: "POST", url: `/applications/${id}/otp/verify`, payload: { phone: PHONE, code: "222222" } })).json() as { accessToken: string; refreshToken: string };
    expect((await me(first.accessToken)).statusCode).toBe(200);
    expect((await me(second.accessToken)).statusCode).toBe(200);

    const res = await revoke(id, first.user.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });

    expect((await me(first.accessToken)).statusCode).toBe(401);
    expect((await me(second.accessToken)).statusCode).toBe(401);
    for (const t of [first.refreshToken, second.refreshToken]) {
      expect((await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: t } })).statusCode).toBe(401);
    }
  });

  it("leaves other users' sessions alone", async () => {
    const id = await createApplication();
    const alice = await loggedIn(id, PHONE);
    const bob = await loggedIn(id, "+919876543211");
    await revoke(id, alice.user.id);
    expect((await me(alice.accessToken)).statusCode).toBe(401);
    expect((await me(bob.accessToken)).statusCode).toBe(200);
  });

  it("is idempotent and reports zero the second time", async () => {
    const id = await createApplication();
    const alice = await loggedIn(id, PHONE);
    expect((await revoke(id, alice.user.id)).json()).toEqual({ revoked: 1 });
    expect((await revoke(id, alice.user.id)).json()).toEqual({ revoked: 0 });
  });

  it("cannot reach another tenant's user, and needs the users:write scope", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const victim = await loggedIn(a, PHONE);

    const keyOf = async (id: string, scopes: string[]) => ({ "x-api-key": ((await app.inject({ method: "POST", url: `/applications/${id}/api-keys`, headers: admin, payload: { name: "k", scopes } })).json() as { key: string }).key, ...NOAUTH });
    const otherTenant = await keyOf(b, ["users:write"]);
    expect((await revoke(a, victim.user.id, otherTenant)).statusCode).toBe(403);
    expect((await revoke(b, victim.user.id, otherTenant)).statusCode).toBe(404); // not a user of B
    const readOnly = await keyOf(a, ["users:read"]);
    expect((await revoke(a, victim.user.id, readOnly)).statusCode).toBe(403);
    expect((await me(victim.accessToken)).statusCode).toBe(200);
  });

  it("returns 404 for an unknown user and is written to the audit log", async () => {
    const id = await createApplication();
    expect((await revoke(id, "00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
    const alice = await loggedIn(id, PHONE);
    await revoke(id, alice.user.id);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.sessions_revoked" } });
    expect(audit).toMatchObject({ applicationId: id, targetId: alice.user.id, metadata: { revoked: 1 } });
  });
});
