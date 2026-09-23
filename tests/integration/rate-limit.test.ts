import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app";
import { prisma } from "../../apps/server/src/lib/prisma";
import { MockProvider } from "../../apps/server/src/providers";
import { flushTestRedis, startTestWorker, waitForOutbox } from "../helpers";

const mock = new MockProvider();
const worker = startTestWorker(mock);
const app = buildApp({
  logger: false,
    limits: {
    otpRequestPerPhone: { limit: 3, windowSeconds: 600 },
    otpRequestPerIp: { limit: 6, windowSeconds: 600 },
    otpRequestPerApplication: { limit: 100, windowSeconds: 3600 },
    verifyPerPhone: { limit: 4, windowSeconds: 600 },
    verifyPerIp: { limit: 100, windowSeconds: 600 },
    refreshPerIp: { limit: 2, windowSeconds: 60 },
  },
});

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  mock.outbox.length = 0;
  await flushTestRedis();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await worker.close();
  await app.close();
});

const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });

async function createApplication() {
  const res = await post("/applications", { name: "Zomato" });
  return (res.json() as { id: string }).id;
}

describe("rate limiting and abuse protection (Phase 8)", () => {
  it("returns 429 with Retry-After when one phone spams OTP requests, and sends no more messages", async () => {
    const id = await createApplication();
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 5; i++) {
      last = await post(`/applications/${id}/otp/request`, { phone: "+919876543210" });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    expect(last!.json().error.code).toBe("RATE_LIMITED");
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    await waitForOutbox(mock, 3);
    await new Promise((r) => setTimeout(r, 200));
    expect(mock.outbox).toHaveLength(3);
  });

  it("limits one IP across many different phones", async () => {
    const id = await createApplication();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await post(`/applications/${id}/otp/request`, { phone: `+91987654321${i}` });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 202)).toHaveLength(6);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
  });

  it("limits one tenant's total sends (spending cap)", async () => {
    const capped = buildApp({
      logger: false,
            limits: { otpRequestPerApplication: { limit: 2, windowSeconds: 3600 } },
    });
    await capped.ready();
    const created = await capped.inject({ method: "POST", url: "/applications", payload: { name: "Cap" } });
    const id = (created.json() as { id: string }).id;
    const codes: number[] = [];
    for (const phone of ["+919876543210", "+919876543211", "+919876543212"]) {
      const res = await capped.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload: { phone } });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([202, 202, 429]);
    await capped.close();
  });

  it("stops brute-force guessing even when the attacker keeps requesting fresh codes", async () => {
    const id = await createApplication();
    await post(`/applications/${id}/otp/request`, { phone: "+919876543210" });
    await waitForOutbox(mock, 1);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post(`/applications/${id}/otp/verify`, { phone: "+919876543210", code: "000000" });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(4)).toEqual([429, 429]);

    // Even the correct code is refused while limited
    const correct = mock.lastCodeFor("+919876543210")!;
    const res = await post(`/applications/${id}/otp/verify`, { phone: "+919876543210", code: correct });
    expect(res.statusCode).toBe(429);
  });

  it("limits refresh attempts", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await post("/auth/refresh", { refreshToken: "x.y" })).statusCode);
    }
    expect(statuses).toEqual([401, 401, 429, 429]);
  });

  it("does not put phone numbers in Redis keys", async () => {
    const id = await createApplication();
    await post(`/applications/${id}/otp/request`, { phone: "+919876543210" });
    const { Redis } = await import("ioredis");
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys("*");
    redis.disconnect();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.join(" ")).not.toContain("9876543210");
  });
});
