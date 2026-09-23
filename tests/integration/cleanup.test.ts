import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { runCleanup } from "../../apps/worker/src/cleanup";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await prisma.delivery.deleteMany();
  await prisma.device.deleteMany();
  await prisma.seenIp.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("cleanup job", () => {
  it("removes old OTPs and dead sessions but keeps live ones", async () => {
    const now = new Date();
    const app = await prisma.application.create({ data: { name: "A" } });
    const user = await prisma.user.create({ data: { applicationId: app.id, phone: "+919876543210" } });
    const otp = (over: object) =>
      prisma.otpCode.create({
        data: { applicationId: app.id, userId: user.id, codeHash: "x", expiresAt: new Date(now.getTime() + HOUR), ...over },
      });
    const session = (over: object) =>
      prisma.session.create({
        data: { applicationId: app.id, userId: user.id, refreshHash: "x", expiresAt: new Date(now.getTime() + DAY), ...over },
      });

    await otp({ expiresAt: new Date(now.getTime() - 2 * DAY) }); // old expired: removed
    await otp({ consumedAt: new Date(now.getTime() - 2 * DAY) }); // old consumed: removed
    await otp({}); // active: kept
    await otp({ expiresAt: new Date(now.getTime() - HOUR) }); // expired recently: kept (retention)
    await session({ expiresAt: new Date(now.getTime() - HOUR) }); // expired: removed
    await session({ revokedAt: new Date(now.getTime() - 8 * DAY) }); // revoked long ago: removed
    await session({}); // live: kept
    await session({ revokedAt: new Date(now.getTime() - HOUR) }); // revoked recently: kept

    await prisma.delivery.create({
      data: { applicationId: app.id, requestedChannel: "sms", toMasked: "x", createdAt: new Date(now.getTime() - 31 * DAY) },
    });
    await prisma.delivery.create({ data: { applicationId: app.id, requestedChannel: "sms", toMasked: "x" } });

    const result = await runCleanup(prisma, now);
    expect(result).toEqual({ auditLogs: 0, otps: 2, sessions: 2, deliveries: 1, devices: 0, riskDecisions: 0 });
    expect(await prisma.delivery.count()).toBe(1);
    expect(await prisma.otpCode.count()).toBe(2);
    expect(await prisma.session.count()).toBe(2);
  });

  it("removes devices and IPs not seen for 180 days, keeps recent ones", async () => {
    const now = new Date();
    const app = await prisma.application.create({ data: { name: "D" } });
    const user = await prisma.user.create({ data: { applicationId: app.id, phone: "+919876543210" } });
    const old = new Date(now.getTime() - 181 * DAY);
    await prisma.device.create({ data: { applicationId: app.id, userId: user.id, deviceHash: "old", lastSeenAt: old } });
    await prisma.device.create({ data: { applicationId: app.id, userId: user.id, deviceHash: "new" } });
    await prisma.seenIp.create({ data: { applicationId: app.id, userId: user.id, ipHash: "old", ipMasked: "1.2.3.*", lastSeenAt: old } });
    await prisma.seenIp.create({ data: { applicationId: app.id, userId: user.id, ipHash: "new", ipMasked: "1.2.4.*" } });

    const result = await runCleanup(prisma, now);
    expect(result.devices).toBe(2);
    expect(await prisma.device.count()).toBe(1);
    expect(await prisma.seenIp.count()).toBe(1);
  });
});
