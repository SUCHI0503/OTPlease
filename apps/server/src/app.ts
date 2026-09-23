import Fastify from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "./lib/prisma";
import { tenantUsers } from "./lib/tenant";
import { registerErrorHandler, sendError } from "./lib/errors";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "./lib/otp";
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

  // ---------- OTP ----------
  const OTP_EXPIRY_MINUTES = 5;
  const OTP_MAX_ATTEMPTS = 5;

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

    const code = generateOtpCode();
    const codeHash = hashOtpCode(code);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await prisma.otpCode.create({
      data: {
        applicationId,
        userId: user.id,
        codeHash,
        expiresAt,
        maxAttempts: OTP_MAX_ATTEMPTS,
      },
    });

    // No real provider until Phase 6 — log the plain code so you can test locally.
    // Never log this in production; Phase 16 hardening will strip this.
    app.log.info({ userId: user.id, code }, "OTP code generated (dev only)");

    return reply.status(202).send({ status: "otp_request_accepted", userId: user.id });
  });

  app.post("/applications/:applicationId/otp/verify", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    const { phone, code } = otpVerifySchema.parse(request.body);

    const user = await prisma.user.findFirst({ where: { applicationId, phone } });
    if (!user) {
      return sendError(reply, 404, "USER_NOT_FOUND", "user not found");
    }

    const otp = await prisma.otpCode.findFirst({
      where: { userId: user.id, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });

    if (!otp) {
      return sendError(reply, 400, "OTP_NOT_FOUND", "no active otp for this user");
    }

    if (otp.expiresAt < new Date()) {
      return sendError(reply, 400, "OTP_EXPIRED", "otp has expired");
    }

    if (otp.attempts >= otp.maxAttempts) {
      return sendError(reply, 429, "OTP_LOCKED", "too many incorrect attempts");
    }

    const isValid = verifyOtpCode(code, otp.codeHash);

    if (!isValid) {
      await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      return sendError(reply, 400, "OTP_INCORRECT", "incorrect code");
    }

    await prisma.otpCode.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });

    return reply.status(200).send({ status: "verified", userId: user.id });
  });

  return app;
}
