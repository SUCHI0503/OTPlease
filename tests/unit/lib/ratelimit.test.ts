import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { checkRateLimits, peekRateLimit, type Rule } from "../../../apps/server/src/lib/ratelimit";
import { flushTestRedis } from "../../helpers";

const redis = new Redis(process.env.REDIS_URL!);
const rule = (over: Partial<Rule> = {}): Rule => ({ name: "t", subject: "alice", limit: 3, windowSeconds: 60, ...over });

beforeEach(async () => {
  await flushTestRedis();
});
afterAll(() => {
  redis.disconnect();
});

const hit = (rules: Rule[]) => checkRateLimits(redis, rules);

describe("checkRateLimits", () => {
  it("allows exactly `limit` hits, then limits", async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await hit([rule()])).limited);
    expect(results).toEqual([false, false, false, true, true]);
  });

  it("reports how long until the window ends", async () => {
    for (let i = 0; i < 4; i++) await hit([rule({ windowSeconds: 60 })]);
    const { limited, retryAfterSeconds } = await hit([rule({ windowSeconds: 60 })]);
    expect(limited).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("starts the window on the first hit and does not extend it on later hits", async () => {
    const r = rule({ windowSeconds: 30, limit: 100 });
    await hit([r]);
    const first = (await peekRateLimit(redis, r)).ttl;
    await new Promise((res) => setTimeout(res, 1100));
    for (let i = 0; i < 5; i++) await hit([r]); // hammering must not push the expiry out
    const later = (await peekRateLimit(redis, r)).ttl;
    expect(later).toBeLessThan(first);
  });

  it("forgets everything when the window ends", async () => {
    const r = rule({ windowSeconds: 1, limit: 1 });
    await hit([r]);
    expect((await hit([r])).limited).toBe(true);
    await new Promise((res) => setTimeout(res, 1200));
    expect((await hit([r])).limited).toBe(false);
  });

  it("counts different subjects and different rule names separately", async () => {
    for (let i = 0; i < 4; i++) await hit([rule({ subject: "alice" })]);
    expect((await hit([rule({ subject: "alice" })])).limited).toBe(true);
    expect((await hit([rule({ subject: "bob" })])).limited).toBe(false);
    expect((await hit([rule({ subject: "alice", name: "other" })])).limited).toBe(false);
  });

  it("with several rules, is limited if any one is over, and reports the longest wait", async () => {
    const short = rule({ name: "short", limit: 1, windowSeconds: 10 });
    const long = rule({ name: "long", limit: 1, windowSeconds: 100 });
    await hit([short, long]);
    const { limited, retryAfterSeconds } = await hit([short, long]);
    expect(limited).toBe(true);
    expect(retryAfterSeconds).toBeGreaterThan(10);
  });

  it("is atomic: 60 simultaneous hits against a limit of 10 let exactly 10 through", async () => {
    const results = await Promise.all(Array.from({ length: 60 }, () => hit([rule({ limit: 10 })])));
    expect(results.filter((r) => !r.limited)).toHaveLength(10);
  });

  it("stores only a hash of the subject, never a phone number or IP", async () => {
    await hit([rule({ subject: "+919876543210" }), rule({ name: "ip", subject: "203.0.113.5" })]);
    const keys = await redis.keys("rl:*");
    expect(keys).toHaveLength(2);
    for (const k of keys) {
      expect(k).not.toContain("9876543210");
      expect(k).not.toContain("203.0.113");
    }
  });

  it("always sets an expiry, so counters cannot pile up forever", async () => {
    await hit([rule()]);
    const [key] = await redis.keys("rl:*");
    expect(await redis.ttl(key!)).toBeGreaterThan(0);
  });
});

describe("peekRateLimit", () => {
  it("reads the count without counting a hit", async () => {
    await hit([rule()]);
    await hit([rule()]);
    for (let i = 0; i < 5; i++) await peekRateLimit(redis, rule());
    expect((await peekRateLimit(redis, rule())).count).toBe(2);
    expect((await hit([rule()])).limited).toBe(false); // the third hit is still allowed
  });

  it("reports zero for something never seen", async () => {
    expect((await peekRateLimit(redis, rule({ subject: "nobody" }))).count).toBe(0);
  });
});
