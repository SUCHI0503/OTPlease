import crypto from "node:crypto";
import type { Redis } from "ioredis";

export interface Rule {
  /** Short name, part of the Redis key */
  name: string;
  /** Who is being limited: an IP, a phone, an application id... */
  subject: string;
  limit: number;
  windowSeconds: number;
}

export interface LimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

export interface RateLimits {
  otpRequestPerPhone: { limit: number; windowSeconds: number };
  otpRequestPerIp: { limit: number; windowSeconds: number };
  otpRequestPerCountry: { limit: number; windowSeconds: number };
  otpRequestPerApplication: { limit: number; windowSeconds: number };
  verifyPerPhone: { limit: number; windowSeconds: number };
  verifyPerIp: { limit: number; windowSeconds: number };
  refreshPerIp: { limit: number; windowSeconds: number };
  /** Failed API-key / admin-token attempts per IP, before that IP is locked out */
  authFailuresPerIp: { limit: number; windowSeconds: number };
}

/** Every limit that can be tuned, in one place (also used to validate RATE_LIMITS_JSON) */
export const RATE_LIMIT_NAMES = [
  "otpRequestPerPhone",
  "otpRequestPerIp",
  "otpRequestPerCountry",
  "otpRequestPerApplication",
  "verifyPerPhone",
  "verifyPerIp",
  "refreshPerIp",
  "authFailuresPerIp",
] as const satisfies readonly (keyof RateLimits)[];

export const defaultRateLimits: RateLimits = {
  // Also the cost guard against SMS pumping: few sends per phone, a hard cap per tenant
  otpRequestPerPhone: { limit: 3, windowSeconds: 600 },
  otpRequestPerIp: { limit: 20, windowSeconds: 600 },
  // Caps sends into any one country (a common SMS-pumping target) across all tenants
  otpRequestPerCountry: { limit: 500, windowSeconds: 3600 },
  otpRequestPerApplication: { limit: 1000, windowSeconds: 3600 },
  // Brute-force guard. Requesting a fresh OTP resets the per-code attempts,
  // so this per-phone cap is what really stops code guessing.
  verifyPerPhone: { limit: 10, windowSeconds: 600 },
  verifyPerIp: { limit: 30, windowSeconds: 600 },
  refreshPerIp: { limit: 30, windowSeconds: 60 },
  authFailuresPerIp: { limit: 20, windowSeconds: 600 },
};

// Atomic fixed-window counter: INCR, start the window on the first hit, return count and TTL.
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('TTL', KEYS[1])}
`;

// Subjects can be phone numbers, so they are hashed before they reach Redis keys.
const keyFor = (rule: Rule) =>
  `rl:${rule.name}:${crypto.createHash("sha256").update(rule.subject).digest("hex").slice(0, 32)}`;

/**
 * Counts one hit against every rule. Limited if any rule is over its limit. All rules are sent to Redis together
 * (one round trip, not one per rule) and every rule is still counted on every call, exactly as before.
 */
export async function checkRateLimits(redis: Redis, rules: Rule[]): Promise<LimitResult> {
  const pipeline = redis.pipeline();
  for (const rule of rules) pipeline.eval(SCRIPT, 1, keyFor(rule), rule.windowSeconds);
  const replies = (await pipeline.exec()) ?? [];

  let retryAfterSeconds = 0;
  replies.forEach(([error, reply], i) => {
    // A Redis failure must not let a request through: the error propagates and protected routes fail closed
    if (error) throw error;
    const [count, ttl] = reply as [number, number];
    const rule = rules[i]!;
    if (count > rule.limit) retryAfterSeconds = Math.max(retryAfterSeconds, ttl > 0 ? ttl : rule.windowSeconds);
  });
  return { limited: retryAfterSeconds > 0, retryAfterSeconds };
}

/** Just the current count (one Redis command), for the common case where nothing is limited. */
export async function peekCount(redis: Redis, rule: Rule): Promise<number> {
  return Number((await redis.get(keyFor(rule))) ?? 0);
}

/** Reads a counter without counting a hit. Returns the count and seconds left in the window. */
export async function peekRateLimit(redis: Redis, rule: Rule): Promise<{ count: number; ttl: number }> {
  const key = keyFor(rule);
  const [count, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
  return { count: Number(count ?? 0), ttl: ttl > 0 ? ttl : rule.windowSeconds };
}
