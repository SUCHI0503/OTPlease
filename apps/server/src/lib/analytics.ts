import type { PrismaClient } from "@prisma/client";

const DAY = 86_400_000;

export interface AppAnalytics {
  range: { days: number; from: string; to: string };
  totals: {
    otpRequests: number;
    deliveriesSent: number;
    deliveriesDelivered: number;
    deliveriesFailed: number;
    /** (sent + delivered) / (sent + delivered + failed). Null when nothing has finished yet. */
    deliverySuccessRate: number | null;
    logins: number;
    activeSessions: number;
    users: number;
    activeApiKeys: number;
    activeWebhooks: number;
    /** Devices first seen (at a successful login) in the period */
    newDevices: number;
    /** Risk decisions in the period. "wouldBlock" counts blocks in log-only mode, which did not stop anything. */
    riskChallenged: number;
    riskBlocked: number;
    riskWouldBlock: number;
    webhookFailures: number;
  };
  byChannel: { channel: string; requests: number; failed: number }[];
  daily: { date: string; otpRequests: number; logins: number }[];
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Per-day counts for one table, keyed "YYYY-MM-DD" (UTC). Always filtered by application.
 * Timestamps are stored as UTC without a zone, so grouping on their text form and comparing
 * against a zone-less literal keeps the result independent of the database session timezone.
 */
async function dailyCounts(
  prisma: PrismaClient,
  table: "Delivery" | "Session",
  applicationId: string,
  from: Date
): Promise<Map<string, number>> {
  const fromLiteral = from.toISOString();
  const rows =
    table === "Delivery"
      ? await prisma.$queryRaw<{ day: string; n: bigint }[]>`
          SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS n
          FROM "Delivery" WHERE "applicationId" = ${applicationId} AND "createdAt" >= ${fromLiteral}::timestamp
          GROUP BY 1`
      : await prisma.$queryRaw<{ day: string; n: bigint }[]>`
          SELECT to_char("createdAt", 'YYYY-MM-DD') AS day, count(*) AS n
          FROM "Session" WHERE "applicationId" = ${applicationId} AND "createdAt" >= ${fromLiteral}::timestamp
          GROUP BY 1`;
  return new Map(rows.map((r) => [r.day, Number(r.n)]));
}

/**
 * Stats for one application over the last `days` days. OTP requests come from
 * Delivery rows (kept 30 days) and logins from Session rows, because OTP rows
 * are deleted by the cleanup job after a day.
 */
export async function getAppAnalytics(
  prisma: PrismaClient,
  applicationId: string,
  days: number,
  now = new Date()
): Promise<AppAnalytics> {
  // Start of the UTC day (days-1) days ago, so "7 days" means today plus the six before it
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(today.getTime() - (days - 1) * DAY);
  const inRange = { applicationId, createdAt: { gte: from } };

  const [statusGroups, channelGroups, logins, activeSessions, users, activeApiKeys, activeWebhooks, newDevices, riskGroups, webhookFailures, deliveryDaily, loginDaily] =
    await Promise.all([
      prisma.delivery.groupBy({ by: ["status"], where: inRange, _count: true }),
      prisma.delivery.groupBy({ by: ["requestedChannel", "status"], where: inRange, _count: true }),
      prisma.session.count({ where: inRange }),
      prisma.session.count({ where: { applicationId, revokedAt: null, expiresAt: { gt: now } } }),
      prisma.user.count({ where: { applicationId } }),
      prisma.apiKey.count({ where: { applicationId, revokedAt: null } }),
      prisma.webhookEndpoint.count({ where: { applicationId, revokedAt: null } }),
      prisma.device.count({ where: { applicationId, firstSeenAt: { gte: from } } }),
      prisma.riskDecision.groupBy({ by: ["decision", "enforced"], where: inRange, _count: true }),
      prisma.webhookLog.count({ where: { ...inRange, status: "failed" } }),
      dailyCounts(prisma, "Delivery", applicationId, from),
      dailyCounts(prisma, "Session", applicationId, from),
    ]);

  const byStatus = (s: string) => statusGroups.find((g) => g.status === s)?._count ?? 0;
  const sent = byStatus("sent");
  const delivered = byStatus("delivered");
  const failed = byStatus("failed");
  const finished = sent + delivered + failed;
  const risk = (decision: string, enforced?: boolean) =>
    riskGroups.filter((g) => g.decision === decision && (enforced === undefined || g.enforced === enforced)).reduce((n, g) => n + g._count, 0);

  const channels = new Map<string, { requests: number; failed: number }>();
  for (const g of channelGroups) {
    const c = channels.get(g.requestedChannel) ?? { requests: 0, failed: 0 };
    c.requests += g._count;
    if (g.status === "failed") c.failed += g._count;
    channels.set(g.requestedChannel, c);
  }

  const daily = Array.from({ length: days }, (_, i) => {
    const date = dayKey(new Date(from.getTime() + i * DAY));
    return { date, otpRequests: deliveryDaily.get(date) ?? 0, logins: loginDaily.get(date) ?? 0 };
  });

  return {
    range: { days, from: from.toISOString(), to: now.toISOString() },
    totals: {
      otpRequests: statusGroups.reduce((n, g) => n + g._count, 0),
      deliveriesSent: sent,
      deliveriesDelivered: delivered,
      deliveriesFailed: failed,
      deliverySuccessRate: finished === 0 ? null : (sent + delivered) / finished,
      logins,
      activeSessions,
      users,
      activeApiKeys,
      activeWebhooks,
      newDevices,
      riskChallenged: risk("challenge"),
      riskBlocked: risk("block", true),
      riskWouldBlock: risk("block", false),
      webhookFailures,
    },
    byChannel: [...channels].map(([channel, c]) => ({ channel, ...c })).sort((a, b) => b.requests - a.requests),
    daily,
  };
}

/** Operator view: every application with its request and login counts. */
export async function getOverview(prisma: PrismaClient, days: number, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(today.getTime() - (days - 1) * DAY);

  const [apps, requests, logins] = await Promise.all([
    prisma.application.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, name: true, createdAt: true } }),
    prisma.delivery.groupBy({ by: ["applicationId"], where: { createdAt: { gte: from } }, _count: true }),
    prisma.session.groupBy({ by: ["applicationId"], where: { createdAt: { gte: from } }, _count: true }),
  ]);
  const requestMap = new Map(requests.map((r) => [r.applicationId, r._count]));
  const loginMap = new Map(logins.map((r) => [r.applicationId, r._count]));

  const applications = apps.map((a) => ({
    ...a,
    otpRequests: requestMap.get(a.id) ?? 0,
    logins: loginMap.get(a.id) ?? 0,
  }));
  return {
    range: { days, from: from.toISOString(), to: now.toISOString() },
    totals: {
      applications: apps.length,
      otpRequests: applications.reduce((n, a) => n + a.otpRequests, 0),
      logins: applications.reduce((n, a) => n + a.logins, 0),
    },
    applications,
  };
}
