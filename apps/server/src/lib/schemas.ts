import { z } from "zod";
import { normalizePhone } from "./phone";
import net from "node:net";
import { SCOPES } from "./apikeys";
import { WEBHOOK_EVENTS } from "../queue/webhook-queue";

export const createApplicationSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100, "name is too long"),
});

// What the developer's backend forwards about the end user's request (all optional)
const contextSchema = z
  .object({
    ip: z
      .string()
      .trim()
      .refine((v) => net.isIP(v.replace(/%.*$/, "")) !== 0, "ip must be a valid IPv4 or IPv6 address")
      .optional(),
    deviceId: z.string().trim().min(8, "deviceId must be at least 8 characters").max(128, "deviceId is too long").optional(),
    userAgent: z.string().max(500, "userAgent is too long").optional(),
  })
  .optional();

// Validates the phone AND converts it to the standard +E164 format
const phoneSchema = z
  .string({ error: "phone is required" })
  .trim()
  .min(1, "phone is required")
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: "invalid phone number" });
      return z.NEVER;
    }
    return normalized;
  });

export const createUserSchema = z.object({
  phone: phoneSchema,
});

export const applicationParamsSchema = z.object({
  applicationId: z.string().uuid("applicationId must be a valid id"),
});

export const userParamsSchema = applicationParamsSchema.extend({
  userId: z.string().uuid("userId must be a valid id"),
});

export const otpRequestSchema = z
  .object({
    phone: phoneSchema,
    channel: z.enum(["sms", "whatsapp", "voice", "email"]).default("sms"),
    // Phone channels to try, in order, if the requested one fails to send
    fallback: z.array(z.enum(["sms", "whatsapp", "voice"])).max(2).default([]),
    email: z.string().trim().toLowerCase().email("invalid email address").optional(),
    context: contextSchema,
  })
  .refine((v) => v.channel !== "email" || v.email, {
    path: ["email"],
    message: "email is required when channel is email",
  });

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string({ error: "code is required" })
    .trim()
    .regex(/^\d{6}$/, "code must be 6 digits"),
  context: contextSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string({ error: "refreshToken is required" }).min(1, "refreshToken is required"),
});

export const deliveryParamsSchema = applicationParamsSchema.extend({
  deliveryId: z.string().uuid("deliveryId must be a valid id"),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100, "name is too long"),
  scopes: z.array(z.enum(SCOPES)).min(1, "at least one scope is required"),
});

export const apiKeyParamsSchema = applicationParamsSchema.extend({
  keyId: z.string().uuid("keyId must be a valid id"),
});

export const createWebhookSchema = z.object({
  url: z.string().trim().min(1, "url is required").max(2000, "url is too long"),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "at least one event is required"),
});

export const webhookParamsSchema = applicationParamsSchema.extend({
  webhookId: z.string().uuid("webhookId must be a valid id"),
});

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1, "days must be at least 1").max(30, "days can be at most 30").default(7),
});

export const riskDecisionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const auditLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1, "limit must be at least 1").max(200, "limit can be at most 200").default(50),
});
