import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app";
import { prisma } from "../../apps/server/src/lib/prisma";
import { hashOtpCode } from "../../apps/server/src/lib/otp";

const app = buildApp({ logger: false });

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await app.close();
});

async function createApplication(name: string) {
  const res = await app.inject({ method: "POST", url: "/applications", payload: { name } });
  return res.json() as { id: string };
}

async function createUser(applicationId: string, phone: string) {
  const res = await app.inject({
    method: "POST",
    url: `/applications/${applicationId}/users`,
    payload: { phone },
  });
  return res.json() as { id: string };
}

async function seedOtp(
  applicationId: string,
  userId: string,
  code: string,
  overrides: Partial<{ expiresAt: Date; attempts: number; maxAttempts: number; consumedAt: Date | null }> = {}
) {
  return prisma.otpCode.create({
    data: {
      applicationId,
      userId,
      codeHash: hashOtpCode(code),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
      attempts: overrides.attempts ?? 0,
      maxAttempts: overrides.maxAttempts ?? 5,
      consumedAt: overrides.consumedAt ?? null,
    },
  });
}

const PHONE = "+919876543210";

describe("otp verify — real logic (Phase 5)", () => {
  it("verifies successfully with the correct, unexpired code", async () => {
    const zomato = await createApplication("Zomato");
    const user = await createUser(zomato.id, PHONE);
    await seedOtp(zomato.id, user.id, "111111");

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: PHONE, code: "111111" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("verified");
  });

  it("rejects an expired code", async () => {
    const zomato = await createApplication("Zomato");
    const user = await createUser(zomato.id, PHONE);
    await seedOtp(zomato.id, user.id, "222222", {
      expiresAt: new Date(Date.now() - 60 * 1000), // 1 minute in the past
    });

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: PHONE, code: "222222" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OTP_EXPIRED");
  });

  it("rejects a wrong code and increments the attempt count", async () => {
    const zomato = await createApplication("Zomato");
    const user = await createUser(zomato.id, PHONE);
    const otp = await seedOtp(zomato.id, user.id, "333333");

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: PHONE, code: "999999" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OTP_INCORRECT");

    const updated = await prisma.otpCode.findUnique({ where: { id: otp.id } });
    expect(updated?.attempts).toBe(1);
  });

  it("locks the code after max attempts are reached", async () => {
    const zomato = await createApplication("Zomato");
    const user = await createUser(zomato.id, PHONE);
    await seedOtp(zomato.id, user.id, "444444", { attempts: 5, maxAttempts: 5 });

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: PHONE, code: "444444" },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("OTP_LOCKED");
  });

  it("rejects reuse of an already-consumed code", async () => {
    const zomato = await createApplication("Zomato");
    const user = await createUser(zomato.id, PHONE);
    await seedOtp(zomato.id, user.id, "555555", { consumedAt: new Date() });

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: PHONE, code: "555555" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OTP_NOT_FOUND");
  });
});
