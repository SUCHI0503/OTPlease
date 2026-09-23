import { Prisma, type PrismaClient } from "@prisma/client";

// Every user query goes through here, so applicationId can never be forgotten.
export function tenantUsers(prisma: PrismaClient, applicationId: string) {
  return {
    create: (phone: string) => prisma.user.create({ data: { applicationId, phone } }),
    // Prisma's upsert can still hit the unique index when two requests race, so a lost
    // race is handled explicitly: if the create collides, the other request's row is used.
    findOrCreate: async (phone: string) => {
      const where = { applicationId_phone: { applicationId, phone } };
      const existing = await prisma.user.findUnique({ where });
      if (existing) return existing;
      try {
        return await prisma.user.create({ data: { applicationId, phone } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return prisma.user.findUniqueOrThrow({ where });
        }
        throw err;
      }
    },
    list: () => prisma.user.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" } }),
    findById: (id: string) => prisma.user.findFirst({ where: { id, applicationId } }),
  };
}
