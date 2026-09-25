import crypto from "node:crypto";
import { ProviderError, type OtpChannel, type OtpMessage, type OtpProvider, type SendResult } from "./types";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Sender per channel. For WhatsApp sandbox this is the sandbox number, e.g. +14155238886 */
  from: { sms?: string; whatsapp?: string; voice?: string };
  /**
   * WhatsApp only lets a business start a conversation with an approved template, and an OTP always is one.
   * When set (a Content Template SID, HX...), WhatsApp codes are sent through it, with the code as variable {{1}}.
   */
  whatsappContentSid?: string;
  /** Public URL Twilio calls with delivery status updates */
  statusCallbackUrl?: string;
}

type Fetch = typeof fetch;

/** One class for SMS, WhatsApp and Voice: Twilio serves all three through its REST API. */
export class TwilioProvider implements OtpProvider {
  constructor(
    private config: TwilioConfig,
    private fetchImpl: Fetch = fetch
  ) {}

  async send(message: OtpMessage): Promise<SendResult> {
    const { channel } = message;
    const from = this.config.from[channel as "sms" | "whatsapp" | "voice"];
    if (!from) throw new ProviderError(`twilio: no sender configured for ${channel}`);

    const isVoice = channel === "voice";
    const prefix = channel === "whatsapp" ? "whatsapp:" : "";
    const body = new URLSearchParams({ To: `${prefix}${message.to}`, From: `${prefix}${from}` });

    if (isVoice) {
      body.set("Twiml", voiceTwiml(message.code));
    } else if (channel === "whatsapp" && this.config.whatsappContentSid) {
      body.set("ContentSid", this.config.whatsappContentSid);
      body.set("ContentVariables", JSON.stringify({ "1": message.code }));
    } else {
      body.set("Body", `Your verification code is ${message.code}. It expires in 5 minutes.`);
    }
    if (this.config.statusCallbackUrl) body.set("StatusCallback", this.config.statusCallbackUrl);

    const endpoint = isVoice ? "Calls" : "Messages";
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/${endpoint}.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      }
    );

    if (!res.ok) {
      // Twilio's error body can echo the phone number, so only its numeric code is kept
      const err = (await res.json().catch(() => ({}))) as { code?: number };
      throw new ProviderError(`twilio ${channel} failed: http ${res.status}${err.code ? ` code ${err.code}` : ""}`);
    }
    const data = (await res.json()) as { sid?: string };
    return { providerMessageId: data.sid };
  }
}

/** Reads the code digit by digit, twice, so it is easy to catch on a call. */
export function voiceTwiml(code: string): string {
  const spoken = code.split("").join(" ");
  return `<Response><Say>Your verification code is ${spoken}. Again, ${spoken}.</Say></Response>`;
}

/**
 * Validates Twilio's X-Twilio-Signature: base64 HMAC-SHA1 of the full URL
 * followed by every POST parameter (sorted by name) as name+value.
 */
export function isValidTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined
): boolean {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type { OtpChannel };
