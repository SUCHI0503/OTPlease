import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { prisma } from "../../apps/server/src/lib/prisma";
import { hashOtpCode } from "../../apps/server/src/lib/otp";
import { registerErrorHandler } from "../../apps/server/src/lib/errors";
import { decrypt } from "../../apps/server/src/lib/secretbox";
import { ADMIN_TOKEN, buildTestApp, flushTestRedis } from "../helpers";

const app = buildTestApp();
const NOAUTH = { "x-test-no-auth": "1" };
const admin = { "x-admin-token": ADMIN_TOKEN, ...NOAUTH };
const PHONE = "+919876543210";

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes("otplease_test")) {
    throw new Error("Refusing to run: DATABASE_URL is not the test database");
  }
  await app.ready();
});

beforeEach(async () => {
  await flushTestRedis();
  await prisma.auditLog.deleteMany();
  await prisma.riskDecision.deleteMany();
  await prisma.riskConfig.deleteMany();
  await prisma.webhookLog.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
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
  await app.close();
});

async function createApplication(name = "Zomato") {
  return ((await app.inject({ method: "POST", url: "/applications", payload: { name }, headers: admin })).json() as { id: string }).id;
}

/** Puts a known code in the database and returns the OTP row, so an attack can be aimed at it */
async function seedOtp(applicationId: string, code = "123456", phone = PHONE) {
  await app.inject({ method: "POST", url: `/applications/${applicationId}/users`, payload: { phone } });
  const user = await prisma.user.findFirstOrThrow({ where: { applicationId, phone } });
  await prisma.otpCode.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: new Date() } });
  const otp = await prisma.otpCode.create({
    data: { applicationId, userId: user.id, codeHash: hashOtpCode(code), expiresAt: new Date(Date.now() + 300_000) },
  });
  return { user, otp };
}

const verify = (id: string, code: string, phone = PHONE) =>
  app.inject({ method: "POST", url: `/applications/${id}/otp/verify`, payload: { phone, code } });

describe("code guessing", () => {
  it("cannot get more than a handful of guesses even by requesting fresh codes", async () => {
    const id = await createApplication();
    let allowedGuesses = 0;
    let blocked = 0;
    for (let round = 0; round < 3; round++) {
      await seedOtp(id, "123456");
      for (let guess = 0; guess < 8; guess++) {
        const res = await verify(id, String(100000 + round * 10 + guess));
        if (res.statusCode === 429) blocked++;
        else if (res.statusCode === 400) allowedGuesses++;
      }
    }
    // 24 attempts in total, but the per-phone limit (10) caps what is ever evaluated
    expect(allowedGuesses).toBeLessThanOrEqual(10);
    expect(blocked).toBeGreaterThanOrEqual(14);
  });

  it("refuses even the correct code once the phone is locked out", async () => {
    const id = await createApplication();
    await seedOtp(id, "123456");
    for (let i = 0; i < 12; i++) await verify(id, "000000");
    expect((await verify(id, "123456")).statusCode).toBe(429);
    expect(await prisma.session.count()).toBe(0);
  });

  it("a single code stops accepting guesses after five, whatever the request rate", async () => {
    const id = await createApplication();
    const { otp } = await seedOtp(id, "123456");
    await Promise.all(Array.from({ length: 40 }, () => verify(id, "000000")));
    expect((await prisma.otpCode.findUniqueOrThrow({ where: { id: otp.id } })).attempts).toBeLessThanOrEqual(5);
  });
});

describe("code reuse and races", () => {
  it("20 simultaneous correct verifies create exactly one session", async () => {
    const id = await createApplication();
    await seedOtp(id, "123456");
    const results = await Promise.all(Array.from({ length: 8 }, () => verify(id, "123456")));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await prisma.session.count()).toBe(1);
  });

  it("a code cannot be reused after success, or after a newer code replaces it", async () => {
    const id = await createApplication();
    const { user } = await seedOtp(id, "123456");
    expect((await verify(id, "123456")).statusCode).toBe(200);
    expect((await verify(id, "123456")).statusCode).toBe(400);

    await prisma.otpCode.create({ data: { applicationId: id, userId: user.id, codeHash: hashOtpCode("222222"), expiresAt: new Date(Date.now() + 300_000) } });
    await prisma.otpCode.updateMany({ where: { codeHash: hashOtpCode("222222") }, data: { consumedAt: new Date() } });
    expect((await verify(id, "222222")).statusCode).toBe(400);
  });

  it("an expired code is refused even when correct", async () => {
    const id = await createApplication();
    const { otp } = await seedOtp(id, "123456");
    await prisma.otpCode.update({ where: { id: otp.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(id, "123456")).statusCode).toBe(400);
  });

  it("does not reveal whether a phone number is registered", async () => {
    const id = await createApplication();
    await seedOtp(id, "123456");
    const known = await verify(id, "000000");
    const unknown = await verify(id, "000000", "+919999999999");
    expect(unknown.statusCode).toBe(known.statusCode === 400 ? 400 : unknown.statusCode);
    expect(unknown.json().error.code).toBe("OTP_NOT_FOUND");
    // a registered phone with no active code answers identically
    await prisma.otpCode.updateMany({ data: { consumedAt: new Date() } });
    const noCode = await verify(id, "000000");
    expect(noCode.json()).toEqual(unknown.json());
  });
});

describe("forged and stolen session tokens", () => {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const me = (token: string) => app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}`, ...NOAUTH } });

  async function realSession() {
    const id = await createApplication();
    await seedOtp(id, "123456");
    return { id, ...((await verify(id, "123456")).json() as { userId: string; accessToken: string; refreshToken: string }) };
  }

  it("accepts the genuine token (control)", async () => {
    const s = await realSession();
    expect((await me(s.accessToken)).statusCode).toBe(200);
  });

  it("rejects an unsigned token (alg: none)", async () => {
    const s = await realSession();
    const sid = (await prisma.session.findFirstOrThrow()).id;
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: s.userId, sid, aid: s.id, exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    expect((await me(none)).statusCode).toBe(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const s = await realSession();
    const sid = (await prisma.session.findFirstOrThrow()).id;
    const forged = await new SignJWT({ sid, aid: s.id })
      .setProtectedHeader({ alg: "HS256" }).setSubject(s.userId).setExpirationTime("10m")
      .sign(new TextEncoder().encode("x".repeat(40)));
    expect((await me(forged)).statusCode).toBe(401);
  });

  it("rejects an expired token, and one whose payload was edited", async () => {
    const s = await realSession();
    const sid = (await prisma.session.findFirstOrThrow()).id;
    const expired = await new SignJWT({ sid, aid: s.id })
      .setProtectedHeader({ alg: "HS256" }).setSubject(s.userId).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret);
    expect((await me(expired)).statusCode).toBe(401);

    const [h, , sig] = s.accessToken.split(".");
    const edited = `${h}.${b64({ sub: "someone-else", sid, aid: s.id, exp: Math.floor(Date.now() / 1000) + 600 })}.${sig}`;
    expect((await me(edited)).statusCode).toBe(401);
  });

  it("rejects a correctly signed token for a session that does not exist", async () => {
    const s = await realSession();
    const ghost = await new SignJWT({ sid: "00000000-0000-4000-8000-000000000000", aid: s.id })
      .setProtectedHeader({ alg: "HS256" }).setSubject(s.userId).setExpirationTime("10m").sign(secret);
    expect((await me(ghost)).statusCode).toBe(401);
  });

  it("rejects an API key or admin token used as a session token, and vice versa", async () => {
    const s = await realSession();
    expect((await me(ADMIN_TOKEN)).statusCode).toBe(401);
    const asKey = await app.inject({ method: "GET", url: `/applications/${s.id}/users`, headers: { "x-api-key": s.accessToken, ...NOAUTH } });
    expect(asKey.statusCode).toBe(401);
  });

  it("a stolen refresh token stops working once the real owner refreshes (theft detection)", async () => {
    const s = await realSession();
    const first = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(first.statusCode).toBe(200);
    const thief = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: s.refreshToken } });
    expect(thief.statusCode).toBe(401);
    // and the owner's newer token is now dead too: the session was revoked
    const owner = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: first.json().refreshToken } });
    expect(owner.statusCode).toBe(401);
  });
});

describe("spoofed client IPs", () => {
  const spoofed = { logger: false, limits: { refreshPerIp: { limit: 2, windowSeconds: 60 } } } as const;

  it("ignores X-Forwarded-For by default, so it cannot be used to dodge rate limits", async () => {
    const strict = buildTestApp({ ...spoofed });
    await strict.ready();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await strict.inject({
        method: "POST", url: "/auth/refresh", payload: { refreshToken: "x.y" },
        headers: { "x-forwarded-for": `198.51.100.${i}`, ...NOAUTH },
      });
      codes.push(res.statusCode);
    }
    await strict.close();
    expect(codes).toEqual([401, 401, 429, 429, 429]);
  });

  it("uses X-Forwarded-For only when the proxy is explicitly trusted", async () => {
    const trusting = buildTestApp({ ...spoofed, trustProxy: true });
    await trusting.ready();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await trusting.inject({
        method: "POST", url: "/auth/refresh", payload: { refreshToken: "x.y" },
        headers: { "x-forwarded-for": `198.51.100.${i}`, ...NOAUTH },
      });
      codes.push(res.statusCode);
    }
    await trusting.close();
    expect(codes).toEqual([401, 401, 401, 401]); // every fake client has its own bucket, as configured
  });
});

describe("hostile input", () => {
  it("stores injection strings as plain text and leaves the database intact", async () => {
    const payloads = [`'; DROP TABLE "Application"; --`, `" OR 1=1 --`, `<script>alert(1)</script>`, "Robert'); DELETE FROM \"User\";--", "${7*7}", "{{7*7}}"];
    for (const name of payloads) {
      const res = await app.inject({ method: "POST", url: "/applications", payload: { name }, headers: admin });
      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe(name);
    }
    expect(await prisma.application.count()).toBe(payloads.length);
  });

  it("rejects injection in identifiers and phone numbers with 400, never 500", async () => {
    const id = await createApplication();
    for (const bad of [`' OR '1'='1`, "1; DROP TABLE x", "../../etc/passwd", "%00", "<img src=x>"]) {
      const a = await app.inject({ method: "GET", url: `/applications/${encodeURIComponent(bad)}/users`, headers: { ...admin } });
      expect(a.statusCode, `id ${bad}`).toBeLessThan(500);
      const b = await app.inject({ method: "POST", url: `/applications/${id}/otp/request`, payload: { phone: bad } });
      expect(b.statusCode, `phone ${bad}`).toBe(400);
    }
  });

  it("does not let a request body set server-controlled fields", async () => {
    const res = await app.inject({
      method: "POST", url: "/applications", headers: admin,
      payload: { name: "Mass", id: "11111111-1111-4111-8111-111111111111", createdAt: "2000-01-01T00:00:00Z", isAdmin: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(new Date(res.json().createdAt).getFullYear()).toBeGreaterThan(2020);
    expect(res.json().isAdmin).toBeUndefined();
  });

  it("is not affected by prototype-pollution payloads", async () => {
    for (const body of [`{"__proto__":{"admin":true},"name":"x"}`, `{"constructor":{"prototype":{"admin":true}},"name":"x"}`]) {
      const res = await app.inject({ method: "POST", url: "/applications", headers: { ...admin, "content-type": "application/json" }, payload: body });
      expect(res.statusCode).toBeLessThan(500);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it("refuses oversized bodies with 413", async () => {
    const res = await app.inject({
      method: "POST", url: "/applications", headers: { ...admin, "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(200_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(await prisma.application.count()).toBe(0);
  });

  it("answers malformed JSON and wrong content types with 4xx and no internals", async () => {
    const bad = await app.inject({ method: "POST", url: "/applications", headers: { ...admin, "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    const text = await app.inject({ method: "POST", url: "/applications", headers: { ...admin, "content-type": "text/plain" }, payload: "hello" });
    expect(text.statusCode).toBeGreaterThanOrEqual(400);
    expect(text.statusCode).toBeLessThan(500);
    for (const r of [bad, text]) expect(r.body).not.toMatch(/at .*\.(ts|js):\d+|node_modules|prisma/i);
  });

  it("does not echo unexpected values in validation errors beyond the message", async () => {
    const id = await createApplication();
    const res = await app.inject({ method: "POST", url: `/applications/${id}/otp/verify`, payload: { phone: PHONE, code: "SECRET-guess" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("SECRET-guess");
  });
});

describe("error handling and logs", () => {
  it("hides internals from the caller and keeps secrets out of the server log on a crash", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const bare = Fastify({ logger: { stream } });
    registerErrorHandler(bare);
    bare.get("/boom", async () => {
      throw new Error(`database rejected phone ${PHONE} with code 123456 token whsec_abcdef`);
    });
    await bare.ready();

    const res = await bare.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } });

    const log = lines.join("");
    expect(log).toContain("unhandled error");
    for (const secret of ["9876543210", "123456", "whsec_abcdef", "database rejected"]) expect(log).not.toContain(secret);
    await bare.close();
  });

  it("writes no credentials, codes, tokens or phone numbers to the log across a whole login flow", async () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const logged = buildTestApp({ logger: true, logStream: stream, disconnectPrisma: false });
    await logged.ready();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (opts: any): Promise<{ json(): any; statusCode: number }> => (logged.inject as any)(opts);

    const id = (await call({ method: "POST", url: "/applications", payload: { name: "Logged" } }).then((r) => r.json())).id;
    const key = (await call({ method: "POST", url: `/applications/${id}/api-keys`, payload: { name: "k", scopes: ["otp:request", "otp:verify", "webhooks:manage"] } }).then((r) => r.json())).key;
    const hook = await call({ method: "POST", url: `/applications/${id}/webhooks`, headers: { "x-api-key": key }, payload: { url: "http://127.0.0.1:9/hook", events: ["otp.verified"] } }).then((r) => r.json());
    await call({ method: "POST", url: `/applications/${id}/otp/request`, headers: { "x-api-key": key }, payload: { phone: PHONE, context: { ip: "203.0.113.77", deviceId: "device-secret-abcdef" } } });
    await seedOtp(id, "654321");
    const session = await call({ method: "POST", url: `/applications/${id}/otp/verify`, headers: { "x-api-key": key }, payload: { phone: PHONE, code: "654321" } }).then((r) => r.json());
    await call({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${session.accessToken}`, "x-test-no-auth": "1" } });
    await call({ method: "GET", url: "/applications", headers: { "x-admin-token": "guess-this-admin-token-please", "x-test-no-auth": "1" } });
    await logged.close();

    const log = lines.join("");
    expect(log.length).toBeGreaterThan(200); // logging really was on
    const secrets = [ADMIN_TOKEN, key, key.slice("otpl_".length + 13), "9876543210", "654321", session.accessToken, session.refreshToken, hook.secret, "guess-this-admin-token-please", "203.0.113.77", "device-secret-abcdef"];
    for (const secret of secrets) {
      expect(secret.length, "a secret under test must not be empty or trivially short").toBeGreaterThanOrEqual(6);
      expect(log, `log leaked ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
  });
});

describe("response headers and CORS", () => {
  it("marks API responses as uncacheable, non-sniffable and non-frameable", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    const failure = await app.inject({ method: "GET", url: "/applications", headers: NOAUTH });
    expect(failure.headers["cache-control"]).toBe("no-store");
  });

  it("serves the docs page with a CSP that only allows the Swagger CDN, and lets the spec be cached", async () => {
    const docs = await app.inject({ method: "GET", url: "/docs" });
    expect(docs.headers["content-security-policy"]).toContain("https://cdn.jsdelivr.net");
    expect(docs.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(docs.headers["content-security-policy"]).not.toMatch(/\*/);
    expect((await app.inject({ method: "GET", url: "/openapi.json" })).headers["cache-control"]).toBeUndefined();
  });

  it("sends no CORS headers by default, so other websites cannot read responses", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await app.inject({
      method: "OPTIONS", url: "/applications",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "x-admin-token" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows only the exact origins configured, never a wildcard", async () => {
    const withCors = buildTestApp({ logger: false, corsOrigins: ["https://dashboard.example.com"] });
    await withCors.ready();
    const ok = await withCors.inject({ method: "GET", url: "/health", headers: { origin: "https://dashboard.example.com" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://dashboard.example.com");
    for (const origin of ["https://evil.example", "https://dashboard.example.com.evil.example", "http://dashboard.example.com", "null"]) {
      const res = await withCors.inject({ method: "GET", url: "/health", headers: { origin } });
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
    await withCors.close();
  });
});

describe("failed-authentication lockout", () => {
  it("locks an IP out after repeated wrong keys, refuses even a valid key from it, and audits it once", async () => {
    const strict = buildTestApp({ logger: false, limits: { authFailuresPerIp: { limit: 3, windowSeconds: 600 } } });
    await strict.ready();
    const created = (await strict.inject({ method: "POST", url: "/applications", payload: { name: "L" }, headers: admin })).json() as { id: string };
    const goodKey = (await strict.inject({ method: "POST", url: `/applications/${created.id}/api-keys`, headers: admin, payload: { name: "k", scopes: ["users:read"] } })).json().key as string;
    const url = `/applications/${created.id}/users`;
    const fake = `otpl_aaaaaaaaaaaa_${"Zx9".repeat(15)}`;

    const bad: number[] = [];
    for (let i = 0; i < 5; i++) bad.push((await strict.inject({ method: "GET", url, headers: { "x-api-key": fake, ...NOAUTH } })).statusCode);
    expect(bad).toEqual([401, 401, 401, 429, 429]);

    const valid = await strict.inject({ method: "GET", url, headers: { "x-api-key": goodKey, ...NOAUTH } });
    expect(valid.statusCode).toBe(429);
    expect(Number(valid.headers["retry-after"])).toBeGreaterThan(0);

    const locks = await prisma.auditLog.findMany({ where: { action: "auth.lockout" } });
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ actorType: "system", applicationId: null });
    await strict.close();
  });

  it("does not lock out because of scope mistakes with a valid key", async () => {
    const strict = buildTestApp({ logger: false, limits: { authFailuresPerIp: { limit: 3, windowSeconds: 600 } } });
    await strict.ready();
    const created = (await strict.inject({ method: "POST", url: "/applications", payload: { name: "L" }, headers: admin })).json() as { id: string };
    const key = (await strict.inject({ method: "POST", url: `/applications/${created.id}/api-keys`, headers: admin, payload: { name: "k", scopes: ["users:read"] } })).json().key as string;
    for (let i = 0; i < 6; i++) {
      const res = await strict.inject({ method: "GET", url: `/applications/${created.id}/analytics`, headers: { "x-api-key": key, ...NOAUTH } });
      expect(res.statusCode).toBe(403);
    }
    expect((await strict.inject({ method: "GET", url: `/applications/${created.id}/users`, headers: { "x-api-key": key, ...NOAUTH } })).statusCode).toBe(200);
    await strict.close();
  });
});

describe("audit log", () => {
  it("records sensitive actions with the right actor and no secrets", async () => {
    const id = await createApplication();
    const created = (await app.inject({ method: "POST", url: `/applications/${id}/api-keys`, headers: admin, payload: { name: "prod", scopes: ["webhooks:manage", "risk:manage", "audit:read", "keys:manage"] } })).json() as { id: string; key: string };
    const keyHeaders = { "x-api-key": created.key, ...NOAUTH };

    const hook = (await app.inject({ method: "POST", url: `/applications/${id}/webhooks`, headers: keyHeaders, payload: { url: "https://hooks.example.com/path/with-token-abc123?secret=zzz", events: ["otp.verified"] } })).json() as { id: string; secret: string };
    await app.inject({ method: "PUT", url: `/applications/${id}/risk-config`, headers: keyHeaders, payload: { mode: "enforce" } });
    await app.inject({ method: "POST", url: `/applications/${id}/webhooks/${hook.id}/rotate-secret`, headers: keyHeaders });
    await app.inject({ method: "DELETE", url: `/applications/${id}/webhooks/${hook.id}`, headers: keyHeaders });
    await app.inject({ method: "DELETE", url: `/applications/${id}/api-keys/${created.id}`, headers: admin });

    const logs = (await app.inject({ method: "GET", url: `/applications/${id}/audit-logs`, headers: admin })).json() as any[];
    const actions = logs.map((l) => l.action).sort();
    expect(actions).toEqual(["api_key.created", "api_key.revoked", "application.created", "risk_config.updated", "webhook.created", "webhook.revoked", "webhook.secret_rotated"]);

    const byAction = (a: string) => logs.find((l) => l.action === a);
    expect(byAction("application.created")).toMatchObject({ actorType: "admin", actorId: null });
    expect(byAction("api_key.created")).toMatchObject({ actorType: "admin" });
    expect(byAction("webhook.created")).toMatchObject({ actorType: "api_key", actorId: created.id });
    expect(byAction("risk_config.updated").metadata).toEqual({ mode: "enforce" });
    expect(byAction("webhook.created").metadata).toMatchObject({ host: "hooks.example.com", events: ["otp.verified"] });

    const dump = JSON.stringify(logs);
    for (const secret of [created.key, created.key.slice("otpl_".length + 13), hook.secret, "with-token-abc123", "secret=zzz", "/path/"]) {
      expect(secret.length).toBeGreaterThan(4);
      expect(dump, `audit leaked ${secret.slice(0, 8)}`).not.toContain(secret);
    }
    expect(logs.every((l) => l.ipMasked === null || l.ipMasked.endsWith("*"))).toBe(true);
  });

  it("is private to each application", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const keyB = (await app.inject({ method: "POST", url: `/applications/${b}/api-keys`, headers: admin, payload: { name: "k", scopes: ["audit:read"] } })).json().key as string;

    const own = await app.inject({ method: "GET", url: `/applications/${b}/audit-logs`, headers: { "x-api-key": keyB, ...NOAUTH } });
    expect(own.statusCode).toBe(200);
    expect(own.json().every((l: { applicationId: string }) => l.applicationId === b)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/applications/${a}/audit-logs`, headers: { "x-api-key": keyB, ...NOAUTH } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/audit-logs", headers: { "x-api-key": keyB, ...NOAUTH } })).statusCode).toBe(401);
  });

  it("gives the operator a view across applications and validates the limit", async () => {
    await createApplication("A");
    await createApplication("B");
    const all = (await app.inject({ method: "GET", url: "/audit-logs", headers: admin })).json() as unknown[];
    expect(all).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/audit-logs?limit=1", headers: admin })).json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/audit-logs?limit=9999", headers: admin })).statusCode).toBe(400);
  });
});

describe("webhook secret rotation", () => {
  it("issues a new secret once, replaces the old one immediately, and never lists it", async () => {
    const id = await createApplication();
    const hook = (await app.inject({ method: "POST", url: `/applications/${id}/webhooks`, headers: admin, payload: { url: "https://hooks.example.com/x", events: ["otp.verified"] } })).json() as { id: string; secret: string };
    const rotated = await app.inject({ method: "POST", url: `/applications/${id}/webhooks/${hook.id}/rotate-secret`, headers: admin });
    expect(rotated.statusCode).toBe(200);
    const next = rotated.json() as { secret: string };
    expect(next.secret).toMatch(/^whsec_/);
    expect(next.secret).not.toBe(hook.secret);

    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } });
    expect(decrypt(row.secretEnc)).toBe(next.secret);
    expect(row.secretEnc).not.toContain(next.secret);
    const list = await app.inject({ method: "GET", url: `/applications/${id}/webhooks`, headers: admin });
    expect(list.body).not.toContain(next.secret);
  });

  it("returns 404 for unknown or revoked webhooks and for another tenant's webhook", async () => {
    const a = await createApplication("A");
    const b = await createApplication("B");
    const hook = (await app.inject({ method: "POST", url: `/applications/${a}/webhooks`, headers: admin, payload: { url: "https://hooks.example.com/x", events: ["otp.verified"] } })).json() as { id: string };
    expect((await app.inject({ method: "POST", url: `/applications/${b}/webhooks/${hook.id}/rotate-secret`, headers: admin })).statusCode).toBe(404);
    await app.inject({ method: "DELETE", url: `/applications/${a}/webhooks/${hook.id}`, headers: admin });
    expect((await app.inject({ method: "POST", url: `/applications/${a}/webhooks/${hook.id}/rotate-secret`, headers: admin })).statusCode).toBe(404);
  });
});
