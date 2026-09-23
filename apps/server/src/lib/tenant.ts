import type { PrismaClient } from "@prisma/client";

// Every user query goes through here, so applicationId can never be forgotten.
export function tenantUsers(prisma: PrismaClient, applicationId: string) {
  return {
    create: (phone: string) => prisma.user.create({ data: { applicationId, phone } }),
    // Atomic, so two simultaneous first requests for one phone cannot collide on the unique index
    findOrCreate: (phone: string) =>
      prisma.user.upsert({
        where: { applicationId_phone: { applicationId, phone } },
        create: { applicationId, phone },
        update: {},
      }),
    list: () => prisma.user.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" } }),
    findById: (id: string) => prisma.user.findFirst({ where: { id, applicationId } }),
  };
}
