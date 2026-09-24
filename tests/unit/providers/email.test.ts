import { describe, expect, it } from "vitest";
import nodemailer from "nodemailer";
import { EmailProvider, type MailTransport } from "../../../apps/server/src/providers/email";

const SMTP = { host: "smtp.invalid", port: 25 };
const FROM = "OTPlease <no-reply@otplease.local>";

function recorder(result: { messageId?: string } = { messageId: "<abc@otplease.local>" }) {
  const sent: Parameters<MailTransport["sendMail"]>[0][] = [];
  const transport: MailTransport = { sendMail: async (mail) => (sent.push(mail), result) };
  return { sent, transport };
}

describe("EmailProvider", () => {
  it("sends one plain-text message with the code, to the right person", async () => {
    const { sent, transport } = recorder();
    const result = await new EmailProvider(SMTP, FROM, transport).send({ channel: "email", to: "user@example.com", code: "123456" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: FROM, to: "user@example.com", subject: "Your verification code" });
    expect(sent[0]!.text).toContain("123456");
    expect(sent[0]!.text).toMatch(/expires in 5 minutes/);
    expect(result.providerMessageId).toBe("<abc@otplease.local>");
  });

  it("keeps the code out of the subject line, which shows in notifications and logs", async () => {
    const { sent, transport } = recorder();
    await new EmailProvider(SMTP, FROM, transport).send({ channel: "email", to: "user@example.com", code: "654321" });
    expect(sent[0]!.subject).not.toContain("654321");
  });

  it("sends plain text only, so a code can never be rendered as markup", async () => {
    const { sent, transport } = recorder();
    await new EmailProvider(SMTP, FROM, transport).send({ channel: "email", to: "user@example.com", code: "123456" });
    expect(Object.keys(sent[0]!).sort()).toEqual(["from", "subject", "text", "to"]);
  });

  it("lets transport failures reach the caller, so the queue can retry or fall back", async () => {
    const failing: MailTransport = { sendMail: async () => { throw new Error("connection refused"); } };
    await expect(new EmailProvider(SMTP, FROM, failing).send({ channel: "email", to: "user@example.com", code: "123456" })).rejects.toThrow("connection refused");
  });

  it("builds a well-formed real message with nodemailer's offline transport", async () => {
    const offline = nodemailer.createTransport({ jsonTransport: true }) as unknown as MailTransport;
    const result = await new EmailProvider(SMTP, FROM, offline).send({ channel: "email", to: "user@example.com", code: "123456" });
    expect(result.providerMessageId).toBeTruthy();
  });

  it("does not let a recipient with line breaks add headers (header injection)", async () => {
    const offline = nodemailer.createTransport({ jsonTransport: true });
    const info = (await offline.sendMail({
      from: FROM,
      to: "victim@example.com\r\nBcc: attacker@evil.example",
      subject: "Your verification code",
      text: "code 123456",
    })) as unknown as { message: string };
    const message = JSON.parse(info.message);
    // whatever nodemailer does with it, no separate Bcc header may exist
    expect(message.bcc).toBeUndefined();
    expect(JSON.stringify(message.headers ?? {})).not.toMatch(/bcc/i);
  });
});
