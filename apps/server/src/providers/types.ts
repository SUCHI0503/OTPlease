export type OtpChannel = "sms" | "email";

export interface OtpMessage {
  channel: OtpChannel;
  /** E.164 phone for sms, email address for email */
  to: string;
  code: string;
}

/** Every delivery channel (mock, email, later WhatsApp/SMS/Voice) implements this. */
export interface OtpProvider {
  send(message: OtpMessage): Promise<void>;
}
