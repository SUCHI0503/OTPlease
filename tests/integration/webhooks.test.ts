import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../../apps/server/src/lib/prisma";
import { decrypt } from "../../apps/server/src/lib/secretbox";
import {
  EVENT_ID_HEADER, ReplayGuard, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook,
} from "../../apps/server/src/lib/webhook-signature";
import { MockProvider } from "../../apps/server/src/providers";
import { postWebhook } from "../../apps/server/src/lib/webhook-http";
import { createWebhookWorker } from "../../apps/worker/src/webhook-worker";
import { createOtpWorker } from "../../apps/worker/src/otp-worker";
import { createWebhookEmitter, createWebhookQueue } from "../../apps/server/src/queue/webhook-queue";
import { buildTestApp, flushTestRedis, waitFor, waitForOutbox } from "../helpers";

const PHONE = "+919876543210";
const mock = new MockProvider();
const app = buildTestApp({ logger: false, webhookQueue: { attempts: 3, backoffMs: 50 } });
const webhookWorker = createWebhookWorker();
const emitQueue = createWebhookQueue({ attempts: 1 });
const otpWorker = createOtpWorker({ sms: mock, whatsapp: mock, voice: mock, email: mock }, createWebhookEmitter(prisma, emitQueue));

// A real receiver on localhost that records what it gets and can be told to fail
interface Received { headers: http.IncomingHttpHeaders; body: string }
const received: Received[] = [];
let failNext = 0;
let server: http.Server;
let receiverUrl: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      if (failNext > 0) {
        failNext--;
        res.statusCode = 500;
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
  received.length = 0;
  failNext = 0;
  mock.outbox.length = 0;
  await prisma.webhookLog.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.delivery.deleteMany();
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await webhookWorker.close();
  await otpWorker.close();
  await emitQueue.close();
  await app.close();
  await new Promise((r) => server.close(r));
});

async function createApplication(name = "Zomato") {
  return ((await app.inject({ method: "POST", url: "/applications", payload: { name } })).json() as { id: string }).id;
}

async function createWebhook(applicationId: string, events: string[] = ["otp.verified"], url = receiverUrl) {
  const res = await app.inject({ method: "POST", url: `/applications/${applicationId}/webhooks`, payload: { url, events } });
  return { res, body: res.json() as { id: string; secret: string } };
}

/** Logs in with a real request+verify, which fires otp.verified */
async function verifyOtp(applicationId: string) {
  // the otp worker is not needed for the code: read the code from the queue's mock via a direct request
  await app.inject({ method: "POST", url: `/applications/${applicationId}/otp/request`, payload: { phone: PHONE } });
  await waitForOutbox(mock, 1);
  return app.inject({
    method: "POST",
    url: `/applications/${applicationId}/otp/verify`,
    payload: { phone: PHONE, code: mock.lastCodeFor(PHONE) },
  });
}

describe("webhook management", () => {
  it("shows the signing secret once and stores it encrypted", async () => {
    const id = await createApplication();
    const { res, body } = await createWebhook(id);
    expect(res.statusCode).toBe(201);
    expect(body.secret).toMatch(/^whsec_/);

    const row = await prisma.webhookEndpoint.findFirstOrThrow();
    expect(row.secretEnc).not.toContain(body.secret);
    expect(decrypt(row.secretEnc)).toBe(body.secret);

    const list = await app.inject({ method: "GET", url: `/applications/${id}/webhooks` });
    expect(list.body).not.toContain(body.secret);
    expect(list.body).not.toContain(row.secretEnc);
  });

  it("validates input", async () => {
    const id = await createApplication();
    const post = (payload: object) => app.inject({ method: "POST", url: `/applications/${id}/webhooks`, payload });
    expect((await post({ url: receiverUrl, events: [] })).statusCode).toBe(400);
    expect((await post({ url: receiverUrl, events: ["nope"] })).statusCode).toBe(400);
    expect((await post({ url: "not a url", events: ["otp.verified"] })).statusCode).toBe(400);
    expect((await post({ url: "ftp://x.example.com", events: ["otp.verified"] })).json().error.code).toBe("INVALID_WEBHOOK_URL");
  });

  it("requires the webhooks:manage scope and keeps tenants apart", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const admin = { "x-admin-token": process.env.ADMIN_TOKEN! };
    const keyRes = await app.inject({
      method: "POST", url: `/applications/${a}/api-keys`, headers: admin,
      payload: { name: "k", scopes: ["otp:request"] },
    });
    const weak = { "x-api-key": (keyRes.json() as { key: string }).key };
    expect((await app.inject({ method: "GET", url: `/applications/${a}/webhooks`, headers: weak })).statusCode).toBe(403);

    const strongRes = await app.inject({
      method: "POST", url: `/applications/${a}/api-keys`, headers: admin,
      payload: { name: "k2", scopes: ["webhooks:manage"] },
    });
    const strong = { "x-api-key": (strongRes.json() as { key: string }).key };
    expect((await app.inject({ method: "GET", url: `/applications/${a}/webhooks`, headers: strong })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/applications/${b}/webhooks`, headers: strong })).statusCode).toBe(403);
  });
});

describe("webhook delivery (Phase 12)", () => {
  it("delivers a signed event a receiver can verify, and rejects a replay of it", async () => {
    const id = await createApplication();
    const { body: hook } = await createWebhook(id);
    expect((await verifyOtp(id)).statusCode).toBe(200);
    await waitFor(() => received.length === 1);

    const r = received[0]!;
    const verdict = verifyWebhook({
      secret: hook.secret,
      body: r.body,
      timestamp: r.headers[TIMESTAMP_HEADER] as string,
      signature: r.headers[SIGNATURE_HEADER] as string,
    });
    expect(verdict).toEqual({ ok: true });
    const event = JSON.parse(r.body);
    expect(event).toMatchObject({ type: "otp.verified", applicationId: id });
    expect(r.headers[EVENT_ID_HEADER]).toBe(event.id);

    // A receiver that tracks event ids accepts it once, then rejects the duplicate
    const guard = new ReplayGuard();
    expect(guard.firstTime(event.id)).toBe(true);
    expect(guard.firstTime(event.id)).toBe(false);

    // An attacker replaying the captured request much later fails the timestamp check
    const later = Math.floor(Date.now() / 1000) + 3600;
    expect(
      verifyWebhook({
        secret: hook.secret, body: r.body, timestamp: r.headers[TIMESTAMP_HEADER] as string,
        signature: r.headers[SIGNATURE_HEADER] as string, nowSeconds: later,
      })
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("never puts OTP codes or full phone numbers in the payload", async () => {
    const id = await createApplication();
    await createWebhook(id, ["otp.verified", "delivery.sent"]);
    await verifyOtp(id);
    await waitFor(() => received.length >= 2);
    const code = mock.lastCodeFor(PHONE)!;
    for (const r of received) {
      expect(r.body).not.toContain(code);
      expect(r.body).not.toContain("9876543210");
    }
    expect(received.map((r) => JSON.parse(r.body).type).sort()).toEqual(["delivery.sent", "otp.verified"]);
  });

  it("retries a failing receiver with the same event id and a fresh signature", async () => {
    const id = await createApplication();
    const { body: hook } = await createWebhook(id);
    failNext = 2;
    await verifyOtp(id);
    await waitFor(() => received.length === 3, 8000);

    const ids = new Set(received.map((r) => r.headers[EVENT_ID_HEADER]));
    expect(ids.size).toBe(1);
    for (const r of received) {
      expect(
        verifyWebhook({ secret: hook.secret, body: r.body, timestamp: r.headers[TIMESTAMP_HEADER] as string, signature: r.headers[SIGNATURE_HEADER] as string }).ok
      ).toBe(true);
    }

    await waitFor(async () => (await prisma.webhookLog.findFirstOrThrow()).status === "success");
    expect((await prisma.webhookLog.findFirstOrThrow()).attempts).toBe(3);
  });

  it("gives up and records the failure after all attempts", async () => {
    const id = await createApplication();
    const { body: hook } = await createWebhook(id);
    failNext = 99;
    await verifyOtp(id);
    await waitFor(async () => (await prisma.webhookLog.findFirst())?.status === "failed", 8000);

    const logs = await app.inject({ method: "GET", url: `/applications/${id}/webhooks/${hook.id}/logs` });
    expect(logs.json()[0]).toMatchObject({ status: "failed", attempts: 3, lastStatusCode: 500 });
  });

  it("only sends events the endpoint subscribed to", async () => {
    const id = await createApplication();
    await createWebhook(id, ["delivery.failed"]);
    await verifyOtp(id);
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);
  });

  it("stops delivering to a revoked endpoint", async () => {
    const id = await createApplication();
    const { body: hook } = await createWebhook(id);
    expect((await app.inject({ method: "DELETE", url: `/applications/${id}/webhooks/${hook.id}` })).statusCode).toBe(204);
    await verifyOtp(id);
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);
  });

  it("does not deliver one tenant's events to another tenant's endpoint", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    await createWebhook(b);
    await verifyOtp(a);
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(0);
  });

  it("never throws when queuing fails, so login and message sending are unaffected", async () => {
    const brokenPrisma = {
      webhookEndpoint: { findMany: async () => { throw new Error("database down"); } },
    } as unknown as typeof prisma;
    const emit = createWebhookEmitter(brokenPrisma, emitQueue);
    await expect(emit("app", "otp.verified", {})).resolves.toBeUndefined();
  });

  it("refuses to connect to a private address at send time when private urls are not allowed", async () => {
    await expect(
      postWebhook(receiverUrl, {}, "{}", { allowPrivate: false })
    ).rejects.toThrow(/private address/);
    expect(received).toHaveLength(0);
    // and the same call succeeds when explicitly allowed (dev/test)
    expect(await postWebhook(receiverUrl, {}, "{}", { allowPrivate: true })).toBe(200);
  });

  it("does not follow redirects to internal addresses", async () => {
    const redirector = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", receiverUrl);
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/`;
    expect(await postWebhook(url, {}, "{}", { allowPrivate: true })).toBe(302);
    expect(received).toHaveLength(0);
    await new Promise((r) => redirector.close(r));
  });
});
