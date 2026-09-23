import { Redis } from "ioredis";
import { createOtpWorker } from "../apps/worker/src/otp-worker";
import type { MockProvider } from "../apps/server/src/providers";
import { buildApp } from "../apps/server/src/app";
import { prisma } from "../apps/server/src/lib/prisma";
import { SCOPES, issueApiKey } from "../apps/server/src/lib/apikeys";

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

/** Starts the real worker, wired to the mock provider so no real message is ever sent. */
export function startTestWorker(mock: MockProvider) {
  return createOtpWorker({ sms: mock, whatsapp: mock, voice: mock, email: mock });
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

export const ADMIN_TOKEN = process.env.ADMIN_TOKEN!;

/**
 * Builds the app and makes app.inject authenticate automatically, so tests about
 * OTPs, sessions and so on need not repeat auth setup: platform routes get the admin
 * token, and /applications/:id/... routes get a full-scope key for that application.
 * A test that sets x-api-key or x-admin-token itself (or x-test-no-auth) is left alone.
 */
export function buildTestApp(options: Parameters<typeof buildApp>[0] = { logger: false }) {
  const app = buildApp({ logger: false, ...options });
  const original = app.inject.bind(app) as (opts: any) => Promise<any>;
  const keys = new Map<string, string>();

  (app as any).inject = async (opts: any) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (headers["x-test-no-auth"]) {
      delete headers["x-test-no-auth"];
    } else if (!headers["x-api-key"] && !headers["x-admin-token"]) {
      const id = String(opts.url).match(/^\/applications\/([0-9a-f-]{36})/)?.[1];
      if (id) {
        if (!keys.has(id)) {
          const issued = await issueApiKey(prisma, id, "test", [...SCOPES]).catch(() => null);
          if (issued) keys.set(id, issued.key);
        }
        if (keys.has(id)) headers["x-api-key"] = keys.get(id)!;
      } else if (String(opts.url).startsWith("/applications")) {
        headers["x-admin-token"] = ADMIN_TOKEN;
      }
    }
    return original({ ...opts, headers });
  };
  return app;
}
