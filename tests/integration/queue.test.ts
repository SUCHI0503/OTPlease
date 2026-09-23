import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { prisma } from "../../apps/server/src/lib/prisma";
import { MockProvider } from "../../apps/server/src/providers";
import type { OtpMessage } from "../../apps/server/src/providers";
import { createOtpWorker } from "../../apps/worker/src/otp-worker";
import { flushTestRedis, waitFor, buildTestApp } from "../helpers";

const PHONE = "+919876543210";
const app = buildTestApp({ logger: false });

// A provider that is slow, and can be told to fail a number of times first
class SlowFlakyProvider extends MockProvider {
  failuresLeft = 0;
  calls = 0;
  override async send(message: OtpMessage) {
    this.calls++;
    await new Promise((r) => setTimeout(r, 300));
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("provider down");
    }
    return super.send(message);
  }
}

const provider = new SlowFlakyProvider();
const worker = createOtpWorker({ sms: provider, whatsapp: provider, voice: provider, email: provider });

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
  provider.outbox.length = 0;
  provider.failuresLeft = 0;
  provider.calls = 0;
  await prisma.apiKey.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await worker.close();
  await app.close();
});

async function requestOtp() {
  const created = await app.inject({ method: "POST", url: "/applications", payload: { name: "Zomato" } });
  const id = (created.json() as { id: string }).id;
  const started = Date.now();
  const res = await app.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload: { phone: PHONE } });
  return { id, res, elapsed: Date.now() - started };
}

describe("queue and worker (Phase 9)", () => {
  it("replies immediately; the worker sends the message afterwards", async () => {
    const { res, elapsed } = await requestOtp();
    expect(res.statusCode).toBe(202);
    expect(elapsed).toBeLessThan(300); // the provider alone takes 300ms
    expect(provider.outbox).toHaveLength(0);

    await waitFor(() => provider.outbox.length === 1);
    expect(provider.outbox[0]).toMatchObject({ channel: "sms", to: PHONE });
  });

  it("retries when the provider fails, then delivers", async () => {
    provider.failuresLeft = 1;
    await requestOtp();
    await waitFor(() => provider.outbox.length === 1, 8000);
    expect(provider.calls).toBe(2);
  });

  it("never stores the plaintext code in Redis job data", async () => {
    provider.failuresLeft = 99; // keep the job in Redis
    await requestOtp();
    await waitFor(() => provider.calls >= 1);

    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys("bull:otp-send:*");
    const dump: string[] = [];
    for (const key of keys) {
      const type = await redis.type(key);
      if (type === "hash") dump.push(JSON.stringify(await redis.hgetall(key)));
    }
    redis.disconnect();

    const joined = dump.join(" ");
    expect(joined).toContain("codeEnc");
    // The code is the OTP saved (hashed) in the DB; find it by trying all hashes is not possible,
    // so check the job data has no 6-digit "code" field at all.
    expect(joined).not.toMatch(/\\"code\\":\\"\d{6}\\"/);
  });
});
