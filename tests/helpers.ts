import { Redis } from "ioredis";

/** Flushes Redis, but only ever the dedicated test database (/1). */
export async function flushTestRedis(): Promise<void> {
  const url = process.env.REDIS_URL ?? "";
  if (!url.endsWith("/1")) {
    throw new Error("Refusing to flush: REDIS_URL is not the test Redis database (/1)");
  }
  const redis = new Redis(url);
  await redis.flushdb();
  redis.disconnect();
}
