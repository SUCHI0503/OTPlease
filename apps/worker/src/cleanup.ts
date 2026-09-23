import { Queue, Worker } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { MAINTENANCE_QUEUE, bullConnection } from "../../server/src/queue/otp-queue";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Deletes finished OTPs and dead sessions. Returns how many rows were removed. */
export async function runCleanup(prisma: PrismaClient, now = new Date()) {
  const otps = await prisma.otpCode.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now.getTime() - DAY) } },
        { consumedAt: { lt: new Date(now.getTime() - DAY) } },
      ],
    },
  });
  const sessions = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { revokedAt: { lt: new Date(now.getTime() - 7 * DAY) } },
      ],
    },
  });
  // Delivery records are only useful for a while, and revoked API keys just clutter the list
  const deliveries = await prisma.delivery.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * DAY) } } });
  // Devices and IPs not seen for 180 days no longer say anything useful about a user
  const cutoff = new Date(now.getTime() - 180 * DAY);
  const devices = await prisma.device.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  const ips = await prisma.seenIp.deleteMany({ where: { lastSeenAt: { lt: cutoff } } });
  const decisions = await prisma.riskDecision.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * DAY) } } });
  // Audit records are kept a year: long enough to investigate, short enough not to hoard
  const audit = await prisma.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 365 * DAY) } } });
  return { auditLogs: audit.count, otps: otps.count, sessions: sessions.count, deliveries: deliveries.count, devices: devices.count + ips.count, riskDecisions: decisions.count };
}

/** Runs cleanup every hour. upsert makes restarting the worker safe (no duplicate schedules). */
export async function startCleanupSchedule(prisma: PrismaClient, log: (msg: string) => void) {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection: bullConnection() });
  await queue.upsertJobScheduler("cleanup", { every: HOUR }, { name: "cleanup" });
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      const result = await runCleanup(prisma);
      log(`cleanup removed ${result.otps} otp codes, ${result.sessions} sessions, ${result.deliveries} deliveries, ${result.devices} stale device/ip records`);
    },
    { connection: bullConnection() }
  );
  return { queue, worker };
}
