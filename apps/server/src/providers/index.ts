import { env } from "../lib/env";
import { EmailProvider } from "./email";
import { MockProvider } from "./mock";
import { TwilioProvider } from "./twilio";
import type { OtpChannel, OtpProvider } from "./types";

export type ProviderRegistry = Record<OtpChannel, OtpProvider>;

export function buildProviders(): ProviderRegistry {
  const mock = new MockProvider();
  const email =
    env.SMTP_HOST && env.SMTP_PORT
      ? new EmailProvider({ host: env.SMTP_HOST, port: env.SMTP_PORT }, env.MAIL_FROM)
      : mock;
  const twilio =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
      ? new TwilioProvider({
          accountSid: env.TWILIO_ACCOUNT_SID,
          authToken: env.TWILIO_AUTH_TOKEN,
          from: { sms: env.TWILIO_SMS_FROM, whatsapp: env.TWILIO_WHATSAPP_FROM, voice: env.TWILIO_VOICE_FROM },
          statusCallbackUrl: env.TWILIO_STATUS_CALLBACK_URL,
        })
      : mock;
  return { sms: twilio, whatsapp: twilio, voice: twilio, email };
}

export { MockProvider } from "./mock";
export type { OtpChannel, OtpMessage, OtpProvider, SendResult } from "./types";
