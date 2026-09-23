import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app";
import { prisma } from "../../apps/server/src/lib/prisma";

const app = buildApp({ logger: false });

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await prisma.session.deleteMany();
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

describe("otp routes (shape only, Phase 4)", () => {
  it("accepts a valid otp request and creates the user if new", async () => {
    const zomato = await createApplication("Zomato");

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/request`,
      payload: { phone: "+919876543210" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("otp_request_accepted");
  });

  it("rejects an otp request with an invalid phone", async () => {
    const zomato = await createApplication("Zomato");

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/request`,
      payload: { phone: "12345" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an otp verify with a non-6-digit code", async () => {
    const zomato = await createApplication("Zomato");

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: "+919876543210", code: "12" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns the generic otp-not-found error when the user does not exist", async () => {
    const zomato = await createApplication("Zomato");

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: "+919876543210", code: "123456" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OTP_NOT_FOUND");
  });

  it("rejects verify with a wrong code when the user exists", async () => {
    const zomato = await createApplication("Zomato");
    await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/request`,
      payload: { phone: "+919876543210" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/applications/${zomato.id}/otp/verify`,
      payload: { phone: "+919876543210", code: "000000" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OTP_INCORRECT");
  });
});