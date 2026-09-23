import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../../apps/server/src/lib/prisma";
import { MockProvider, type OtpMessage, type ProviderRegistry } from "../../apps/server/src/providers";
import { createOtpWorker } from "../../apps/worker/src/otp-worker";
import { flushTestRedis, waitFor, buildTestApp } from "../helpers";

const PHONE = "+919876543210";

/** A provider that fails on chosen channels, so fallback can be tested without any network */
class ChannelMock extends MockProvider {
  failing = new Set<string>();
  override async send(message: OtpMessage) {
    if (this.failing.has(message.channel)) throw new Error(`${message.channel} down`);
    return super.send(message);
  }
}

const mock = new ChannelMock();
const providers: ProviderRegistry = { sms: mock, whatsapp: mock, voice: mock, email: mock };
const worker = createOtpWorker(providers);
const app = buildTestApp({ logger: false, queue: { attempts: 2, backoffMs: 50 } });

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
  mock.outbox.length = 0;
  mock.failing.clear();
  await prisma.apiKey.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.device.deleteMany();
  await prisma.seenIp.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await worker.close();
  await app.close();
});

const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });

async function createApplication(name = "Zomato") {
  return ((await post("/applications", { name })).json() as { id: string }).id;
}

async function requestOtp(applicationId: string, extra: object = {}) {
  const res = await post(`/applications/${applicationId}/otp/request`, { phone: PHONE, ...extra });
  return res.json() as { deliveryId: string };
}

const getDelivery = async (applicationId: string, id: string) =>
  app.inject({ method: "GET", url: `/applications/${applicationId}/deliveries/${id}` });

describe("channels, fallback and delivery status (Phase 10)", () => {
  it("sends over WhatsApp when requested and records it as sent", async () => {
    const id = await createApplication();
    const { deliveryId } = await requestOtp(id, { channel: "whatsapp" });
    await waitFor(() => mock.outbox.length === 1);
    expect(mock.outbox[0]).toMatchObject({ channel: "whatsapp", to: PHONE });

    await waitFor(async () => (await getDelivery(id, deliveryId)).json().status === "sent");
    const body = (await getDelivery(id, deliveryId)).json();
    expect(body).toMatchObject({ requestedChannel: "whatsapp", channel: "whatsapp", status: "sent" });
    expect(body.toMasked).not.toContain("9876543210");
    expect(body.providerMessageId).toBeUndefined();
  });

  it("supports voice", async () => {
    const id = await createApplication();
    await requestOtp(id, { channel: "voice" });
    await waitFor(() => mock.outbox.length === 1);
    expect(mock.outbox[0]!.channel).toBe("voice");
  });

  it("falls back to the next channel when the first fails", async () => {
    mock.failing.add("whatsapp");
    const id = await createApplication();
    const { deliveryId } = await requestOtp(id, { channel: "whatsapp", fallback: ["sms", "voice"] });
    await waitFor(() => mock.outbox.length === 1);
    expect(mock.outbox[0]!.channel).toBe("sms");

    await waitFor(async () => (await getDelivery(id, deliveryId)).json().status === "sent");
    expect((await getDelivery(id, deliveryId)).json()).toMatchObject({ requestedChannel: "whatsapp", channel: "sms" });
  });

  it("does not fall back unless asked to", async () => {
    mock.failing.add("whatsapp");
    const id = await createApplication();
    const { deliveryId } = await requestOtp(id, { channel: "whatsapp" });
    await waitFor(async () => (await getDelivery(id, deliveryId)).json().status === "failed", 8000);
    expect(mock.outbox).toHaveLength(0);
  });

  it("marks the delivery failed with a safe error once every channel and retry is exhausted", async () => {
    mock.failing.add("whatsapp").add("sms");
    const id = await createApplication();
    const { deliveryId } = await requestOtp(id, { channel: "whatsapp", fallback: ["sms"] });
    await waitFor(async () => (await getDelivery(id, deliveryId)).json().status === "failed", 8000);
    const body = (await getDelivery(id, deliveryId)).json();
    expect(body.attempts).toBe(2);
    expect(body.error).toContain("sms down");
    expect(body.error).not.toContain("9876543210");
  });

  it("rejects an unknown channel or fallback", async () => {
    const id = await createApplication();
    expect((await post(`/applications/${id}/otp/request`, { phone: PHONE, channel: "pigeon" })).statusCode).toBe(400);
    expect(
      (await post(`/applications/${id}/otp/request`, { phone: PHONE, fallback: ["email"] })).statusCode
    ).toBe(400);
  });

  it("keeps delivery status private to its own application", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const { deliveryId } = await requestOtp(a);
    expect((await getDelivery(b, deliveryId)).statusCode).toBe(404);
    expect((await getDelivery(a, deliveryId)).statusCode).toBe(200);
  });
});

describe("Twilio status callbacks", () => {
  const URL_ = process.env.TWILIO_STATUS_CALLBACK_URL!;
  const sign = (params: Record<string, string>, token = process.env.TWILIO_AUTH_TOKEN!) =>
    crypto
      .createHmac("sha1", token)
      .update(URL_ + Object.keys(params).sort().map((k) => k + params[k]).join(""))
      .digest("base64");

  const callback = (params: Record<string, string>, signature = sign(params)) =>
    app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      payload: new URLSearchParams(params).toString(),
    });

  async function sentDelivery() {
    const id = await createApplication();
    const { deliveryId } = await requestOtp(id);
    await waitFor(async () => (await getDelivery(id, deliveryId)).json().status === "sent");
    const row = await prisma.delivery.update({ where: { id: deliveryId }, data: { providerMessageId: "SMabc" } });
    return { id, deliveryId, row };
  }

  it("updates the delivery to delivered on a correctly signed callback", async () => {
    const { id, deliveryId } = await sentDelivery();
    const res = await callback({ MessageSid: "SMabc", MessageStatus: "delivered" });
    expect(res.statusCode).toBe(204);
    expect((await getDelivery(id, deliveryId)).json().status).toBe("delivered");
  });

  it("rejects a bad or missing signature and changes nothing", async () => {
    const { id, deliveryId } = await sentDelivery();
    const params = { MessageSid: "SMabc", MessageStatus: "delivered" };
    expect((await callback(params, "forged")).statusCode).toBe(403);
    expect((await callback(params, sign(params, "wrong-token"))).statusCode).toBe(403);
    expect((await getDelivery(id, deliveryId)).json().status).toBe("sent");
  });

  it("marks failures, and never moves a delivered message backwards", async () => {
    const { id, deliveryId } = await sentDelivery();
    await callback({ MessageSid: "SMabc", MessageStatus: "delivered" });
    await callback({ MessageSid: "SMabc", MessageStatus: "sent" }); // late, out of order
    await callback({ MessageSid: "SMabc", MessageStatus: "failed" }); // cannot undo a delivery
    expect((await getDelivery(id, deliveryId)).json().status).toBe("delivered");
  });

  it("records a failed callback for a message still in sent state", async () => {
    const { id, deliveryId } = await sentDelivery();
    await callback({ MessageSid: "SMabc", MessageStatus: "undelivered" });
    expect((await getDelivery(id, deliveryId)).json().status).toBe("failed");
  });

  it("ignores callbacks for unknown message ids", async () => {
    expect((await callback({ MessageSid: "SMnope", MessageStatus: "delivered" })).statusCode).toBe(204);
  });
});
