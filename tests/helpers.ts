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

import { createOtpWorker } from "../apps/worker/src/otp-worker";
import type { MockProvider } from "../apps/server/src/providers";

/** Starts the real worker, wired to the mock provider so no real message is ever sent. */
export function startTestWorker(mock: MockProvider) {
  return createOtpWorker({ sms: mock, email: mock });
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const waitForOutbox = (mock: MockProvider, count: number) =>
  waitFor(() => mock.outbox.length >= count);
