import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "./lib/prisma";
import { tenantUsers } from "./lib/tenant";
import { env } from "./lib/env";
import { registerErrorHandler, sendError } from "./lib/errors";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { maskRecipient } from "./lib/mask";
import { isValidTwilioSignature } from "./providers/twilio";
import { isAdminToken, issueApiKey, verifyApiKey, type Scope } from "./lib/apikeys";
import { createOtpQueue, enqueueOtp } from "./queue/otp-queue";
import type { Redis } from "ioredis";
import { createRedis } from "./lib/redis";
import { checkRateLimits, defaultRateLimits, type RateLimits, type Rule } from "./lib/ratelimit";
import { authenticate, createSession, refreshSession, revokeSession } from "./lib/session";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "./lib/otp";
import {
  applicationParamsSchema,
  deliveryParamsSchema,
  apiKeyParamsSchema,
  createApiKeySchema,
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
    redis?: Redis;
    limits?: Partial<RateLimits>;
    queue?: { attempts?: number; backoffMs?: number };
    /** Set false when several apps share the process (tests), so closing one does not disconnect the shared Prisma client */
    disconnectPrisma?: boolean;
  } = {}
) {
  const redis = options.redis ?? createRedis();
  const limits: RateLimits = { ...defaultRateLimits, ...options.limits };
  const otpQueue = createOtpQueue(options.queue);
  const app = Fastify({
    logger: (options.logger ?? true)
      ? { redact: ["req.headers.authorization", "*.phone", "*.code"] }
      : false,
  });

  registerErrorHandler(app);

  app.addHook("onClose", async () => {
    await otpQueue.close();
    if (options.disconnectPrisma !== false) await prisma.$disconnect();
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

  // Sends 401/403 and returns false unless the caller may use `scope` on this application.
  // The key must belong to the application in the URL, so one tenant's key never works on another.
  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { scope: Scope; applicationId: string; allowAdmin?: boolean }
  ): Promise<boolean> {
    const adminHeader = request.headers["x-admin-token"] as string | undefined;
    if (opts.allowAdmin && adminHeader && isAdminToken(adminHeader)) return true;

    const auth = await verifyApiKey(prisma, request.headers["x-api-key"] as string | undefined);
    if (!auth) {
      sendError(reply, 401, "INVALID_API_KEY", "missing, invalid or revoked API key");
      return false;
    }
    if (auth.applicationId !== opts.applicationId || !auth.scopes.includes(opts.scope)) {
      sendError(reply, 403, "FORBIDDEN", "this API key cannot perform this action");
      return false;
    }
    return true;
  }

  function authorizeAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
    if (isAdminToken(request.headers["x-admin-token"] as string | undefined)) return true;
    sendError(reply, 401, "INVALID_ADMIN_TOKEN", "missing or invalid admin token");
    return false;
  }

  app.get("/health", async () => ({ status: "ok", service: "otplease-server" }));

  // ---------- Applications (tenants) ----------
  app.post("/applications", async (request, reply) => {
    if (!authorizeAdmin(request, reply)) return reply;
    const { name } = createApplicationSchema.parse(request.body);
    const application = await prisma.application.create({ data: { name } });
    return reply.status(201).send(application);
  });

  app.get("/applications", async (request, reply) => {
    if (!authorizeAdmin(request, reply)) return reply;
    return prisma.application.findMany({ orderBy: { createdAt: "desc" } });
  });

  // ---------- API keys ----------
  app.post("/applications/:applicationId/api-keys", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "keys:manage", applicationId, allowAdmin: true }))) return reply;
    const { name, scopes } = createApiKeySchema.parse(request.body);

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return sendError(reply, 404, "APPLICATION_NOT_FOUND", "application not found");

    const { key, record } = await issueApiKey(prisma, applicationId, name, scopes);
    // The full key is shown exactly once; only its hash is stored
    return reply.status(201).send({
      id: record.id,
      name: record.name,
      prefix: record.prefix,
      scopes: record.scopes,
      createdAt: record.createdAt,
      key,
    });
  });

  app.get("/applications/:applicationId/api-keys", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "keys:manage", applicationId, allowAdmin: true }))) return reply;
    return prisma.apiKey.findMany({
      where: { applicationId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, scopes: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    });
  });

  app.delete("/applications/:applicationId/api-keys/:keyId", async (request, reply) => {
    const { applicationId, keyId } = apiKeyParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "keys:manage", applicationId, allowAdmin: true }))) return reply;
    const revoked = await prisma.apiKey.updateMany({
      where: { id: keyId, applicationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) return sendError(reply, 404, "API_KEY_NOT_FOUND", "api key not found");
    return reply.status(204).send();
  });

  // ---------- Users (always inside one application) ----------
  app.post("/applications/:applicationId/users", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "users:write", applicationId }))) return reply;
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

  app.get("/applications/:applicationId/users", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "users:read", applicationId }))) return reply;
    return tenantUsers(prisma, applicationId).list();
  });

  app.get("/applications/:applicationId/users/:userId", async (request, reply) => {
    const { applicationId, userId } = userParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "users:read", applicationId }))) return reply;
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
    if (!(await authorize(request, reply, { scope: "otp:request", applicationId }))) return reply;
    const { phone, channel, email, fallback } = otpRequestSchema.parse(request.body);

    if (
      await rateLimited(reply, [
        { name: "otp-req-phone", subject: `${applicationId}:${phone}`, ...limits.otpRequestPerPhone },
        {
          name: "otp-req-country",
          subject: String(parsePhoneNumberFromString(phone)?.countryCallingCode ?? "unknown"),
          ...limits.otpRequestPerCountry,
        },
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

    // Hand delivery to the worker so the API replies immediately. The code must never be logged.
    const to = channel === "email" ? email! : phone;
    const chain = channel === "email" ? [channel] : [channel, ...fallback.filter((c) => c !== channel)];
    const delivery = await prisma.delivery.create({
      data: { applicationId, requestedChannel: channel, toMasked: maskRecipient(to) },
    });
    await enqueueOtp(otpQueue, { deliveryId: delivery.id, chain, to, code });

    return reply.status(202).send({ status: "otp_request_accepted", userId: user.id, deliveryId: delivery.id });
  });

  app.post("/applications/:applicationId/otp/verify", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "otp:verify", applicationId }))) return reply;
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

  // ---------- Delivery status ----------
  app.get("/applications/:applicationId/deliveries/:deliveryId", async (request, reply) => {
    const { applicationId, deliveryId } = deliveryParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "deliveries:read", applicationId }))) return reply;
    const delivery = await prisma.delivery.findFirst({ where: { id: deliveryId, applicationId } });
    if (!delivery) return sendError(reply, 404, "DELIVERY_NOT_FOUND", "delivery not found");
    const { providerMessageId: _hidden, ...safe } = delivery;
    return safe;
  });

  // Twilio posts form-encoded status callbacks
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );

  const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2 };
  const TWILIO_STATUS: Record<string, string> = {
    sent: "sent",
    delivered: "delivered",
    read: "delivered",
    undelivered: "failed",
    failed: "failed",
  };

  app.post("/webhooks/twilio/status", async (request, reply) => {
    if (!env.TWILIO_AUTH_TOKEN || !env.TWILIO_STATUS_CALLBACK_URL) {
      return sendError(reply, 503, "WEBHOOK_NOT_CONFIGURED", "twilio callbacks are not configured");
    }
    const params = (request.body ?? {}) as Record<string, string>;
    const signature = request.headers["x-twilio-signature"] as string | undefined;
    if (!isValidTwilioSignature(env.TWILIO_AUTH_TOKEN, env.TWILIO_STATUS_CALLBACK_URL, params, signature)) {
      return sendError(reply, 403, "INVALID_SIGNATURE", "invalid signature");
    }

    const sid = params.MessageSid ?? params.CallSid;
    const next = TWILIO_STATUS[params.MessageStatus ?? params.CallStatus ?? ""];
    if (sid && next) {
      const delivery = await prisma.delivery.findFirst({ where: { providerMessageId: sid } });
      // Callbacks can arrive out of order: never move a delivery backwards
      const stale = delivery && next !== "failed" && (STATUS_RANK[next] ?? 0) <= (STATUS_RANK[delivery.status] ?? 0);
      const alreadyDone = delivery?.status === "delivered";
      if (delivery && !stale && !alreadyDone) {
        await prisma.delivery.update({ where: { id: delivery.id }, data: { status: next } });
      }
    }
    return reply.status(204).send();
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
