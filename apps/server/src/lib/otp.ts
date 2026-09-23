import crypto from "node:crypto";
import { env } from "./env";

/**
 * Generates a random 6-digit OTP code using a cryptographically secure RNG.
 * Returns a string like "042917" (zero-padded, always 6 digits).
 */
export function generateOtpCode(): string {
  const num = crypto.randomInt(0, 1_000_000); // 0 to 999999
  return num.toString().padStart(6, "0");
}

/**
 * Hashes a plaintext OTP code using HMAC-SHA256 with the server's secret key.
 * We store only this hash in the database — never the plaintext code.
 */
export function hashOtpCode(code: string): string {
  return crypto
    .createHmac("sha256", env.OTP_HASH_SECRET)
    .update(code)
    .digest("hex");
}

/**
 * Compares a plaintext code against a stored hash using a constant-time
 * comparison, to prevent timing attacks that could leak the correct code
 * byte-by-byte via response time differences.
 */
export function verifyOtpCode(code: string, storedHash: string): boolean {
  const candidateHash = hashOtpCode(code);
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
