import { describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { tenantUsers } from "../../../apps/server/src/lib/tenant";

const APP = "app-1";
const PHONE = "+919876543210";
const user = { id: "u1", applicationId: APP, phone: PHONE, createdAt: new Date() };
const conflict = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });

/** A stand-in for the parts of Prisma this module touches, recording what it was asked to do. */
function fakePrisma(handlers: { findUnique?: () => unknown; create?: () => unknown; findUniqueOrThrow?: () => unknown }) {
  const calls: string[] = [];
  const wrap = (name: string, fn?: () => unknown) => async (args: unknown) => {
    calls.push(name);
    if (!fn) throw new Error(`unexpected call to ${name}`);
    return fn.call(args);
  };
  const prisma = {
    user: {
      findUnique: wrap("findUnique", handlers.findUnique),
      create: wrap("create", handlers.create),
      findUniqueOrThrow: wrap("findUniqueOrThrow", handlers.findUniqueOrThrow),
    },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

describe("tenantUsers.findOrCreate", () => {
  it("returns an existing user without creating anything", async () => {
    const { prisma, calls } = fakePrisma({ findUnique: () => user });
    expect(await tenantUsers(prisma, APP).findOrCreate(PHONE)).toBe(user);
    expect(calls).toEqual(["findUnique"]);
  });

  it("creates the user when none exists", async () => {
    const { prisma, calls } = fakePrisma({ findUnique: () => null, create: () => user });
    expect(await tenantUsers(prisma, APP).findOrCreate(PHONE)).toBe(user);
    expect(calls).toEqual(["findUnique", "create"]);
  });

  it("when a concurrent request creates the same user first, uses that row instead of failing", async () => {
    // Exactly the race that once caused a 500: the lookup found nothing, then the create collided
    const { prisma, calls } = fakePrisma({
      findUnique: () => null,
      create: () => { throw conflict(); },
      findUniqueOrThrow: () => user,
    });
    expect(await tenantUsers(prisma, APP).findOrCreate(PHONE)).toBe(user);
    expect(calls).toEqual(["findUnique", "create", "findUniqueOrThrow"]);
  });

  it("does not hide other database errors", async () => {
    const boom = new Error("connection lost");
    const { prisma } = fakePrisma({ findUnique: () => null, create: () => { throw boom; } });
    await expect(tenantUsers(prisma, APP).findOrCreate(PHONE)).rejects.toBe(boom);

    const other = new Prisma.PrismaClientKnownRequestError("Foreign key failed", { code: "P2003", clientVersion: "test" });
    const { prisma: p2 } = fakePrisma({ findUnique: () => null, create: () => { throw other; } });
    await expect(tenantUsers(p2, APP).findOrCreate(PHONE)).rejects.toBe(other);
  });

  it("always looks users up inside the given application", async () => {
    let seen: unknown;
    const prisma = { user: { findUnique: async (a: unknown) => ((seen = a), user) } } as unknown as PrismaClient;
    await tenantUsers(prisma, "tenant-42").findOrCreate(PHONE);
    expect(seen).toEqual({ where: { applicationId_phone: { applicationId: "tenant-42", phone: PHONE } } });
  });
});
