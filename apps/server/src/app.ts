import Fastify, { type FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "./lib/prisma";
import { tenantUsers } from "./lib/tenant";
import { registerErrorHandler, sendError } from "./lib/errors";
import { buildProviders, type ProviderRegistry } from "./providers";
import type { Redis } from "ioredis";
import { createRedis } from "./lib/redis";
import { checkRateLimits, defaultRateLimits, type RateLimits, type Rule } from "./lib/ratelimit";
import { authenticate, createSession, refreshSession, revokeSession } from "./lib/session";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "./lib/otp";
import {
  applicationParamsSchema,
  createApplicationSchema,
  createUserSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  userParamsSchema,
} from "./lib/schemas";

export function buildApp(
  options: {
    logger?: boolean;
    providers?: ProviderRegistry;
    redis?: Redis;
    limits?: Partial<RateLimits>;
  } = {}
) {
  const redis = options.redis ?? createRedis();
  const limits: RateLimits = { ...defaultRateLimits, ...options.limits };
  const providers = options.providers ?? buildProviders();
  const app = Fastify({
    logger: (options.logger ?? true)
      ? { redact: ["req.headers.authorization", "*.phone", "*.code"] }
      : false,
  });

  registerErrorHandler(app);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
    if (!options.redis) redis.disconnect();
  });

  // Returns true (and sends a 429) if any rule is over its limit. If Redis is
  // down the error propagates, so protected routes fail closed instead of open.
  async function rateLimited(reply: FastifyReply, rules: Rule[]): Promise<boolean> {
    const result = await checkRateLimits(redis, rules);
    if (!result.limited) return false;
    reply.header("Retry-After", String(result.retryAfterSeconds));
    sendError(reply, 429, "RATE_LIMITED", "too many requests, try again later", {
      retryAfterSeconds: result.retryAfterSeconds,
    });
    return true;
  }

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
    const { phone, channel, email } = otpRequestSchema.parse(request.body);

    if (
      await rateLimited(reply, [
        { name: "otp-req-phone", subject: `${applicationId}:${phone}`, ...limits.otpRequestPerPhone },
        { name: "otp-req-ip", subject: request.ip, ...limits.otpRequestPerIp },
        { name: "otp-req-app", subject: applicationId, ...limits.otpRequestPerApplication },
      ])
    ) {
      return reply;
    }

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

    // Deliver the code through the chosen provider. It must never be logged.
    await providers[channel].send({ channel, to: channel === "email" ? email! : phone, code });

    return reply.status(202).send({ status: "otp_request_accepted", userId: user.id });
  });

  app.post("/applications/:applicationId/otp/verify", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    const { phone, code } = otpVerifySchema.parse(request.body);

    if (
      await rateLimited(reply, [
        { name: "verify-phone", subject: `${applicationId}:${phone}`, ...limits.verifyPerPhone },
        { name: "verify-ip", subject: request.ip, ...limits.verifyPerIp },
      ])
    ) {
      return reply;
    }

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

    const tokens = await createSession(prisma, applicationId, user.id);
    return reply.status(200).send({ status: "verified", userId: user.id, ...tokens });
  });

  // ---------- Sessions ----------
  app.post("/auth/refresh", async (request, reply) => {
    const { refreshToken } = refreshSchema.parse(request.body);
    if (await rateLimited(reply, [{ name: "refresh-ip", subject: request.ip, ...limits.refreshPerIp }])) {
      return reply;
    }
    const tokens = await refreshSession(prisma, refreshToken);
    if (!tokens) {
      return sendError(reply, 401, "INVALID_REFRESH_TOKEN", "refresh token is invalid or expired");
    }
    return tokens;
  });

  app.get("/auth/me", async (request, reply) => {
    const auth = await authenticate(prisma, request.headers.authorization);
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "missing, invalid or revoked token");
    return { userId: auth.userId, applicationId: auth.applicationId, sessionId: auth.sessionId };
  });

  app.post("/auth/logout", async (request, reply) => {
    const auth = await authenticate(prisma, request.headers.authorization);
    if (!auth) return sendError(reply, 401, "UNAUTHORIZED", "missing, invalid or revoked token");
    await revokeSession(prisma, auth.sessionId);
    return reply.status(204).send();
  });

  return app;
}
