import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { ADMIN_TOKEN, buildTestApp, flushTestRedis } from "../helpers";

const app = buildTestApp();
const DAY = 86_400_000;
const admin = { "x-admin-token": ADMIN_TOKEN };
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

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
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await app.close();
});

async function seedApp(name: string) {
  const application = await prisma.application.create({ data: { name } });
  const user = await prisma.user.create({ data: { applicationId: application.id, phone: `+9198765${Math.floor(10000 + Math.random() * 89999)}` } });
  return { application, user };
}

const delivery = (applicationId: string, status: string, requestedChannel: string, createdAt = new Date()) =>
  prisma.delivery.create({ data: { applicationId, status, requestedChannel, toMasked: "+91*****", createdAt } });

const session = (applicationId: string, userId: string, createdAt = new Date(), over: object = {}) =>
  prisma.session.create({
    data: { applicationId, userId, refreshHash: "x", expiresAt: new Date(Date.now() + DAY), createdAt, ...over },
  });

const stats = async (id: string, query = "", headers: Record<string, string> = admin) =>
  app.inject({ method: "GET", url: `/applications/${id}/analytics${query}`, headers: { ...headers, "x-test-no-auth": "1" } });

describe("application analytics (Phase 13)", () => {
  it("counts requests, delivery outcomes, logins and success rate", async () => {
    const { application: a, user } = await seedApp("A");
    await delivery(a.id, "delivered", "sms");
    await delivery(a.id, "sent", "sms");
    await delivery(a.id, "failed", "whatsapp");
    await delivery(a.id, "queued", "sms");
    await session(a.id, user.id);
    await session(a.id, user.id, new Date(), { revokedAt: new Date() });

    const body = (await stats(a.id)).json();
    expect(body.totals).toMatchObject({
      otpRequests: 4,
      deliveriesSent: 1,
      deliveriesDelivered: 1,
      deliveriesFailed: 1,
      logins: 2,
      activeSessions: 1,
      users: 1,
    });
    expect(body.totals.deliverySuccessRate).toBeCloseTo(2 / 3);
    expect(body.byChannel).toEqual([
      { channel: "sms", requests: 3, failed: 0 },
      { channel: "whatsapp", requests: 1, failed: 1 },
    ]);
  });

  it("reports a null success rate when nothing has finished", async () => {
    const { application: a } = await seedApp("A");
    await delivery(a.id, "queued", "sms");
    expect((await stats(a.id)).json().totals.deliverySuccessRate).toBeNull();
  });

  it("returns one zero-filled entry per day and puts counts on the right day", async () => {
    const { application: a, user } = await seedApp("A");
    await delivery(a.id, "sent", "sms", daysAgo(2));
    await delivery(a.id, "sent", "sms", daysAgo(2));
    await session(a.id, user.id, daysAgo(0));

    const { daily } = (await stats(a.id, "?days=5")).json();
    expect(daily).toHaveLength(5);
    expect(daily.map((d: { date: string }) => d.date)).toEqual([...daily.map((d: { date: string }) => d.date)].sort());
    const twoAgo = daysAgo(2).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    expect(daily.find((d: { date: string }) => d.date === twoAgo)).toMatchObject({ otpRequests: 2, logins: 0 });
    expect(daily.find((d: { date: string }) => d.date === today)).toMatchObject({ otpRequests: 0, logins: 1 });
    expect(daily.filter((d: { otpRequests: number }) => d.otpRequests === 0)).toHaveLength(4);
  });

  it("excludes activity older than the requested range", async () => {
    const { application: a } = await seedApp("A");
    await delivery(a.id, "sent", "sms", daysAgo(10));
    await delivery(a.id, "sent", "sms", daysAgo(1));
    expect((await stats(a.id, "?days=7")).json().totals.otpRequests).toBe(1);
    expect((await stats(a.id, "?days=30")).json().totals.otpRequests).toBe(2);
  });

  it("never mixes in another tenant's data", async () => {
    const { application: a, user: ua } = await seedApp("A");
    const { application: b, user: ub } = await seedApp("B");
    await delivery(a.id, "sent", "sms");
    await session(a.id, ua.id);
    await delivery(b.id, "failed", "voice");
    await delivery(b.id, "failed", "voice");
    await session(b.id, ub.id);

    const forA = (await stats(a.id)).json();
    expect(forA.totals).toMatchObject({ otpRequests: 1, logins: 1, deliveriesFailed: 0 });
    expect(forA.byChannel).toEqual([{ channel: "sms", requests: 1, failed: 0 }]);
    expect(forA.daily.reduce((n: number, d: { otpRequests: number }) => n + d.otpRequests, 0)).toBe(1);
  });

  it("validates the days parameter", async () => {
    const { application: a } = await seedApp("A");
    for (const bad of ["0", "31", "abc", "-1", "2.5"]) {
      expect((await stats(a.id, `?days=${bad}`)).statusCode, bad).toBe(400);
    }
    expect((await stats(a.id, "?days=30")).statusCode).toBe(200);
  });

  it("returns 404 for an unknown application", async () => {
    expect((await stats("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  it("requires the analytics:read scope and stays inside the key's own application", async () => {
    const { application: a } = await seedApp("A");
    const { application: b } = await seedApp("B");
    const make = async (id: string, scopes: string[]) =>
      ({ "x-api-key": ((await app.inject({ method: "POST", url: `/applications/${id}/api-keys`, headers: admin, payload: { name: "k", scopes } })).json() as { key: string }).key });

    const noScope = await make(a.id, ["otp:request"]);
    expect((await stats(a.id, "", noScope)).statusCode).toBe(403);

    const reader = await make(a.id, ["analytics:read"]);
    expect((await stats(a.id, "", reader)).statusCode).toBe(200);
    expect((await stats(b.id, "", reader)).statusCode).toBe(403);
    expect((await stats(a.id, "", {})).statusCode).toBe(401);
  });

  it("counts active keys and webhooks and failed webhook deliveries", async () => {
    const { application: a } = await seedApp("A");
    const hook = await prisma.webhookEndpoint.create({ data: { applicationId: a.id, url: "https://x.example.com", secretEnc: "x", events: ["otp.verified"] } });
    await prisma.webhookEndpoint.create({ data: { applicationId: a.id, url: "https://y.example.com", secretEnc: "x", events: [], revokedAt: new Date() } });
    await prisma.webhookLog.create({ data: { applicationId: a.id, endpointId: hook.id, eventId: "e1", type: "otp.verified", status: "failed" } });
    await prisma.webhookLog.create({ data: { applicationId: a.id, endpointId: hook.id, eventId: "e2", type: "otp.verified", status: "success" } });
    await prisma.apiKey.create({ data: { applicationId: a.id, name: "live", prefix: "aaaaaaaaaaaa", keyHash: "h", scopes: [] } });
    await prisma.apiKey.create({ data: { applicationId: a.id, name: "dead", prefix: "bbbbbbbbbbbb", keyHash: "h", scopes: [], revokedAt: new Date() } });

    expect((await stats(a.id)).json().totals).toMatchObject({ activeWebhooks: 1, webhookFailures: 1, activeApiKeys: 1 });
  });
});

describe("operator overview", () => {
  it("lists every application with its counts, admin only", async () => {
    const { application: a, user: ua } = await seedApp("Alpha");
    const { application: b } = await seedApp("Beta");
    await delivery(a.id, "sent", "sms");
    await delivery(a.id, "sent", "sms");
    await session(a.id, ua.id);
    await delivery(b.id, "sent", "sms");

    const res = await app.inject({ method: "GET", url: "/analytics/overview", headers: { ...admin, "x-test-no-auth": "1" } });
    const body = res.json();
    expect(body.totals).toEqual({ applications: 2, otpRequests: 3, logins: 1 });
    expect(body.applications.find((x: { name: string }) => x.name === "Alpha")).toMatchObject({ otpRequests: 2, logins: 1 });

    const anon = await app.inject({ method: "GET", url: "/analytics/overview", headers: { "x-test-no-auth": "1" } });
    expect(anon.statusCode).toBe(401);
  });
});
