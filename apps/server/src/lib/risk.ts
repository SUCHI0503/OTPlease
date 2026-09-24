import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Signals } from "./intelligence";

// ---------- Configuration ----------

const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "use two-letter country codes such as IN or US");

export const RULE_CODES = [
  "country_blocked",
  "country_not_allowed",
  "ip_velocity_block",
  "device_velocity_block",
  "ip_velocity",
  "device_velocity",
  "new_device",
  "new_ip",
  "private_ip",
  "many_codes",
  "recent_failures",
  "context_missing",
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

export const riskConfigSchema = z
  .object({
    /** off: no evaluation. log: evaluate and record, never block. enforce: block for real. */
    mode: z.enum(["off", "log", "enforce"]).default("log"),
    challengeScore: z.number().int().min(1).max(100).default(40),
    blockScore: z.number().int().min(1).max(100).default(80),
    /** Different phone numbers seen from one IP (last hour) */
    ipVelocity: z.object({ challenge: z.number().int().min(2).default(5), block: z.number().int().min(2).default(10) }).default({ challenge: 5, block: 10 }),
    /** Different phone numbers seen from one device (last 24 hours) */
    deviceVelocity: z.object({ challenge: z.number().int().min(2).default(3), block: z.number().int().min(2).default(6) }).default({ challenge: 3, block: 6 }),
    /** If not empty, only these countries may request codes */
    allowedCountries: z.array(country).max(250).default([]),
    blockedCountries: z.array(country).max(250).default([]),
    /**
     * Cost cap: most OTP requests this application may make per hour, whatever the risk mode.
     * Leave it out to use the platform default (1000). Protects against SMS pumping and runaway bills.
     */
    sendCapPerHour: z.number().int().min(1, "sendCapPerHour must be at least 1").max(1_000_000).optional(),
    /** Treat requests without ip/deviceId as suspicious */
    requireContext: z.boolean().default(false),
    disabledRules: z.array(z.enum(RULE_CODES)).default([]),
  })
  .refine((c) => c.challengeScore < c.blockScore, { path: ["blockScore"], message: "blockScore must be higher than challengeScore" })
  .refine((c) => c.ipVelocity.challenge <= c.ipVelocity.block, { path: ["ipVelocity"], message: "block must be at least challenge" })
  .refine((c) => c.deviceVelocity.challenge <= c.deviceVelocity.block, { path: ["deviceVelocity"], message: "block must be at least challenge" });

export type RiskConfig = z.infer<typeof riskConfigSchema>;
export const defaultRiskConfig: RiskConfig = riskConfigSchema.parse({});

// ---------- Evaluation (pure: same input, same decision) ----------

export interface RiskInput {
  signals: Signals;
  user: {
    isNew: boolean;
    /** Devices this user has logged in from before */
    deviceCount: number;
    codesLastHour: number;
    failedAttemptsLastHour: number;
  };
  /** ISO 3166 alpha-2 country of the phone number, or null if unknown */
  country: string | null;
}

export type Decision = "allow" | "challenge" | "block";
export interface Reason {
  code: RuleCode;
  points: number;
  /** A hard rule blocks on its own, whatever the score */
  hard: boolean;
  message: string;
}
export interface RiskResult {
  decision: Decision;
  score: number;
  reasons: Reason[];
}

const MESSAGES: Record<RuleCode, string> = {
  country_blocked: "phone number is in a blocked country",
  country_not_allowed: "phone number is not in an allowed country",
  ip_velocity_block: "the same IP has requested codes for too many different phones",
  device_velocity_block: "the same device has requested codes for too many different phones",
  ip_velocity: "the same IP has requested codes for several different phones",
  device_velocity: "the same device has requested codes for several different phones",
  new_device: "login from a device this user has not used before",
  new_ip: "login from an IP this user has not used before",
  private_ip: "the forwarded IP is a private or loopback address",
  many_codes: "several codes requested for this user in the last hour",
  recent_failures: "several wrong codes entered for this user in the last hour",
  context_missing: "no ip or device information was forwarded",
};

export function evaluateRisk(input: RiskInput, config: RiskConfig): RiskResult {
  const { signals: s, user } = input;
  const fired: Reason[] = [];
  const hit = (code: RuleCode, points: number, hard = false) => {
    if (!config.disabledRules.includes(code)) fired.push({ code, points, hard, message: MESSAGES[code] });
  };

  // Hard rules: cost protection that must not depend on a score
  if (input.country && config.blockedCountries.includes(input.country)) hit("country_blocked", 100, true);
  if (input.country && config.allowedCountries.length > 0 && !config.allowedCountries.includes(input.country)) {
    hit("country_not_allowed", 100, true);
  }
  if (s.phonesFromIp !== null && s.phonesFromIp >= config.ipVelocity.block) hit("ip_velocity_block", 100, true);
  else if (s.phonesFromIp !== null && s.phonesFromIp >= config.ipVelocity.challenge) hit("ip_velocity", 35);

  if (s.phonesFromDevice !== null && s.phonesFromDevice >= config.deviceVelocity.block) hit("device_velocity_block", 100, true);
  else if (s.phonesFromDevice !== null && s.phonesFromDevice >= config.deviceVelocity.challenge) hit("device_velocity", 35);

  // A user's very first device or IP says nothing, so these only apply to users with history
  if (s.newDevice === true && user.deviceCount > 0) hit("new_device", 25);
  if (s.newIp === true && user.deviceCount > 0) hit("new_ip", 10);
  if (s.ip?.isPrivate) hit("private_ip", 20);
  if (user.codesLastHour >= 3) hit("many_codes", 20);
  if (user.failedAttemptsLastHour >= 3) hit("recent_failures", 25);
  if (config.requireContext && s.newDevice === null && s.newIp === null) hit("context_missing", 40);

  const score = Math.min(100, fired.reduce((n, r) => n + r.points, 0));
  let decision: Decision = "allow";
  if (fired.some((r) => r.hard) || score >= config.blockScore) decision = "block";
  else if (score >= config.challengeScore) decision = "challenge";
  return { decision, score, reasons: fired };
}

// ---------- Storage ----------

/** Effective config: whatever was saved, with defaults filling any gaps (including new settings added later). */
export async function getRiskConfig(prisma: PrismaClient, applicationId: string): Promise<RiskConfig> {
  const row = await prisma.riskConfig.findUnique({ where: { applicationId } });
  const parsed = riskConfigSchema.safeParse(row?.config ?? {});
  return parsed.success ? parsed.data : defaultRiskConfig;
}

export async function saveRiskConfig(prisma: PrismaClient, applicationId: string, config: RiskConfig): Promise<void> {
  await prisma.riskConfig.upsert({ where: { applicationId }, create: { applicationId, config }, update: { config } });
}

/** What the engine needs to know about a user's recent history. Unknown users are brand new. */
export async function loadUserHistory(prisma: PrismaClient, userId: string | null, now = new Date()): Promise<RiskInput["user"]> {
  if (!userId) return { isNew: true, deviceCount: 0, codesLastHour: 0, failedAttemptsLastHour: 0 };
  const since = new Date(now.getTime() - 3_600_000);
  const [deviceCount, codes] = await Promise.all([
    prisma.device.count({ where: { userId } }),
    prisma.otpCode.aggregate({ where: { userId, createdAt: { gte: since } }, _count: true, _sum: { attempts: true } }),
  ]);
  return { isNew: false, deviceCount, codesLastHour: codes._count, failedAttemptsLastHour: codes._sum.attempts ?? 0 };
}
