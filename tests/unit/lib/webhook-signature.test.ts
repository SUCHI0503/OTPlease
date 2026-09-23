import { describe, expect, it } from "vitest";
import { ReplayGuard, signWebhook, verifyWebhook } from "../../../apps/server/src/lib/webhook-signature";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "otp.verified", data: { userId: "u1" } });
const NOW = 1_800_000_000;

const signed = (over: { body?: string; ts?: number } = {}) => signWebhook(SECRET, over.body ?? BODY, over.ts ?? NOW);
const check = (o: Partial<Parameters<typeof verifyWebhook>[0]> & { ts?: string; sig?: string }) => {
  const { timestamp, signature } = signed();
  return verifyWebhook({
    secret: SECRET,
    body: BODY,
    timestamp: o.ts ?? timestamp,
    signature: o.sig ?? signature,
    nowSeconds: NOW,
    ...o,
  });
};

describe("webhook signatures", () => {
  it("accepts a correctly signed, fresh request", () => {
    expect(check({})).toEqual({ ok: true });
  });

  it("rejects a tampered body, wrong secret and forged signature", () => {
    expect(check({ body: BODY.replace("u1", "u2") })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ secret: "whsec_other" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ sig: "v1=" + "0".repeat(64) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(check({ sig: "v1=short" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a replay of an old request, even though its signature is genuine", () => {
    const old = signed({ ts: NOW - 301 });
    const result = verifyWebhook({ secret: SECRET, body: BODY, ...old, nowSeconds: NOW });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts a request at the edge of the tolerance and rejects timestamps from the future", () => {
    const edge = signed({ ts: NOW - 300 });
    expect(verifyWebhook({ secret: SECRET, body: BODY, ...edge, nowSeconds: NOW }).ok).toBe(true);
    const future = signed({ ts: NOW + 301 });
    expect(verifyWebhook({ secret: SECRET, body: BODY, ...future, nowSeconds: NOW })).toEqual({ ok: false, reason: "expired" });
  });

  it("cannot be re-dated: changing the timestamp invalidates the signature", () => {
    const old = signed({ ts: NOW - 1000 });
    const result = verifyWebhook({ secret: SECRET, body: BODY, timestamp: String(NOW), signature: old.signature, nowSeconds: NOW });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects missing headers and malformed timestamps", () => {
    expect(verifyWebhook({ secret: SECRET, body: BODY, timestamp: undefined, signature: "v1=x" }).ok).toBe(false);
    expect(verifyWebhook({ secret: SECRET, body: BODY, timestamp: "123", signature: undefined })).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyWebhook({ secret: SECRET, body: BODY, timestamp: "abc", signature: "v1=x" })).toEqual({ ok: false, reason: "bad_timestamp" });
  });
});

describe("ReplayGuard", () => {
  it("accepts an event id once and rejects repeats", () => {
    const guard = new ReplayGuard(60);
    expect(guard.firstTime("evt_1", 0)).toBe(true);
    expect(guard.firstTime("evt_1", 1000)).toBe(false);
    expect(guard.firstTime("evt_2", 1000)).toBe(true);
  });

  it("forgets an id after its window", () => {
    const guard = new ReplayGuard(60);
    guard.firstTime("evt_1", 0);
    expect(guard.firstTime("evt_1", 61_000)).toBe(true);
  });
});
