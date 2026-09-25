export type OtpChannel = "sms" | "whatsapp" | "voice" | "email";

export interface OtpMessage {
  channel: OtpChannel;
  /** E.164 phone for sms/whatsapp/voice, email address for email */
  to: string;
  code: string;
}

export interface SendResult {
  /** The provider's own id, used to match delivery-status callbacks */
  providerMessageId?: string;
}

/** Every delivery channel (mock, email, Twilio...) implements this. */
export interface OtpProvider {
  send(message: OtpMessage): Promise<SendResult>;
}

/** Provider failures. The message never contains the recipient or the code. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
