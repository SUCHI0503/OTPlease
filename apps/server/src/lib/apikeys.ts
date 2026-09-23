import crypto from "node:crypto";
import type { ApiKey, PrismaClient } from "@prisma/client";
import { env } from "./env";

export const SCOPES = [
  "users:read",
  "users:write",
  "otp:request",
  "otp:verify",
  "deliveries:read",
  "keys:manage",
] as const;
export type Scope = (typeof SCOPES)[number];

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Keys look like "otpl_<prefix>_<secret>". The prefix is public and finds the row;
 * only a hash of the whole key is stored, so a database leak does not expose usable keys.
 */
export async function issueApiKey(
  prisma: PrismaClient,
  applicationId: string,
  name: string,
  scopes: Scope[]
): Promise<{ key: string; record: ApiKey }> {
  const prefix = crypto.randomBytes(6).toString("hex");
  const secret = crypto.randomBytes(32).toString("base64url");
  const key = `otpl_${prefix}_${secret}`;
  const record = await prisma.apiKey.create({
    data: { applicationId, name, prefix, keyHash: sha256(key), scopes },
  });
  return { key, record };
}

export interface KeyAuth {
  keyId: string;
  applicationId: string;
  scopes: string[];
}

/** Returns the key's identity if it is valid and not revoked, otherwise null. */
export async function verifyApiKey(prisma: PrismaClient, presented: string | undefined): Promise<KeyAuth | null> {
  const match = presented?.match(/^otpl_([0-9a-f]{12})_[\w-]{20,}$/);
  if (!match) return null;
  const row = await prisma.apiKey.findUnique({ where: { prefix: match[1]! } });
  if (!row || row.revokedAt || !safeEqual(sha256(presented!), row.keyHash)) return null;

  // Recording last use on every call would be a write per request, so at most once a minute
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  }
  return { keyId: row.id, applicationId: row.applicationId, scopes: row.scopes };
}

export function isAdminToken(presented: string | undefined): boolean {
  return !!presented && safeEqual(sha256(presented), sha256(env.ADMIN_TOKEN));
}
