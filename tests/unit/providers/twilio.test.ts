import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { TwilioProvider, isValidTwilioSignature, voiceTwiml } from "../../../apps/server/src/providers/twilio";
import { ProviderError } from "../../../apps/server/src/providers/types";

function fakeFetch(response: { ok: boolean; status?: number; body: object }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: response.ok, status: response.status ?? 200, json: async () => response.body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const config = {
  accountSid: "ACtest",
  authToken: "secret",
  from: { sms: "+15550001", whatsapp: "+14155238886", voice: "+15550002" },
  statusCallbackUrl: "https://example.test/cb",
};
const PHONE = "+919876543210";

describe("TwilioProvider", () => {
  it("sends SMS through the Messages API with basic auth", async () => {
    const f = fakeFetch({ ok: true, body: { sid: "SM123" } });
    const result = await new TwilioProvider(config, f.impl).send({ channel: "sms", to: PHONE, code: "123456" });

    expect(result.providerMessageId).toBe("SM123");
    expect(f.calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("ACtest:secret").toString("base64")}`);
    const body = f.calls[0]!.init.body as URLSearchParams;
    expect(body.get("To")).toBe(PHONE);
    expect(body.get("From")).toBe("+15550001");
    expect(body.get("Body")).toContain("123456");
    expect(body.get("StatusCallback")).toBe("https://example.test/cb");
  });

  it("prefixes numbers with whatsapp: for the WhatsApp channel", async () => {
    const f = fakeFetch({ ok: true, body: { sid: "SM1" } });
    await new TwilioProvider(config, f.impl).send({ channel: "whatsapp", to: PHONE, code: "123456" });
    const body = f.calls[0]!.init.body as URLSearchParams;
    expect(body.get("To")).toBe(`whatsapp:${PHONE}`);
    expect(body.get("From")).toBe("whatsapp:+14155238886");
  });

  it("places a call with spoken digits for the voice channel", async () => {
    const f = fakeFetch({ ok: true, body: { sid: "CA1" } });
    await new TwilioProvider(config, f.impl).send({ channel: "voice", to: PHONE, code: "123456" });
    expect(f.calls[0]!.url).toContain("/Calls.json");
    expect((f.calls[0]!.init.body as URLSearchParams).get("Twiml")).toBe(voiceTwiml("123456"));
    expect(voiceTwiml("123456")).toContain("1 2 3 4 5 6");
  });

  it("throws a ProviderError that leaks neither the phone nor the code", async () => {
    const f = fakeFetch({ ok: false, status: 400, body: { code: 21211, message: `bad number ${PHONE}` } });
    const err = await new TwilioProvider(config, f.impl)
      .send({ channel: "sms", to: PHONE, code: "654321" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain("21211");
    expect(err.message).not.toContain("9876543210");
    expect(err.message).not.toContain("654321");
  });

  it("fails clearly when no sender is configured for the channel", async () => {
    const f = fakeFetch({ ok: true, body: {} });
    const provider = new TwilioProvider({ ...config, from: {} }, f.impl);
    await expect(provider.send({ channel: "sms", to: PHONE, code: "123456" })).rejects.toThrow(/no sender/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("isValidTwilioSignature", () => {
  const url = "https://example.test/cb";
  const params = { MessageSid: "SM1", MessageStatus: "delivered" };
  const sign = (u: string, p: Record<string, string>, token = "secret") =>
    crypto
      .createHmac("sha1", token)
      .update(u + Object.keys(p).sort().map((k) => k + p[k]).join(""))
      .digest("base64");

  it("accepts a correct signature", () => {
    expect(isValidTwilioSignature("secret", url, params, sign(url, params))).toBe(true);
  });
  it("rejects a wrong token, changed params, wrong url and a missing signature", () => {
    expect(isValidTwilioSignature("secret", url, params, sign(url, params, "other"))).toBe(false);
    expect(isValidTwilioSignature("secret", url, { ...params, MessageStatus: "failed" }, sign(url, params))).toBe(false);
    expect(isValidTwilioSignature("secret", "https://evil.test/cb", params, sign(url, params))).toBe(false);
    expect(isValidTwilioSignature("secret", url, params, undefined)).toBe(false);
  });
});
