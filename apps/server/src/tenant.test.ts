import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { prisma } from "./lib/prisma";

const app = buildApp({ logger: false });

beforeAll(async () => {
  // Safety: never run (and delete data) against the dev database
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
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

function createUser(applicationId: string, phone: string) {
  return app.inject({
    method: "POST",
    url: `/applications/${applicationId}/users`,
    payload: { phone },
  });
}

describe("tenant isolation", () => {
  it("allows the same phone number in two different applications", async () => {
    const zomato = await createApplication("Zomato");
    const swiggy = await createApplication("Swiggy");

    expect((await createUser(zomato.id, "+919876543210")).statusCode).toBe(201);
    expect((await createUser(swiggy.id, "+919876543210")).statusCode).toBe(201);
  });

  it("rejects a duplicate phone inside the same application", async () => {
    const zomato = await createApplication("Zomato");

    await createUser(zomato.id, "+919876543210");
    const second = await createUser(zomato.id, "+919876543210");

    expect(second.statusCode).toBe(409);
  });

  it("does not let tenant B read tenant A's user by id", async () => {
    const zomato = await createApplication("Zomato");
    const swiggy = await createApplication("Swiggy");
    const zomatoUser = (await createUser(zomato.id, "+919876543210")).json() as { id: string };

    const res = await app.inject({
      method: "GET",
      url: `/applications/${swiggy.id}/users/${zomatoUser.id}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it("does not show tenant A's users in tenant B's list", async () => {
    const zomato = await createApplication("Zomato");
    const swiggy = await createApplication("Swiggy");
    await createUser(zomato.id, "+919876543210");

    const res = await app.inject({ method: "GET", url: `/applications/${swiggy.id}/users` });

    expect(res.json()).toEqual([]);
  });
});
