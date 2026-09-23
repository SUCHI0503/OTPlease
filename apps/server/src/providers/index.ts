import { env } from "../lib/env";
import { EmailProvider } from "./email";
import { MockProvider } from "./mock";
import type { OtpChannel, OtpProvider } from "./types";

export type ProviderRegistry = Record<OtpChannel, OtpProvider>;

export function buildProviders(): ProviderRegistry {
  const mock = new MockProvider();
  const email =
    env.SMTP_HOST && env.SMTP_PORT
      ? new EmailProvider({ host: env.SMTP_HOST, port: env.SMTP_PORT }, env.MAIL_FROM)
      : mock;
  return { sms: mock, email };
}

export { MockProvider } from "./mock";
export type { OtpChannel, OtpMessage, OtpProvider } from "./types";
