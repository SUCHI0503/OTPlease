import { z } from "zod";
import { RATE_LIMIT_NAMES } from "./ratelimit";

const rateLimitValue = z.object({
  limit: z.number().int().min(1).max(10_000_000),
  windowSeconds: z.number().int().min(1).max(86_400),
});
const rateLimitOverrides = z
  .object(Object.fromEntries(RATE_LIMIT_NAMES.map((name) => [name, rateLimitValue.optional()])) as Record<(typeof RATE_LIMIT_NAMES)[number], z.ZodOptional<typeof rateLimitValue>>)
  .strict();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Tunes the rate limits without a code change, e.g. '{"otpRequestPerIp":{"limit":5000,"windowSeconds":600}}'.
  // Names: otpRequestPerPhone, otpRequestPerIp, otpRequestPerCountry, otpRequestPerApplication, verifyPerPhone,
  // verifyPerIp, refreshPerIp, authFailuresPerIp. Used for load tests; the server logs a warning when it is set.
  RATE_LIMITS_JSON: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return {};
      let raw: unknown;
      try {
        raw = JSON.parse(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "RATE_LIMITS_JSON is not valid JSON" });
        return z.NEVER;
      }
      const parsed = rateLimitOverrides.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ code: "custom", message: `RATE_LIMITS_JSON ${issue.path.join(".") || "value"}: ${issue.message}` });
        }
        return z.NEVER;
      }
      return parsed.data;
    }),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  OTP_HASH_SECRET: z.string().min(32, "OTP_HASH_SECRET must be at least 32 characters"),
  // Platform operator secret: creates applications and their first API keys (until the Phase 13 dashboard)
  ADMIN_TOKEN: z.string().min(32, "ADMIN_TOKEN must be at least 32 characters"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Number of trusted reverse-proxy hops (or true/false). Leave false unless behind Nginx/a load balancer:
  // when false, X-Forwarded-For is ignored so clients cannot fake their IP to dodge rate limits.
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => (v === "true" ? true : v === "false" ? false : Number(v)))
    .refine((v) => v === true || v === false || (Number.isInteger(v) && v >= 1 && v <= 10), "TRUST_PROXY must be true, false or a number of proxy hops (1-10)"),
  // Browser origins allowed to call the API directly, comma separated. Empty (default) means no CORS at all,
  // which is right when only servers call the API. Never "*".
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean))
    .refine((list) => list.every((o) => { try { return new URL(o).origin === o; } catch { return false; } }), "CORS_ORIGINS must be exact origins like https://app.example.com (no paths, no *)"),
  // Dev/test only: the mock provider also writes each message to the Redis list "mock:outbox", so an
  // end-to-end test in another process can read the code. Refused in production.
  MOCK_OUTBOX_REDIS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Lets webhooks point at localhost/private addresses. Local dev and tests only.
  WEBHOOK_ALLOW_PRIVATE_URLS: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Optional Twilio (SMS, WhatsApp, Voice). Without it those channels use the mock provider.
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TWILIO_VOICE_FROM: z.string().optional(),
  TWILIO_STATUS_CALLBACK_URL: z.string().url().optional(),
  // Optional SMTP (local: Mailpit). Without it, the email channel falls back to the mock provider.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  MAIL_FROM: z.string().default("OTPlease <no-reply@otplease.local>"),
});

const checkedSchema = envSchema.superRefine((v, ctx) => {
  // Three different jobs, three different secrets: reusing one would let a leak of one break all
  const secrets = { OTP_HASH_SECRET: v.OTP_HASH_SECRET, JWT_SECRET: v.JWT_SECRET, ADMIN_TOKEN: v.ADMIN_TOKEN };
  for (const [name, value] of Object.entries(secrets)) {
    if (Object.entries(secrets).some(([other, o]) => other !== name && o === value)) {
      ctx.addIssue({ code: "custom", path: [name], message: `${name} must be different from the other secrets` });
    }
    if (new Set(value).size < 10 || /^(change|secret|password|example|test|default)/i.test(value)) {
      ctx.addIssue({ code: "custom", path: [name], message: `${name} looks like a placeholder; generate one with: openssl rand -hex 32` });
    }
  }
  const twilioSet = v.TWILIO_ACCOUNT_SID || v.TWILIO_AUTH_TOKEN;
  if (twilioSet && !(v.TWILIO_ACCOUNT_SID && v.TWILIO_AUTH_TOKEN)) {
    ctx.addIssue({ code: "custom", path: ["TWILIO_AUTH_TOKEN"], message: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set together" });
  }
  if (v.NODE_ENV === "production" && v.WEBHOOK_ALLOW_PRIVATE_URLS) {
    ctx.addIssue({ code: "custom", path: ["WEBHOOK_ALLOW_PRIVATE_URLS"], message: "must be false in production (SSRF protection)" });
  }
  if (v.NODE_ENV === "production" && v.MOCK_OUTBOX_REDIS) {
    ctx.addIssue({ code: "custom", path: ["MOCK_OUTBOX_REDIS"], message: "must be false in production (it stores OTP codes in plain text)" });
  }
  // The mock provider must never be the real delivery path in production
  if (v.NODE_ENV === "production" && !(v.TWILIO_ACCOUNT_SID && v.SMTP_HOST)) {
    ctx.addIssue({ code: "custom", path: ["TWILIO_ACCOUNT_SID"], message: "production requires Twilio and SMTP settings (mock provider is not allowed)" });
  }
});

const parsed = checkedSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
