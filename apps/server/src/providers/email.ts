import nodemailer from "nodemailer";
import type { OtpMessage, OtpProvider, SendResult } from "./types";

/** The one thing we need from a mail transport, so tests can substitute one that never touches the network. */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<{ messageId?: string }>;
}

export class EmailProvider implements OtpProvider {
  private transport: MailTransport;

  constructor(
    smtp: { host: string; port: number },
    private from: string,
    transport?: MailTransport
  ) {
    this.transport = transport ?? nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: false });
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
