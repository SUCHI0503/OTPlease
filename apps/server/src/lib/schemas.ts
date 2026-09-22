import { z } from "zod";
import { normalizePhone } from "./phone";

export const createApplicationSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(100, "name is too long"),
});

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

export const otpRequestSchema = z.object({
  phone: phoneSchema,
});

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z
    .string({ error: "code is required" })
    .trim()
    .regex(/^\d{6}$/, "code must be 6 digits"),
});
