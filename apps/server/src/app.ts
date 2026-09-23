import cors from "@fastify/cors";
import type { Writable } from "node:stream";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "./lib/prisma";
import { tenantUsers } from "./lib/tenant";
import { env } from "./lib/env";
import crypto from "node:crypto";
import { registerErrorHandler, sendError } from "./lib/errors";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { maskRecipient } from "./lib/mask";
import { maskIp } from "./lib/intelligence";
import { isValidTwilioSignature } from "./providers/twilio";
import { isAdminToken, issueApiKey, verifyApiKey, type Scope } from "./lib/apikeys";
import { DOCS_HTML, buildOpenApiDocument } from "./openapi";
import { evaluateRisk, getRiskConfig, loadUserHistory, riskConfigSchema, saveRiskConfig } from "./lib/risk";
import { computeSignals, recordLogin } from "./lib/intelligence";
import { getAppAnalytics, getOverview } from "./lib/analytics";
import { createWebhookEmitter, createWebhookQueue } from "./queue/webhook-queue";
import { encrypt } from "./lib/secretbox";
import { validateWebhookUrl } from "./lib/webhook-http";
import { createOtpQueue, enqueueOtp } from "./queue/otp-queue";
import type { Redis } from "ioredis";
import { createRedis } from "./lib/redis";
import { checkRateLimits, defaultRateLimits, peekRateLimit, type RateLimits, type Rule } from "./lib/ratelimit";
import { authenticate, createSession, refreshSession, revokeSession } from "./lib/session";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "./lib/otp";
import {
  applicationParamsSchema,
  deliveryParamsSchema,
  analyticsQuerySchema,
  apiKeyParamsSchema,
  auditLogsQuerySchema,
  riskDecisionsQuerySchema,
  createApiKeySchema,
  createWebhookSchema,
  webhookParamsSchema,
  createApplicationSchema,
  createUserSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  userParamsSchema,
} from "./lib/schemas";

declare module "fastify" {
  interface FastifyInstance {
    /** Every route registered on this app, so tests can check the API docs cover them all */
    registeredRoutes: { method: string; url: string }[];
  }
}

export function buildApp(
  options: {
    logger?: boolean;
    /** Where logs go (tests capture them to prove no secrets are written) */
    logStream?: Writable;
    redis?: Redis;
    limits?: Partial<RateLimits>;
    queue?: { attempts?: number; backoffMs?: number };
    /** Set false when several apps share the process (tests), so closing one does not disconnect the shared Prisma client */
    disconnectPrisma?: boolean;
    webhookQueue?: { attempts?: number; backoffMs?: number };
    /** Overrides TRUST_PROXY / CORS_ORIGINS from the environment (used by tests) */
    trustProxy?: boolean | number;
    corsOrigins?: string[];
  } = {}
) {
  const redis = options.redis ?? createRedis();
  const limits: RateLimits = { ...defaultRateLimits, ...options.limits };
  const otpQueue = createOtpQueue(options.queue);
  const webhookQueue = createWebhookQueue(options.webhookQueue);
  const emit = createWebhookEmitter(prisma, webhookQueue);
  const app = Fastify({
    // Only honour X-Forwarded-For when explicitly told we sit behind a trusted proxy
    // A number means "trust this many proxy hops". Fastify supports it at runtime; its typings only list boolean.
    trustProxy: (options.trustProxy ?? env.TRUST_PROXY) as boolean,
    // Every JSON body here is tiny; a small cap stops memory-exhaustion attempts early
    bodyLimit: 64 * 1024,
    logger:
      (options.logger ?? true)
        ? {
            // Defence in depth: request bodies are never logged, and these are scrubbed even if that changes
            redact: {
              paths: [
                "req.headers.authorization",
                "req.headers.cookie",
                'req.headers["x-api-key"]',
                'req.headers["x-admin-token"]',
                'req.headers["x-twilio-signature"]',
                "*.phone",
                "*.code",
                "*.email",
                "*.token",
                "*.secret",
                "*.key",
                "*.accessToken",
                "*.refreshToken",
              ],
              censor: "[redacted]",
            },
            ...(options.logStream ? { stream: options.logStream } : {}),
          }
        : false,
  });

  const registeredRoutes: { method: string; url: string }[] = [];
  app.decorate("registeredRoutes", registeredRoutes);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) registeredRoutes.push({ method: String(method), url: route.url });
  });

  registerErrorHandler(app);

  // Browsers may only call the API from explicitly listed origins. With none listed no CORS headers are sent
  // at all, so other sites cannot read responses even if they know an API key.
  app.register(cors, {
    origin: (options.corsOrigins ?? env.CORS_ORIGINS).length > 0 ? (options.corsOrigins ?? env.CORS_ORIGINS) : false,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["content-type", "x-api-key", "x-admin-token", "authorization"],
    maxAge: 600,
  });

  const DOCS_CSP =
    "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'";
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    const isDocs = request.url === "/docs" || request.url === "/openapi.json";
    reply.header("content-security-policy", request.url === "/docs" ? DOCS_CSP : "default-src 'none'; frame-ancestors 'none'");
    // Responses carry tokens and one-time secrets: no cache, anywhere, ever
    if (!isDocs) reply.header("cache-control", "no-store");
    if (env.NODE_ENV === "production") reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  app.addHook("onClose", async () => {
    await otpQueue.close();
    await webhookQueue.close();
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

  // ---------- Who is calling, audit trail, and lockout of repeated bad guesses ----------
  type Actor = { type: "admin" } | { type: "api_key"; id: string } | { type: "system" };
  const actors = new WeakMap<FastifyRequest, Actor>();

  const failRule = (request: FastifyRequest): Rule => ({
    name: "auth-fail-ip",
    subject: request.ip,
    ...limits.authFailuresPerIp,
  });

  /** True (and a 429 sent) if this IP has guessed credentials wrongly too many times recently. */
  async function lockedOut(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const { count, ttl } = await peekRateLimit(redis, failRule(request));
    if (count < limits.authFailuresPerIp.limit) return false;
    reply.header("Retry-After", String(ttl));
    sendError(reply, 429, "RATE_LIMITED", "too many failed authentication attempts, try again later", {
      retryAfterSeconds: ttl,
    });
    return true;
  }

  async function recordAuthFailure(request: FastifyRequest): Promise<void> {
    const result = await checkRateLimits(redis, [failRule(request)]);
    // Note the moment an IP becomes locked out, once, not on every later attempt
    const { count } = await peekRateLimit(redis, failRule(request));
    if (result.limited || count < limits.authFailuresPerIp.limit) return;
    if (count === limits.authFailuresPerIp.limit) {
      await audit(request, { action: "auth.lockout", metadata: { failures: count } }, { type: "system" });
    }
  }

  /** Writes an audit record. It never throws: failing to log must not fail the action, but it is reported. */
  async function audit(
    request: FastifyRequest,
    entry: { applicationId?: string; action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> },
    actorOverride?: Actor
  ): Promise<void> {
    const actor = actorOverride ?? actors.get(request) ?? { type: "system" as const };
    try {
      await prisma.auditLog.create({
        data: {
          applicationId: entry.applicationId ?? null,
          actorType: actor.type,
          actorId: actor.type === "api_key" ? actor.id : null,
          action: entry.action,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          ipMasked: maskIp(request.ip),
          metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      request.log.error({ type: (err as Error).name, action: entry.action }, "could not write audit log");
    }
  }

  // Sends 401/403/429 and returns false unless the caller may use `scope` on this application.
  // The key must belong to the application in the URL, so one tenant's key never works on another.
  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { scope: Scope; applicationId: string; allowAdmin?: boolean }
  ): Promise<boolean> {
    if (await lockedOut(request, reply)) return false;

    const adminHeader = request.headers["x-admin-token"] as string | undefined;
    if (opts.allowAdmin && adminHeader && isAdminToken(adminHeader)) {
      actors.set(request, { type: "admin" });
      return true;
    }

    const auth = await verifyApiKey(prisma, request.headers["x-api-key"] as string | undefined);
    if (!auth) {
      await recordAuthFailure(request);
      sendError(reply, 401, "INVALID_API_KEY", "missing, invalid or revoked API key");
      return false;
    }
    if (auth.applicationId !== opts.applicationId || !auth.scopes.includes(opts.scope)) {
      sendError(reply, 403, "FORBIDDEN", "this API key cannot perform this action");
      return false;
    }
    actors.set(request, { type: "api_key", id: auth.keyId });
    return true;
  }

  async function authorizeAdmin(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (await lockedOut(request, reply)) return false;
    if (isAdminToken(request.headers["x-admin-token"] as string | undefined)) {
      actors.set(request, { type: "admin" });
      return true;
    }
    await recordAuthFailure(request);
    sendError(reply, 401, "INVALID_ADMIN_TOKEN", "missing or invalid admin token");
    return false;
  }

  const openApiDocument = buildOpenApiDocument();
  app.get("/openapi.json", async () => openApiDocument);
  app.get("/docs", async (_request, reply) => reply.type("text/html").send(DOCS_HTML));

  app.get("/health", async () => ({ status: "ok", service: "otplease-server" }));

  // ---------- Applications (tenants) ----------
  app.post("/applications", async (request, reply) => {
    if (!(await authorizeAdmin(request, reply))) return reply;
    const { name } = createApplicationSchema.parse(request.body);
    const application = await prisma.application.create({ data: { name } });
    await audit(request, { applicationId: application.id, action: "application.created", targetType: "application", targetId: application.id });
    return reply.status(201).send(application);
  });

  app.get("/applications", async (request, reply) => {
    if (!(await authorizeAdmin(request, reply))) return reply;
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
    await audit(request, { applicationId, action: "api_key.created", targetType: "api_key", targetId: record.id, metadata: { name, scopes } });
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
    await audit(request, { applicationId, action: "api_key.revoked", targetType: "api_key", targetId: keyId });
    return reply.status(204).send();
  });

  // ---------- Audit log ----------
  const auditSelect = { id: true, applicationId: true, actorType: true, actorId: true, action: true, targetType: true, targetId: true, ipMasked: true, metadata: true, createdAt: true } as const;

  app.get("/applications/:applicationId/audit-logs", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "audit:read", applicationId, allowAdmin: true }))) return reply;
    const { limit } = auditLogsQuerySchema.parse(request.query);
    return prisma.auditLog.findMany({ where: { applicationId }, orderBy: { createdAt: "desc" }, take: limit, select: auditSelect });
  });

  // Operator view, including events that belong to no application (such as lockouts)
  app.get("/audit-logs", async (request, reply) => {
    if (!(await authorizeAdmin(request, reply))) return reply;
    const { limit } = auditLogsQuerySchema.parse(request.query);
    return prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit, select: auditSelect });
  });

  // ---------- Risk engine ----------
  app.get("/applications/:applicationId/risk-config", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "risk:manage", applicationId, allowAdmin: true }))) return reply;
    return getRiskConfig(prisma, applicationId);
  });

  // Replaces the whole configuration: anything left out goes back to its default
  app.put("/applications/:applicationId/risk-config", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "risk:manage", applicationId, allowAdmin: true }))) return reply;
    const config = riskConfigSchema.parse(request.body ?? {});
    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return sendError(reply, 404, "APPLICATION_NOT_FOUND", "application not found");
    await saveRiskConfig(prisma, applicationId, config);
    await audit(request, { applicationId, action: "risk_config.updated", targetType: "risk_config", metadata: { mode: config.mode } });
    return config;
  });

  app.get("/applications/:applicationId/risk/decisions", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "risk:manage", applicationId, allowAdmin: true }))) return reply;
    const { limit } = riskDecisionsQuerySchema.parse(request.query);
    return prisma.riskDecision.findMany({
      where: { applicationId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, userId: true, decision: true, enforced: true, score: true, reasons: true, country: true, createdAt: true },
    });
  });

  // ---------- Analytics ----------
  app.get("/analytics/overview", async (request, reply) => {
    if (!(await authorizeAdmin(request, reply))) return reply;
    const { days } = analyticsQuerySchema.parse(request.query);
    return getOverview(prisma, days);
  });

  app.get("/applications/:applicationId", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "analytics:read", applicationId, allowAdmin: true }))) return reply;
    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return sendError(reply, 404, "APPLICATION_NOT_FOUND", "application not found");
    return application;
  });

  app.get("/applications/:applicationId/analytics", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "analytics:read", applicationId, allowAdmin: true }))) return reply;
    const { days } = analyticsQuerySchema.parse(request.query);
    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return sendError(reply, 404, "APPLICATION_NOT_FOUND", "application not found");
    return getAppAnalytics(prisma, applicationId, days);
  });

  // ---------- Webhooks ----------
  app.post("/applications/:applicationId/webhooks", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "webhooks:manage", applicationId, allowAdmin: true }))) return reply;
    const { url, events } = createWebhookSchema.parse(request.body);

    const problem = validateWebhookUrl(url, env.WEBHOOK_ALLOW_PRIVATE_URLS);
    if (problem) return sendError(reply, 400, "INVALID_WEBHOOK_URL", problem);

    const application = await prisma.application.findUnique({ where: { id: applicationId } });
    if (!application) return sendError(reply, 404, "APPLICATION_NOT_FOUND", "application not found");

    const secret = `whsec_${crypto.randomBytes(32).toString("base64url")}`;
    const endpoint = await prisma.webhookEndpoint.create({
      data: { applicationId, url, events, secretEnc: encrypt(secret) },
    });
    // Only the host is recorded: the full URL may carry tokens in its path or query
    await audit(request, { applicationId, action: "webhook.created", targetType: "webhook", targetId: endpoint.id, metadata: { host: new URL(url).host, events } });
    // The signing secret is shown exactly once
    return reply.status(201).send({ id: endpoint.id, url, events, createdAt: endpoint.createdAt, secret });
  });

  app.get("/applications/:applicationId/webhooks", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "webhooks:manage", applicationId, allowAdmin: true }))) return reply;
    return prisma.webhookEndpoint.findMany({
      where: { applicationId },
      orderBy: { createdAt: "desc" },
      select: { id: true, url: true, events: true, createdAt: true, revokedAt: true },
    });
  });

  app.delete("/applications/:applicationId/webhooks/:webhookId", async (request, reply) => {
    const { applicationId, webhookId } = webhookParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "webhooks:manage", applicationId, allowAdmin: true }))) return reply;
    const revoked = await prisma.webhookEndpoint.updateMany({
      where: { id: webhookId, applicationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 0) return sendError(reply, 404, "WEBHOOK_NOT_FOUND", "webhook not found");
    await audit(request, { applicationId, action: "webhook.revoked", targetType: "webhook", targetId: webhookId });
    return reply.status(204).send();
  });

  // Replaces the signing secret at once: deliveries signed with the old one stop verifying.
  app.post("/applications/:applicationId/webhooks/:webhookId/rotate-secret", async (request, reply) => {
    const { applicationId, webhookId } = webhookParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "webhooks:manage", applicationId, allowAdmin: true }))) return reply;
    const secret = `whsec_${crypto.randomBytes(32).toString("base64url")}`;
    const updated = await prisma.webhookEndpoint.updateMany({
      where: { id: webhookId, applicationId, revokedAt: null },
      data: { secretEnc: encrypt(secret) },
    });
    if (updated.count === 0) return sendError(reply, 404, "WEBHOOK_NOT_FOUND", "webhook not found");
    await audit(request, { applicationId, action: "webhook.secret_rotated", targetType: "webhook", targetId: webhookId });
    return { id: webhookId, secret };
  });

  app.get("/applications/:applicationId/webhooks/:webhookId/logs", async (request, reply) => {
    const { applicationId, webhookId } = webhookParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "webhooks:manage", applicationId, allowAdmin: true }))) return reply;
    return prisma.webhookLog.findMany({
      where: { applicationId, endpointId: webhookId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, eventId: true, type: true, status: true, attempts: true, lastStatusCode: true, lastError: true, createdAt: true },
    });
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

  app.get("/applications/:applicationId/users/:userId/devices", async (request, reply) => {
    const { applicationId, userId } = userParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "users:read", applicationId }))) return reply;
    if (!(await tenantUsers(prisma, applicationId).findById(userId))) {
      return sendError(reply, 404, "USER_NOT_FOUND", "user not found");
    }
    return prisma.device.findMany({
      where: { applicationId, userId },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true, userAgent: true, lastIpMasked: true, firstSeenAt: true, lastSeenAt: true },
    });
  });

  // ---------- OTP ----------
  const OTP_EXPIRY_MINUTES = 5;
  const OTP_MAX_ATTEMPTS = 5;

  app.post("/applications/:applicationId/otp/request", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "otp:request", applicationId }))) return reply;
    const { phone, channel, email, fallback, context } = otpRequestSchema.parse(request.body);

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

    // Look the user up without creating them: a blocked request must not leave a new user behind
    const existingUser = await prisma.user.findUnique({ where: { applicationId_phone: { applicationId, phone } } });
    const signals = await computeSignals(prisma, redis, applicationId, existingUser?.id ?? null, phone, context);

    // Risk engine: `block` is enforced here (in enforce mode); `challenge` is passed to the caller to act on
    const riskConfig = await getRiskConfig(prisma, applicationId);
    let risk: { decision: string; enforced: boolean; score: number; reasons: string[] } | null = null;
    if (riskConfig.mode !== "off") {
      const country = parsePhoneNumberFromString(phone)?.country ?? null;
      const result = evaluateRisk(
        { signals, user: await loadUserHistory(prisma, existingUser?.id ?? null), country },
        riskConfig
      );
      const enforced = riskConfig.mode === "enforce";
      risk = { decision: result.decision, enforced, score: result.score, reasons: result.reasons.map((r) => r.code) };

      if (result.decision !== "allow") {
        await prisma.riskDecision.create({
          data: {
            applicationId,
            userId: existingUser?.id ?? null,
            decision: result.decision,
            enforced,
            score: result.score,
            reasons: risk.reasons,
            country,
          },
        });
        await emit(applicationId, result.decision === "block" ? "risk.blocked" : "risk.challenged", {
          userId: existingUser?.id ?? null,
          score: result.score,
          reasons: risk.reasons,
          enforced,
        });
      }
      if (result.decision === "block" && enforced) {
        return sendError(reply, 403, "RISK_BLOCKED", "this request was blocked by risk rules", {
          score: result.score,
          reasons: result.reasons.map((r) => ({ code: r.code, message: r.message })),
        });
      }
    }

    const user = existingUser ?? (await tenantUsers(prisma, applicationId).findOrCreate(phone));

    const code = generateOtpCode();
    const codeHash = hashOtpCode(code);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    // One active code per user. The advisory lock makes concurrent requests for the
    // same user take turns, so the "consume old, create new" step cannot interleave.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
      await tx.otpCode.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.otpCode.create({
        data: { applicationId, userId: user.id, codeHash, expiresAt, maxAttempts: OTP_MAX_ATTEMPTS },
      });
    });

    // Hand delivery to the worker so the API replies immediately. The code must never be logged.
    const to = channel === "email" ? email! : phone;
    const chain = channel === "email" ? [channel] : [channel, ...fallback.filter((c) => c !== channel)];
    const delivery = await prisma.delivery.create({
      data: { applicationId, requestedChannel: channel, toMasked: maskRecipient(to) },
    });
    await enqueueOtp(otpQueue, { deliveryId: delivery.id, chain, to, code });

    return reply.status(202).send({ status: "otp_request_accepted", userId: user.id, deliveryId: delivery.id, signals, risk });
  });

  app.post("/applications/:applicationId/otp/verify", async (request, reply) => {
    const { applicationId } = applicationParamsSchema.parse(request.params);
    if (!(await authorize(request, reply, { scope: "otp:verify", applicationId }))) return reply;
    const { phone, code, context } = otpVerifySchema.parse(request.body);

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

    const login = await recordLogin(prisma, applicationId, user.id, context);
    const tokens = await createSession(prisma, applicationId, user.id);
    await emit(applicationId, "otp.verified", { userId: user.id });
    if (login.isNewDevice) {
      await emit(applicationId, "device.new", {
        userId: user.id,
        deviceId: login.deviceId,
        isFirstDevice: login.isFirstDevice,
        ip: login.ipMasked,
        userAgent: login.userAgent,
      });
    }
    return reply.status(200).send({
      status: "verified",
      userId: user.id,
      ...tokens,
      device: { id: login.deviceId, isNew: login.isNewDevice, isFirstDevice: login.isFirstDevice, isNewIp: login.isNewIp },
    });
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
        if (next === "delivered" || next === "failed") {
          await emit(delivery.applicationId, next === "delivered" ? "delivery.delivered" : "delivery.failed", {
            deliveryId: delivery.id,
            channel: delivery.channel,
            recipient: delivery.toMasked,
          });
        }
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
