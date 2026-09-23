import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { ADMIN_TOKEN, buildTestApp, flushTestRedis } from "../helpers";

const app = buildTestApp({
  logger: false,
  limits: {
    otpRequestPerPhone: { limit: 1000, windowSeconds: 600 },
    otpRequestPerIp: { limit: 1000, windowSeconds: 600 },
    otpRequestPerCountry: { limit: 1000, windowSeconds: 600 },
  },
});
const PHONE = "+919876543210";
const admin = { "x-admin-token": ADMIN_TOKEN, "x-test-no-auth": "1" };
const IP = "203.0.113.10";

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
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
const setConfig = (id: string, config: object) =>
  app.inject({ method: "PUT", url: `/applications/${id}/risk-config`, payload: config });
const requestOtp = (id: string, payload: object) =>
  app.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload });

describe("risk configuration", () => {
  it("returns defaults for a new application: log-only mode", async () => {
    const id = await createApplication();
    const res = await app.inject({ method: "GET", url: `/applications/${id}/risk-config` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: "log", challengeScore: 40, blockScore: 80 });
  });

  it("saves changes, keeps them, and replaces (not merges) on the next update", async () => {
    const id = await createApplication();
    const saved = await setConfig(id, { mode: "enforce", blockedCountries: ["kp"], challengeScore: 30 });
    expect(saved.json()).toMatchObject({ mode: "enforce", blockedCountries: ["KP"], challengeScore: 30 });
    expect((await app.inject({ method: "GET", url: `/applications/${id}/risk-config` })).json().blockedCountries).toEqual(["KP"]);

    await setConfig(id, { mode: "log" });
    const after = (await app.inject({ method: "GET", url: `/applications/${id}/risk-config` })).json();
    expect(after).toMatchObject({ mode: "log", blockedCountries: [], challengeScore: 40 });
  });

  it("rejects invalid settings with a clear message and keeps the old config", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce" });
    const bad = await setConfig(id, { challengeScore: 90, blockScore: 50 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details[0].message).toMatch(/higher/);
    expect((await setConfig(id, { blockedCountries: ["India"] })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/applications/${id}/risk-config` })).json().mode).toBe("enforce");
  });

  it("returns 404 when configuring an unknown application", async () => {
    const res = await app.inject({ method: "PUT", url: "/applications/00000000-0000-4000-8000-000000000000/risk-config", payload: {}, headers: admin });
    expect(res.statusCode).toBe(404);
  });

  it("needs the risk:manage scope and stays inside the key's own application", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const key = async (id: string, scopes: string[]) =>
      ({ "x-api-key": ((await app.inject({ method: "POST", url: `/applications/${id}/api-keys`, headers: admin, payload: { name: "k", scopes } })).json() as { key: string }).key, "x-test-no-auth": "1" });

    const weak = await key(a, ["otp:request"]);
    expect((await app.inject({ method: "GET", url: `/applications/${a}/risk-config`, headers: weak })).statusCode).toBe(403);
    const strong = await key(a, ["risk:manage"]);
    expect((await app.inject({ method: "PUT", url: `/applications/${a}/risk-config`, headers: strong, payload: { mode: "enforce" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/applications/${b}/risk-config`, headers: strong, payload: { mode: "enforce" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/applications/${b}/risk-config` })).json().mode).toBe("log");
  });
});

describe("enforcement", () => {
  it("blocks a blocked country: 403, no message, no code, no user, decision recorded", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", blockedCountries: ["IN"] });

    const res = await requestOtp(id, { phone: PHONE });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("RISK_BLOCKED");
    expect(res.json().error.details.reasons[0].code).toBe("country_blocked");

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.otpCode.count()).toBe(0);
    expect(await prisma.delivery.count()).toBe(0);
    const decision = await prisma.riskDecision.findFirstOrThrow();
    expect(decision).toMatchObject({ decision: "block", enforced: true, country: "IN", reasons: ["country_blocked"] });
  });

  it("only allows listed countries when an allow-list is set", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", allowedCountries: ["US"] });
    expect((await requestOtp(id, { phone: PHONE })).statusCode).toBe(403);
    expect((await requestOtp(id, { phone: "+14155552671" })).statusCode).toBe(202);
  });

  it("blocks an IP that has been used for too many different phones", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", ipVelocity: { challenge: 2, block: 3 } });
    const ctx = { ip: IP, deviceId: "device-shared-0001" };
    const statuses: number[] = [];
    for (const n of [0, 1, 2, 3]) {
      statuses.push((await requestOtp(id, { phone: `+91987654321${n}`, context: ctx })).statusCode);
    }
    expect(statuses).toEqual([202, 202, 403, 403]);
    expect(await prisma.user.count()).toBe(2); // the blocked phones were never created
  });

  it("challenges but still sends: the code goes out and the response says why", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", ipVelocity: { challenge: 2, block: 9 }, deviceVelocity: { challenge: 9, block: 9 } });
    const ctx = { ip: IP };
    await requestOtp(id, { phone: "+919876543210", context: ctx });
    const res = await requestOtp(id, { phone: "+919876543211", context: ctx });

    expect(res.statusCode).toBe(202);
    expect(res.json().risk).toMatchObject({ decision: "allow", score: 35, reasons: ["ip_velocity"], enforced: true });
    expect(await prisma.delivery.count()).toBe(2);
  });

  it("challenges a login from a new device for a user who has logged in before", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", challengeScore: 30 });
    // an existing user with history
    const user = await prisma.user.create({ data: { applicationId: id, phone: PHONE } });
    await prisma.device.create({ data: { applicationId: id, userId: user.id, deviceHash: "known" } });

    const res = await requestOtp(id, { phone: PHONE, context: { deviceId: "device-brand-new-1", ip: "203.0.113.99" } });
    expect(res.statusCode).toBe(202);
    expect(res.json().risk).toMatchObject({ decision: "challenge", reasons: ["new_device", "new_ip"], score: 35 });
    expect(await prisma.riskDecision.count({ where: { decision: "challenge" } })).toBe(1);
  });

  it("does not treat a brand-new user's first device as suspicious", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce" });
    const res = await requestOtp(id, { phone: PHONE, context: { deviceId: "device-first-0001", ip: IP } });
    expect(res.json().risk).toMatchObject({ decision: "allow", reasons: [] });
  });

  it("notices repeated wrong codes for a user", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", challengeScore: 20 });
    const user = await prisma.user.create({ data: { applicationId: id, phone: PHONE } });
    await prisma.otpCode.create({ data: { applicationId: id, userId: user.id, codeHash: "x", expiresAt: new Date(Date.now() + 1000), attempts: 4, consumedAt: new Date() } });
    const res = await requestOtp(id, { phone: PHONE });
    expect(res.json().risk.reasons).toEqual(["recent_failures"]);
    expect(res.json().risk.decision).toBe("challenge");
  });

  it("challenges requests without forwarded context when requireContext is on", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", requireContext: true });
    const res = await requestOtp(id, { phone: PHONE });
    expect(res.json().risk).toMatchObject({ decision: "challenge", reasons: ["context_missing"] });
    expect((await requestOtp(id, { phone: PHONE, context: { ip: IP } })).json().risk.decision).toBe("allow");
  });
});

describe("log-only and off modes", () => {
  it("log mode never blocks, but reports and records what would have happened", async () => {
    const id = await createApplication(); // default mode is log
    await setConfig(id, { mode: "log", blockedCountries: ["IN"] });
    const res = await requestOtp(id, { phone: PHONE });
    expect(res.statusCode).toBe(202);
    expect(res.json().risk).toMatchObject({ decision: "block", enforced: false, reasons: ["country_blocked"] });
    expect(await prisma.delivery.count()).toBe(1);
    expect(await prisma.riskDecision.findFirstOrThrow()).toMatchObject({ decision: "block", enforced: false });
  });

  it("applications that never configured anything are in log mode and unaffected", async () => {
    const id = await createApplication();
    const res = await requestOtp(id, { phone: PHONE });
    expect(res.statusCode).toBe(202);
    expect(res.json().risk).toMatchObject({ decision: "allow", enforced: false });
  });

  it("off mode does not evaluate at all", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "off", blockedCountries: ["IN"] });
    const res = await requestOtp(id, { phone: PHONE });
    expect(res.statusCode).toBe(202);
    expect(res.json().risk).toBeNull();
    expect(await prisma.riskDecision.count()).toBe(0);
  });

  it("one application's rules never affect another", async () => {
    const strict = await createApplication("Strict");
    const relaxed = await createApplication("Relaxed");
    await setConfig(strict, { mode: "enforce", blockedCountries: ["IN"] });
    expect((await requestOtp(strict, { phone: PHONE })).statusCode).toBe(403);
    expect((await requestOtp(relaxed, { phone: PHONE })).statusCode).toBe(202);
  });
});

describe("decisions, webhooks and analytics", () => {
  it("lists recent decisions, newest first, without storing allows", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", blockedCountries: ["IN"] });
    await requestOtp(id, { phone: PHONE });
    await requestOtp(id, { phone: "+14155552671" }); // allowed, not stored
    await requestOtp(id, { phone: "+919876543211" });

    const list = (await app.inject({ method: "GET", url: `/applications/${id}/risk/decisions` })).json();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ decision: "block", enforced: true, country: "IN", reasons: ["country_blocked"] });
    expect(JSON.stringify(list)).not.toContain("9876543210");

    const limited = await app.inject({ method: "GET", url: `/applications/${id}/risk/decisions?limit=1` });
    expect(limited.json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: `/applications/${id}/risk/decisions?limit=999` })).statusCode).toBe(400);
  });

  it("fires risk.blocked and risk.challenged webhook events", async () => {
    const id = await createApplication();
    const hook = await prisma.webhookEndpoint.create({
      data: { applicationId: id, url: "https://hooks.example.com/x", secretEnc: "x", events: ["risk.blocked", "risk.challenged"] },
    });
    await setConfig(id, { mode: "enforce", blockedCountries: ["IN"], requireContext: true });
    await requestOtp(id, { phone: PHONE }); // blocked
    await requestOtp(id, { phone: "+14155552671" }); // challenged (no context)

    const logs = await prisma.webhookLog.findMany({ where: { endpointId: hook.id } });
    expect(logs.map((l) => l.type).sort()).toEqual(["risk.blocked", "risk.challenged"]);
  });

  it("counts challenges, enforced blocks and would-be blocks in analytics", async () => {
    const id = await createApplication();
    await setConfig(id, { mode: "enforce", blockedCountries: ["IN"], requireContext: true });
    await requestOtp(id, { phone: PHONE });
    await requestOtp(id, { phone: "+919876543211" });
    await requestOtp(id, { phone: "+14155552671" }); // challenge
    await setConfig(id, { mode: "log", blockedCountries: ["IN"] });
    await requestOtp(id, { phone: "+919876543212" }); // would block

    const totals = (await app.inject({ method: "GET", url: `/applications/${id}/analytics` })).json().totals;
    expect(totals).toMatchObject({ riskChallenged: 1, riskBlocked: 2, riskWouldBlock: 1 });
  });
});
