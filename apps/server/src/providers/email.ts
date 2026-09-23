import nodemailer from "nodemailer";
import type { OtpMessage, OtpProvider } from "./types";

export class EmailProvider implements OtpProvider {
  private transport;

  constructor(
    smtp: { host: string; port: number },
    private from: string
  ) {
    this.transport = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: false });
  }

  async send(message: OtpMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: "Your verification code",
      text: `Your verification code is ${message.code}. It expires in 5 minutes.`,
    });
  }
}
