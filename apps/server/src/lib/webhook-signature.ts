import crypto from "node:crypto";

export const SIGNATURE_HEADER = "x-otplease-signature";
export const TIMESTAMP_HEADER = "x-otplease-timestamp";
export const EVENT_ID_HEADER = "x-otplease-event-id";
/** How far a timestamp may be from "now" before the receiver rejects it as a replay */
export const DEFAULT_TOLERANCE_SECONDS = 300;

const hmac = (secret: string, timestamp: string, body: string) =>
  crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/** Signs "<timestamp>.<body>", so a captured request cannot be resent with a fresh timestamp. */
export function signWebhook(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const timestamp = String(timestampSeconds);
  return { timestamp, signature: `v1=${hmac(secret, timestamp, body)}` };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing_headers" | "bad_timestamp" | "expired" | "bad_signature" };

/**
 * For webhook receivers. Pass the RAW request body string (not re-serialised JSON).
 * Rejects wrong signatures and timestamps outside the tolerance window, in both directions.
 */
export function verifyWebhook(opts: {
  secret: string;
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): VerifyResult {
  const { secret, body, timestamp, signature } = opts;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "expired" };
  }

  const expected = Buffer.from(`v1=${hmac(secret, timestamp, body)}`);
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * Timestamps stop old requests from being replayed; this stops a request from being
 * replayed inside the window. Receivers should remember event ids for at least the tolerance.
 * In-memory version for a single process; use Redis SET NX EX with several.
 */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private ttlSeconds = DEFAULT_TOLERANCE_SECONDS * 2) {}

  /** Returns true the first time an event id is seen, false for any repeat. */
  firstTime(eventId: string, nowMs = Date.now()): boolean {
    for (const [id, expires] of this.seen) if (expires <= nowMs) this.seen.delete(id);
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, nowMs + this.ttlSeconds * 1000);
    return true;
  }
}
