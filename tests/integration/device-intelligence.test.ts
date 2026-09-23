import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { hashOtpCode } from "../../apps/server/src/lib/otp";
import { buildTestApp, flushTestRedis } from "../helpers";

const app = buildTestApp({ logger: false, limits: { verifyPerPhone: { limit: 1000, windowSeconds: 600 }, otpRequestPerPhone: { limit: 1000, windowSeconds: 600 } } });
const PHONE = "+919876543210";
const DEVICE_A = "device-aaaaaaaa-1111";
const DEVICE_B = "device-bbbbbbbb-2222";
const IP_1 = "203.0.113.10";
const IP_2 = "198.51.100.77";

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
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

/** Puts a known code in the database, so a test can verify without going through the message queue */
async function login(applicationId: string, context?: object, phone = PHONE) {
  await app.inject({ method: "POST", url: `/applications/${applicationId}/users`, payload: { phone } });
  const user = await prisma.user.findFirstOrThrow({ where: { applicationId, phone } });
  await prisma.otpCode.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } });
  await prisma.otpCode.create({
    data: { applicationId, userId: user.id, codeHash: hashOtpCode("123456"), expiresAt: new Date(Date.now() + 300_000) },
  });
  const res = await app.inject({
    method: "POST",
    url: `/applications/${applicationId}/otp/verify`,
    payload: { phone, code: "123456", ...(context ? { context } : {}) },
  });
  return { res, body: res.json(), user };
}

const requestOtp = (applicationId: string, context?: object, phone = PHONE) =>
  app.inject({ method: "POST", url: `/applications/${applicationId}/otp/request`, payload: { phone, ...(context ? { context } : {}) } });

describe("new device detection (Phase 14)", () => {
  it("flags the first login from a device as new, and later logins from it as known", async () => {
    const id = await createApplication();
    const first = await login(id, { deviceId: DEVICE_A, ip: IP_1 });
    expect(first.body.device).toMatchObject({ isNew: true, isFirstDevice: true, isNewIp: true });

    const again = await login(id, { deviceId: DEVICE_A, ip: IP_1 });
    expect(again.body.device).toMatchObject({ isNew: false, isFirstDevice: false, isNewIp: false });
    expect(await prisma.device.count()).toBe(1);
  });

  it("detects a second, different device for the same user", async () => {
    const id = await createApplication();
    await login(id, { deviceId: DEVICE_A, ip: IP_1 });
    const other = await login(id, { deviceId: DEVICE_B, ip: IP_1 });
    expect(other.body.device).toMatchObject({ isNew: true, isFirstDevice: false, isNewIp: false });
    expect(await prisma.device.count()).toBe(2);
  });

  it("detects a known device arriving from a new IP", async () => {
    const id = await createApplication();
    await login(id, { deviceId: DEVICE_A, ip: IP_1 });
    const moved = await login(id, { deviceId: DEVICE_A, ip: IP_2 });
    expect(moved.body.device).toMatchObject({ isNew: false, isNewIp: true });
  });

  it("works without any context: no signals, nothing stored, login unaffected", async () => {
    const id = await createApplication();
    const { res, body } = await login(id);
    expect(res.statusCode).toBe(200);
    expect(body.accessToken).toBeTruthy();
    expect(body.device).toEqual({ id: null, isNew: null, isFirstDevice: null, isNewIp: null });
    expect(await prisma.device.count()).toBe(0);
    expect(await prisma.seenIp.count()).toBe(0);
  });

  it("does not record a device when the code is wrong", async () => {
    const id = await createApplication();
    await app.inject({ method: "POST", url: `/applications/${id}/users`, payload: { phone: PHONE } });
    const user = await prisma.user.findFirstOrThrow();
    await prisma.otpCode.create({ data: { applicationId: id, userId: user.id, codeHash: hashOtpCode("123456"), expiresAt: new Date(Date.now() + 300_000) } });
    const res = await app.inject({
      method: "POST", url: `/applications/${id}/otp/verify`,
      payload: { phone: PHONE, code: "000000", context: { deviceId: DEVICE_A, ip: IP_1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.device.count()).toBe(0);
    expect(await prisma.seenIp.count()).toBe(0);
  });

  it("treats the same physical device as different in another application", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    await login(a, { deviceId: DEVICE_A, ip: IP_1 });
    const inB = await login(b, { deviceId: DEVICE_A, ip: IP_1 }, "+919876543211");
    expect(inB.body.device).toMatchObject({ isNew: true, isNewIp: true });
    const hashes = (await prisma.device.findMany()).map((d) => d.deviceHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it("fires a device.new webhook event for a new device only", async () => {
    const id = await createApplication();
    const hook = await prisma.webhookEndpoint.create({ data: { applicationId: id, url: "https://hooks.example.com/x", secretEnc: "x", events: ["device.new"] } });

    await login(id, { deviceId: DEVICE_A, ip: IP_1 });
    await login(id, { deviceId: DEVICE_A, ip: IP_1 }); // known: no event
    await login(id, { deviceId: DEVICE_B, ip: IP_1 });

    const logs = await prisma.webhookLog.findMany({ where: { endpointId: hook.id, type: "device.new" } });
    expect(logs).toHaveLength(2);
  });
});

describe("request-time signals", () => {
  it("reports a new device before the first login and a known one afterwards", async () => {
    const id = await createApplication();
    const before = (await requestOtp(id, { deviceId: DEVICE_A, ip: IP_1 })).json();
    expect(before.signals).toMatchObject({ newDevice: true, newIp: true, ip: { version: 4, isPrivate: false } });

    await login(id, { deviceId: DEVICE_A, ip: IP_1 });
    const after = (await requestOtp(id, { deviceId: DEVICE_A, ip: IP_1 })).json();
    expect(after.signals).toMatchObject({ newDevice: false, newIp: false });
  });

  it("returns null signals when no context is sent", async () => {
    const id = await createApplication();
    const res = (await requestOtp(id)).json();
    expect(res.signals).toEqual({ newDevice: null, newIp: null, ip: null, phonesFromIp: null, phonesFromDevice: null });
  });

  it("counts how many different phones one IP and one device are used with", async () => {
    const id = await createApplication();
    const ctx = { deviceId: DEVICE_A, ip: IP_1 };
    const phones = ["+919876543210", "+919876543211", "+919876543212"];
    const results: any[] = [];
    for (const p of phones) results.push((await requestOtp(id, ctx, p)).json().signals);
    expect(results.map((s) => s.phonesFromIp)).toEqual([1, 2, 3]);
    expect(results.map((s) => s.phonesFromDevice)).toEqual([1, 2, 3]);

    // the same phone again does not inflate the count
    expect((await requestOtp(id, ctx, phones[0])).json().signals.phonesFromIp).toBe(3);
  });

  it("does not mix velocity between applications", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const ctx = { deviceId: DEVICE_A, ip: IP_1 };
    await requestOtp(a, ctx, "+919876543210");
    await requestOtp(a, ctx, "+919876543211");
    expect((await requestOtp(b, ctx, "+919876543212")).json().signals.phonesFromIp).toBe(1);
  });

  it("flags private and loopback addresses", async () => {
    const id = await createApplication();
    const s = (await requestOtp(id, { ip: "127.0.0.1" })).json().signals;
    expect(s.ip).toEqual({ version: 4, isPrivate: true });
    expect(s.phonesFromDevice).toBeNull();
  });

  it("gives velocity counters an expiry, so Redis cannot grow without bound", async () => {
    const id = await createApplication();
    await requestOtp(id, { deviceId: DEVICE_A, ip: IP_1 });
    const { Redis } = await import("ioredis");
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys("intel:*");
    const ttls = await Promise.all(keys.map((k) => redis.ttl(k)));
    redis.disconnect();
    expect(keys.length).toBe(2);
    for (const ttl of ttls) expect(ttl).toBeGreaterThan(0);
  });
});

describe("privacy and validation", () => {
  it("never stores the raw IP or device id", async () => {
    const id = await createApplication();
    await login(id, { deviceId: DEVICE_A, ip: IP_1, userAgent: "TestBrowser/1.0" });
    const dump = JSON.stringify([await prisma.device.findMany(), await prisma.seenIp.findMany()]);
    expect(dump).not.toContain(IP_1);
    expect(dump).not.toContain(DEVICE_A);
    expect(dump).toContain("203.0.113.*");
  });

  it("lists a user's devices without raw identifiers, scoped to the tenant", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const { user } = await login(a, { deviceId: DEVICE_A, ip: IP_1, userAgent: "TestBrowser/1.0" });

    const list = await app.inject({ method: "GET", url: `/applications/${a}/users/${user.id}/devices` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ userAgent: "TestBrowser/1.0", lastIpMasked: "203.0.113.*" });
    expect(list.body).not.toContain(IP_1);
    expect(list.body).not.toContain(DEVICE_A);

    const cross = await app.inject({ method: "GET", url: `/applications/${b}/users/${user.id}/devices` });
    expect(cross.statusCode).toBe(404);
  });

  it("rejects malformed context", async () => {
    const id = await createApplication();
    for (const bad of [{ ip: "not-an-ip" }, { ip: "999.1.1.1" }, { deviceId: "short" }, { deviceId: "x".repeat(200) }, { userAgent: "u".repeat(501) }]) {
      expect((await requestOtp(id, bad)).statusCode, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await requestOtp(id, { ip: "2001:db8::1", deviceId: DEVICE_A })).statusCode).toBe(202);
  });

  it("truncates a long user agent", async () => {
    const id = await createApplication();
    await login(id, { deviceId: DEVICE_A, userAgent: "u".repeat(400) });
    expect((await prisma.device.findFirstOrThrow()).userAgent).toHaveLength(200);
  });

  it("counts new devices in analytics", async () => {
    const id = await createApplication();
    await login(id, { deviceId: DEVICE_A });
    await login(id, { deviceId: DEVICE_A });
    await login(id, { deviceId: DEVICE_B });
    const stats = await app.inject({ method: "GET", url: `/applications/${id}/analytics` });
    expect(stats.json().totals.newDevices).toBe(2);
  });
});
