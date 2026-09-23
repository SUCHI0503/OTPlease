import crypto from "node:crypto";
import net from "node:net";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { env } from "./env";
import { isPrivateAddress } from "./webhook-http";

/**
 * What the developer's backend tells us about the end user's request.
 * OTPlease only ever sees the developer's server, so the user's IP and device
 * must be forwarded. Nothing here is trusted for authentication: it only feeds signals.
 */
export interface RequestContext {
  ip?: string;
  deviceId?: string;
  userAgent?: string;
}

const key = crypto.createHmac("sha256", env.OTP_HASH_SECRET).update("device-intel-v1").digest();
const hmac = (value: string) => crypto.createHmac("sha256", key).update(value).digest("hex");

/** Scoped by application, so the same physical device looks different to two tenants (no cross-tenant tracking). */
export const hashDevice = (applicationId: string, deviceId: string) => hmac(`device:${applicationId}:${deviceId}`);
export const hashIp = (applicationId: string, ip: string) => hmac(`ip:${applicationId}:${normalizeIp(ip)}`);
const hashPhone = (applicationId: string, phone: string) => hmac(`phone:${applicationId}:${phone}`);

/** Lowercases IPv6, drops a zone id, and turns IPv4-mapped IPv6 into plain IPv4 so one address has one form. */
export function normalizeIp(ip: string): string {
  const clean = ip.trim().replace(/%.*$/, "").toLowerCase();
  const mapped = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1]! : clean;
}

/** "203.0.113.42" -> "203.0.113.*", "2001:db8:1:2::3" -> "2001:db8:1:*". Enough to recognise, not to locate. */
export function maskIp(ip: string): string {
  const n = normalizeIp(ip);
  if (net.isIPv4(n)) return n.split(".").slice(0, 3).join(".") + ".*";
  return n.split(":").filter(Boolean).slice(0, 3).join(":") + ":*";
}

export function ipInfo(ip: string) {
  const n = normalizeIp(ip);
  return { version: (net.isIPv4(n) ? 4 : 6) as 4 | 6, isPrivate: isPrivateAddress(n) };
}

export interface Signals {
  /** null when no deviceId was supplied */
  newDevice: boolean | null;
  /** null when no ip was supplied */
  newIp: boolean | null;
  ip: { version: 4 | 6; isPrivate: boolean } | null;
  /** Distinct phone numbers seen from this IP in the last hour, including this one */
  phonesFromIp: number | null;
  /** Distinct phone numbers seen from this device in the last 24 hours, including this one */
  phonesFromDevice: number | null;
}

const IP_WINDOW_SECONDS = 3600;
const DEVICE_WINDOW_SECONDS = 86_400;

/** Counts how many different phones one key has been used with, over a sliding expiry. */
async function velocity(redis: Redis, redisKey: string, member: string, windowSeconds: number): Promise<number> {
  const results = await redis.multi().sadd(redisKey, member).expire(redisKey, windowSeconds, "NX").scard(redisKey).exec();
  return Number(results?.[2]?.[1] ?? 0);
}

/** Read-mostly: works out the signals for an OTP request without recording a login. */
export async function computeSignals(
  prisma: PrismaClient,
  redis: Redis,
  applicationId: string,
  userId: string,
  phone: string,
  ctx: RequestContext | undefined
): Promise<Signals> {
  const signals: Signals = { newDevice: null, newIp: null, ip: null, phonesFromIp: null, phonesFromDevice: null };
  if (!ctx) return signals;
  const phoneKey = hashPhone(applicationId, phone);

  if (ctx.deviceId) {
    const deviceHash = hashDevice(applicationId, ctx.deviceId);
    signals.newDevice = !(await prisma.device.findUnique({ where: { userId_deviceHash: { userId, deviceHash } } }));
    signals.phonesFromDevice = await velocity(redis, `intel:device:${deviceHash}`, phoneKey, DEVICE_WINDOW_SECONDS);
  }
  if (ctx.ip) {
    const ipHash = hashIp(applicationId, ctx.ip);
    signals.ip = ipInfo(ctx.ip);
    signals.newIp = !(await prisma.seenIp.findUnique({ where: { userId_ipHash: { userId, ipHash } } }));
    signals.phonesFromIp = await velocity(redis, `intel:ip:${ipHash}`, phoneKey, IP_WINDOW_SECONDS);
  }
  return signals;
}

export interface LoginRecord {
  deviceId: string | null;
  isNewDevice: boolean | null;
  /** True when the user had no known device before this one */
  isFirstDevice: boolean | null;
  isNewIp: boolean | null;
  ipMasked: string | null;
  userAgent: string | null;
}

/** Called after a successful verify: remembers the device and IP, and reports what was new. */
export async function recordLogin(
  prisma: PrismaClient,
  applicationId: string,
  userId: string,
  ctx: RequestContext | undefined
): Promise<LoginRecord> {
  const record: LoginRecord = { deviceId: null, isNewDevice: null, isFirstDevice: null, isNewIp: null, ipMasked: null, userAgent: null };
  if (!ctx) return record;
  const now = new Date();
  const userAgent = ctx.userAgent?.slice(0, 200) ?? null;
  record.userAgent = userAgent;

  if (ctx.ip) {
    const ipHash = hashIp(applicationId, ctx.ip);
    record.ipMasked = maskIp(ctx.ip);
    const existing = await prisma.seenIp.findUnique({ where: { userId_ipHash: { userId, ipHash } } });
    record.isNewIp = !existing;
    await prisma.seenIp.upsert({
      where: { userId_ipHash: { userId, ipHash } },
      create: { applicationId, userId, ipHash, ipMasked: record.ipMasked },
      update: { lastSeenAt: now },
    });
  }

  if (ctx.deviceId) {
    const deviceHash = hashDevice(applicationId, ctx.deviceId);
    const knownBefore = await prisma.device.count({ where: { userId } });
    const existing = await prisma.device.findUnique({ where: { userId_deviceHash: { userId, deviceHash } } });
    record.isNewDevice = !existing;
    record.isFirstDevice = !existing && knownBefore === 0;
    const device = await prisma.device.upsert({
      where: { userId_deviceHash: { userId, deviceHash } },
      create: { applicationId, userId, deviceHash, userAgent, lastIpMasked: record.ipMasked },
      update: { lastSeenAt: now, userAgent, ...(record.ipMasked ? { lastIpMasked: record.ipMasked } : {}) },
    });
    record.deviceId = device.id;
  }
  return record;
}
