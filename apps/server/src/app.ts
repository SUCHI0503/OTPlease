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
  const app = Fastify({
    logger: (options.logger ?? true)
      ? { redact: ["req.headers.authorization", "*.phone", "*.code"] }
      : false,
  });

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

    // One active code per user: consume any older unused codes, then issue the new one.
    await prisma.$transaction([
      prisma.otpCode.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      prisma.otpCode.create({
        data: {
          applicationId,
          userId: user.id,
          codeHash,
          expiresAt,
          maxAttempts: OTP_MAX_ATTEMPTS,
        },
      }),
    ]);

    // TODO(Phase 6): hand `code` to the mock/email provider. It must never be logged.

    return reply.status(202).send({ status: "otp_request_accepted", userId: user.id });
  });

  app.post("/applications/:applicationId/otp/verify", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    const { phone, code } = otpVerifySchema.parse(request.body);

    // Unknown phone and "no active code" return the same error, so callers
    // cannot probe which phone numbers are registered.
    const user = await prisma.user.findFirst({ where: { applicationId, phone } });
    const otp = user
      ? await prisma.otpCode.findFirst({
          where: { userId: user.id, consumedAt: null },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (!user || !otp) {
      return sendError(reply, 400, "OTP_NOT_FOUND", "no active otp for this user");
    }

    if (otp.expiresAt < new Date()) {
      return sendError(reply, 400, "OTP_EXPIRED", "otp has expired");
    }

    // Atomically claim an attempt before comparing. Parallel guesses cannot
    // exceed maxAttempts because the increment only succeeds while attempts < maxAttempts.
    const claimed = await prisma.otpCode.updateMany({
      where: { id: otp.id, consumedAt: null, attempts: { lt: otp.maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      return sendError(reply, 429, "OTP_LOCKED", "too many incorrect attempts");
    }

    if (!verifyOtpCode(code, otp.codeHash)) {
      return sendError(reply, 400, "OTP_INCORRECT", "incorrect code");
    }

    // Single use: only one concurrent request can flip consumedAt from null.
    const consumed = await prisma.otpCode.updateMany({
      where: { id: otp.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      return sendError(reply, 400, "OTP_NOT_FOUND", "no active otp for this user");
    }

    return reply.status(200).send({ status: "verified", userId: user.id });
  });

  return app;
}
