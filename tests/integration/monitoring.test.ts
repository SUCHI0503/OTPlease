import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { buildApp } from "../../apps/server/src/app";
import { flushTestRedis, ADMIN_TOKEN } from "../helpers";
import { captureError, scrubEvent } from "../../apps/server/src/lib/sentry";

const app = buildApp({ logger: false });
const admin = { "x-admin-token": ADMIN_TOKEN };

beforeAll(async () => {
  await flushTestRedis();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("health checks", () => {
  it("liveness answers without touching anything else", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", service: "otplease-server" });
  });

  it("readiness is 200 when Postgres and Redis answer", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", checks: { database: "ok", cache: "ok" } });
  });

  it("readiness is 503, naming the component, when Redis is down, and leaks no detail", async () => {
    const broken = { ping: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:6379")), disconnect: () => {} } as unknown as Redis;
    const down = buildApp({ logger: false, redis: broken, disconnectPrisma: false });
    const res = await down.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "degraded", checks: { database: "ok", cache: "down" } });
    expect(res.body).not.toContain("10.0.0.5");
    await down.close();
  });
});

describe("metrics", () => {
  it("are for the operator only", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/metrics", headers: { "x-admin-token": "wrong" } })).statusCode).toBe(401);
  });

  it("count requests by route template, OTP activity and queue depth, without personal data", async () => {
    const created = await app.inject({ method: "POST", url: "/applications", headers: admin, payload: { name: "Metrics app" } });
    const { id } = created.json() as { id: string };
    const key = (await app.inject({ method: "POST", url: `/applications/${id}/api-keys`, headers: admin, payload: { name: "k", scopes: ["otp:request", "otp:verify"] } })).json() as { key: string };
    const phone = "+919812345678";
    const auth = { "x-api-key": key.key };

    expect((await app.inject({ method: "POST", url: `/applications/${id}/otp/request`, headers: auth, payload: { phone } })).statusCode).toBe(202);
    await app.inject({ method: "POST", url: `/applications/${id}/otp/verify`, headers: auth, payload: { phone, code: "000000" } });

    const res = await app.inject({ method: "GET", url: "/metrics", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toMatch(/otp_requests_total\{channel="sms"\} 1/);
    expect(res.body).toMatch(/otp_verifications_total\{result="incorrect"\} 1/);
    expect(res.body).toContain('route="/applications/:applicationId/otp/request"');
    expect(res.body).toMatch(/otp_queue_jobs\{state="waiting"\}/);
    expect(res.body).toContain("process_cpu_user_seconds_total");
    // Series are labelled by route template: no id, phone number or key ever appears
    expect(res.body).not.toContain(id);
    expect(res.body).not.toContain(phone);
    expect(res.body).not.toContain(key.key);
  });
});

describe("error reporting", () => {
  it("does nothing, and never throws, when no Sentry DSN is configured", () => {
    expect(() => captureError(new Error("boom +919812345678"))).not.toThrow();
  });

  it("strips request, user and exception messages from every event", () => {
    const event = scrubEvent({
      request: { headers: { "x-api-key": "otpl_secret" }, data: { phone: "+919812345678" } },
      user: { ip_address: "203.0.113.9" },
      exception: { values: [{ value: 'duplicate key value violates unique constraint "phone" (+919812345678)' }] },
    });
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.exception.values[0]!.value).toBe("[message removed]");
    expect(JSON.stringify(event)).not.toContain("919812345678");
  });
});
