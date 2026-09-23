import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  OTP_HASH_SECRET: z.string().min(32, "OTP_HASH_SECRET must be at least 32 characters"),
  // Platform operator secret: creates applications and their first API keys (until the Phase 13 dashboard)
  ADMIN_TOKEN: z.string().min(32, "ADMIN_TOKEN must be at least 32 characters"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
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
  const twilioSet = v.TWILIO_ACCOUNT_SID || v.TWILIO_AUTH_TOKEN;
  if (twilioSet && !(v.TWILIO_ACCOUNT_SID && v.TWILIO_AUTH_TOKEN)) {
    ctx.addIssue({ code: "custom", path: ["TWILIO_AUTH_TOKEN"], message: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set together" });
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
