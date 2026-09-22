import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "./lib/prisma";
import { tenantUsers } from "./lib/tenant";
import { registerErrorHandler, sendError } from "./lib/errors";
import {
  applicationParamsSchema,
  createApplicationSchema,
  createUserSchema,
  otpRequestSchema,
  otpVerifySchema,
  userParamsSchema,
} from "./lib/schemas";

export function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? true });

  registerErrorHandler(app);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  app.get("/health", async () => ({ status: "ok", service: "otplease-server" }));

  // ---------- Applications (tenants) ----------
  app.post("/applications", async (request, reply) => {
    const { name } = createApplicationSchema.parse(request.body);
    const application = await prisma.application.create({ data: { name } });
    return reply.status(201).send(application);
  });

  app.get("/applications", async () => {
    return prisma.application.findMany({ orderBy: { createdAt: "desc" } });
  });

  // ---------- Users (always inside one application) ----------
  app.post("/applications/:applicationId/users", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    const { phone } = createUserSchema.parse(request.body);

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) {
      return sendError(reply, 404, "APPLICATION_NOT_FOUND", "application not found");
    }

    try {
      const user = await tenantUsers(prisma, applicationId).create(phone);
      return reply.status(201).send(user);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return sendError(
          reply,
          409,
          "USER_ALREADY_EXISTS",
          "user with this phone already exists in this application"
        );
      }
      throw err;
    }
  });

  app.get("/applications/:applicationId/users", async (request) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    return tenantUsers(prisma, applicationId).list();
  });

  app.get("/applications/:applicationId/users/:userId", async (request, reply) => {
    const { applicationId, userId } = userParamsSchema.parse(request.params);
    const user = await tenantUsers(prisma, applicationId).findById(userId);
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "user not found");
    }
    return user;
  });

  // ---------- OTP (shape only for now — real logic in Phase 5) ----------
  app.post("/applications/:applicationId/otp/request", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    const { phone } = otpRequestSchema.parse(request.body);

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) {
      return sendError(reply, 404, "APPLICATION_NOT_FOUND", "application not found");
    }

    const users = tenantUsers(prisma, applicationId);
    const existing = await prisma.user.findFirst({ where: { applicationId, phone } });
    const user = existing ?? (await users.create(phone));

    return reply.status(202).send({ status: "otp_request_accepted", userId: user.id });
  });

  app.post("/applications/:applicationId/otp/verify", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    const { phone } = otpVerifySchema.parse(request.body);

    const user = await prisma.user.findFirst({ where: { applicationId, phone } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "user not found");
    }

    return sendError(reply, 501, "NOT_IMPLEMENTED", "OTP verification is not implemented yet");
  });

  return app;
}
