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

function createUser(applicationId: string, phone: unknown) {
  return app.inject({
    method: "POST",
    url: `/applications/${applicationId}/users`,
    payload: { phone },
  });
}

describe("input validation", () => {
  it("rejects an application without a name", async () => {
    const res = await app.inject({ method: "POST", url: "/applications", payload: {} });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details[0].field).toBe("name");
  });

  it("rejects an invalid phone number", async () => {
    const zomato = await createApplication("Zomato");

    const res = await createUser(zomato.id, "12345");

    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].field).toBe("phone");
  });

  it("rejects a missing phone", async () => {
    const zomato = await createApplication("Zomato");

    const res = await createUser(zomato.id, undefined);

    expect(res.statusCode).toBe(400);
  });

  it("treats different formats of one number as the same user", async () => {
    const zomato = await createApplication("Zomato");

    const first = await createUser(zomato.id, "+91 98765 43210");
    const second = await createUser(zomato.id, "9876543210");

    expect(first.statusCode).toBe(201);
    expect(first.json().phone).toBe("+919876543210");
    expect(second.statusCode).toBe(409);
  });

  it("rejects an application id that is not a valid id", async () => {
    const res = await createUser("not-a-uuid", "+919876543210");

    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an application that does not exist", async () => {
    const res = await createUser("00000000-0000-4000-8000-000000000000", "+919876543210");

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("APPLICATION_NOT_FOUND");
  });
});
