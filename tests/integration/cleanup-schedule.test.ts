import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { startCleanupSchedule } from "../../apps/worker/src/cleanup";
import { flushTestRedis, waitFor } from "../helpers";

const DAY = 86_400_000;

beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await flushTestRedis();
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

describe("scheduled cleanup (the real BullMQ schedule, not just the function)", () => {
  it("runs on its own as soon as the worker starts, deletes what is stale, and logs what it removed", async () => {
    const app = await prisma.application.create({ data: { name: "A" } });
    const user = await prisma.user.create({ data: { applicationId: app.id, phone: "+919876543210" } });
    await prisma.otpCode.create({ data: { applicationId: app.id, userId: user.id, codeHash: "x", expiresAt: new Date(Date.now() - 3 * DAY) } });
    await prisma.otpCode.create({ data: { applicationId: app.id, userId: user.id, codeHash: "y", expiresAt: new Date(Date.now() + DAY) } });

    const logs: string[] = [];
    const { queue, worker } = await startCleanupSchedule(prisma, (m) => logs.push(m));
    try {
      await waitFor(() => logs.length > 0, 10_000);
      expect(logs[0]).toMatch(/cleanup removed 1 otp codes/);
      expect(await prisma.otpCode.count()).toBe(1); // the live code survived
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("restarting the worker does not create a second schedule", async () => {
    const first = await startCleanupSchedule(prisma, () => {});
    const second = await startCleanupSchedule(prisma, () => {});
    try {
      const schedulers = await first.queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({ key: "cleanup", every: 3_600_000 });
    } finally {
      await first.worker.close();
      await second.worker.close();
      await first.queue.close();
      await second.queue.close();
    }
  });
});
