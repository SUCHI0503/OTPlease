import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../apps/server/src/lib/prisma";
import { buildTestApp, flushTestRedis } from "../helpers";

const app = buildTestApp();

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
  await prisma.apiKey.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.device.deleteMany();
  await prisma.seenIp.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await app.close();
});

describe("concurrent requests for a brand-new phone", () => {
  it("creates exactly one user and never errors", async () => {
    const created = await app.inject({ method: "POST", url: "/applications", payload: { name: "Zomato" } });
    const id = (created.json() as { id: string }).id;

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload: { phone: "+919876543210" } })
      )
    );

    // Rate limit allows 3 per phone; none may be a 500
    expect(results.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    expect(await prisma.user.count()).toBe(1);
    // and only one code stays active
    expect(await prisma.otpCode.count({ where: { consumedAt: null } })).toBe(1);
  });
});
