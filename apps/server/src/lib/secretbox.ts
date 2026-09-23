import crypto from "node:crypto";
import { env } from "./env";

// Key derived from the OTP secret, with its own label so it is separate from the hashing key.
const key = crypto.createHmac("sha256", env.OTP_HASH_SECRET).update("queue-payload-v1").digest();

/** AES-256-GCM. Used so OTP codes sitting in Redis job data are never plaintext. */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decrypt(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
