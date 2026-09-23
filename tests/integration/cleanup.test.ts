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

    const result = await runCleanup(prisma, now);
    expect(result).toEqual({ otps: 2, sessions: 2 });
    expect(await prisma.otpCode.count()).toBe(2);
    expect(await prisma.session.count()).toBe(2);
  });
});
