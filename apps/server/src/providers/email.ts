import nodemailer from "nodemailer";
import type { OtpMessage, OtpProvider, SendResult } from "./types";

/** The one thing we need from a mail transport, so tests can substitute one that never touches the network. */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

/**
 * Port 465 is TLS from the first byte; other ports start plain and upgrade with STARTTLS. When credentials are
 * used, the upgrade is required, so a login is never sent over an unencrypted connection.
 */
export function smtpTransportOptions(smtp: SmtpSettings) {
  const secure = smtp.port === 465;
  const auth = smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined;
  return { host: smtp.host, port: smtp.port, secure, ...(auth ? { auth, requireTLS: !secure } : {}) };
}

export class EmailProvider implements OtpProvider {
  private transport: MailTransport;

  constructor(
    smtp: SmtpSettings,
    private from: string,
    transport?: MailTransport
  ) {
    this.transport = transport ?? nodemailer.createTransport(smtpTransportOptions(smtp));
  }

  async send(message: OtpMessage): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: "Your verification code",
      text: `Your verification code is ${message.code}. It expires in 5 minutes.`,
    });
    return { providerMessageId: info.messageId };
  }
}
