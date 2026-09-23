import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../apps/server/src/app";
import { prisma } from "../../apps/server/src/lib/prisma";
import { MockProvider } from "../../apps/server/src/providers";

const mock = new MockProvider();
const app = buildApp({ logger: false, providers: { sms: mock, email: mock } });
const PHONE = "+919876543210";

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  mock.outbox.length = 0;
  await prisma.session.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.application.deleteMany();
});

afterAll(async () => {
  await app.close();
});

const post = (url: string, payload?: object, headers?: Record<string, string>) =>
  app.inject({ method: "POST", url, payload, headers });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function login() {
  const created = await post("/applications", { name: "Zomato" });
  const id = (created.json() as { id: string }).id;
  await post(`/applications/${id}/otp/request`, { phone: PHONE });
  const res = await post(`/applications/${id}/otp/verify`, { phone: PHONE, code: mock.lastCodeFor(PHONE) });
  return { applicationId: id, ...(res.json() as { userId: string; accessToken: string; refreshToken: string }) };
}

describe("sessions (Phase 7)", () => {
  it("verify returns tokens that authenticate /auth/me", async () => {
    const s = await login();
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(s.accessToken) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ userId: s.userId, applicationId: s.applicationId });
  });

  it("logout invalidates the session on the server, even for a still-valid access token", async () => {
    const s = await login();
    expect((await post("/auth/logout", undefined, bearer(s.accessToken))).statusCode).toBe(204);

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(s.accessToken) });
    expect(me.statusCode).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: s.refreshToken })).statusCode).toBe(401);
  });

  it("rejects missing, malformed and tampered tokens", async () => {
    const s = await login();
    const get = (h?: Record<string, string>) => app.inject({ method: "GET", url: "/auth/me", headers: h });
    expect((await get()).statusCode).toBe(401);
    expect((await get(bearer("garbage"))).statusCode).toBe(401);
    expect((await get(bearer(s.accessToken.slice(0, -3) + "abc"))).statusCode).toBe(401);
  });

  it("refresh rotates the token and the new access token works", async () => {
    const s = await login();
    const res = await post("/auth/refresh", { refreshToken: s.refreshToken });
    expect(res.statusCode).toBe(200);
    const next = res.json() as { accessToken: string; refreshToken: string };
    expect(next.refreshToken).not.toBe(s.refreshToken);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(next.accessToken) });
    expect(me.statusCode).toBe(200);
  });

  it("reusing an old refresh token is rejected and revokes the session", async () => {
    const s = await login();
    const next = (await post("/auth/refresh", { refreshToken: s.refreshToken })).json() as {
      accessToken: string;
      refreshToken: string;
    };
    expect((await post("/auth/refresh", { refreshToken: s.refreshToken })).statusCode).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: next.refreshToken })).statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(next.accessToken) });
    expect(me.statusCode).toBe(401);
  });

  it("only one of many parallel refreshes with the same token succeeds", async () => {
    const s = await login();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post("/auth/refresh", { refreshToken: s.refreshToken }))
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it("rejects an expired session", async () => {
    const s = await login();
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: bearer(s.accessToken) });
    expect(me.statusCode).toBe(401);
    expect((await post("/auth/refresh", { refreshToken: s.refreshToken })).statusCode).toBe(401);
  });

  it("does not store the refresh token in plaintext", async () => {
    const s = await login();
    const row = await prisma.session.findFirstOrThrow();
    expect(s.refreshToken).not.toContain(row.refreshHash);
    expect(row.refreshHash).not.toBe(s.refreshToken.split(".")[1]);
  });
});
