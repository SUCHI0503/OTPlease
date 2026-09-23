import { flushTestRedis, startTestWorker, waitForOutbox } from "../helpers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app";
import { prisma } from "../../apps/server/src/lib/prisma";
import { MockProvider } from "../../apps/server/src/providers";

const mock = new MockProvider();
const worker = startTestWorker(mock);
const app = buildApp({ logger: false });
const PHONE = "+919876543210";

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
  mock.outbox.length = 0;
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await worker.close();
  await app.close();
});

async function createApplication() {
  const res = await app.inject({ method: "POST", url: "/applications", payload: { name: "Zomato" } });
  return (res.json() as { id: string }).id;
}

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

describe("request -> verify flow with the mock provider (Phase 6)", () => {
  it("sends the code via sms and verifies it", async () => {
    const id = await createApplication();
    const reqRes = await post(`/applications/${id}/otp/request`, { phone: PHONE });
    expect(reqRes.statusCode).toBe(202);
    await waitForOutbox(mock, 1);
    expect(mock.outbox).toHaveLength(1);
    expect(mock.outbox[0]).toMatchObject({ channel: "sms", to: PHONE });

    const code = mock.lastCodeFor(PHONE)!;
    const verifyRes = await post(`/applications/${id}/otp/verify`, { phone: PHONE, code });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().status).toBe("verified");
  });

  it("sends via the email channel to the given address", async () => {
    const id = await createApplication();
    await post(`/applications/${id}/otp/request`, { phone: PHONE, channel: "email", email: "A@Example.com" });
    await waitForOutbox(mock, 1);
    expect(mock.outbox[0]).toMatchObject({ channel: "email", to: "a@example.com" });

    const verifyRes = await post(`/applications/${id}/otp/verify`, { phone: PHONE, code: mock.outbox[0]!.code });
    expect(verifyRes.statusCode).toBe(200);
  });

  it("requires an email when channel is email", async () => {
    const id = await createApplication();
    const res = await post(`/applications/${id}/otp/request`, { phone: PHONE, channel: "email" });
    expect(res.statusCode).toBe(400);
    expect(mock.outbox).toHaveLength(0);
  });

  it("does not put the code in the request response", async () => {
    const id = await createApplication();
    const res = await post(`/applications/${id}/otp/request`, { phone: PHONE });
    await waitForOutbox(mock, 1);
    expect(res.body).not.toContain(mock.outbox[0]!.code);
  });

  it("only the newest code works after two requests", async () => {
    const id = await createApplication();
    await post(`/applications/${id}/otp/request`, { phone: PHONE });
    await waitForOutbox(mock, 1);
    await post(`/applications/${id}/otp/request`, { phone: PHONE });
    await waitForOutbox(mock, 2);
    const [first, second] = mock.outbox.map((m) => m.code);
    if (first !== second) {
      expect((await post(`/applications/${id}/otp/verify`, { phone: PHONE, code: first })).statusCode).toBe(400);
    }
    expect((await post(`/applications/${id}/otp/verify`, { phone: PHONE, code: second })).statusCode).toBe(200);
  });
});
