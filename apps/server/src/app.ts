import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "./lib/prisma";
import { tenantUsers } from "./lib/tenant";

type AppParams = { applicationId: string };
type UserParams = { applicationId: string; userId: string };

export function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  app.get("/health", async () => ({ status: "ok", service: "otplease-server" }));

  // ---------- Applications (tenants) ----------
  app.post("/applications", async (request, reply) => {
    const body = request.body as { name?: unknown };
    if (typeof body?.name !== "string" || body.name.trim() === "") {
      return reply.status(400).send({ error: "name is required" });
    }
    const application = await prisma.application.create({ data: { name: body.name.trim() } });
    return reply.status(201).send(application);
  });

  app.get("/applications", async () => {
    return prisma.application.findMany({ orderBy: { createdAt: "desc" } });
  });

  // ---------- Users (always inside one application) ----------
  app.post<{ Params: AppParams }>("/applications/:applicationId/users", async (request, reply) => {
    const { applicationId } = request.params;
    const body = request.body as { phone?: unknown };
    if (typeof body?.phone !== "string" || body.phone.trim() === "") {
      return reply.status(400).send({ error: "phone is required" });
    }

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) {
      return reply.status(404).send({ error: "application not found" });
    }

    try {
      const user = await tenantUsers(prisma, applicationId).create(body.phone.trim());
      return reply.status(201).send(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.status(409).send({ error: "user with this phone already exists in this application" });
      }
      throw err;
    }
  });

  app.get<{ Params: AppParams }>("/applications/:applicationId/users", async (request) => {
    return tenantUsers(prisma, request.params.applicationId).list();
  });

  app.get<{ Params: UserParams }>("/applications/:applicationId/users/:userId", async (request, reply) => {
    const { applicationId, userId } = request.params;
    const user = await tenantUsers(prisma, applicationId).findById(userId);
    if (!user) {
      return reply.status(404).send({ error: "user not found" });
    }
    return user;
  });

  return app;
}
