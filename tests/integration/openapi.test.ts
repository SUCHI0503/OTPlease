import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers";

const app = buildTestApp();
const NOAUTH = { "x-test-no-auth": "1" };

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

type Doc = { openapi: string; paths: Record<string, Record<string, any>>; components: any; webhooks: Record<string, unknown> };
const getDoc = async () => (await app.inject({ method: "GET", url: "/openapi.json", headers: NOAUTH })).json() as Doc;

describe("API docs (Phase 13)", () => {
  it("serves a valid-looking OpenAPI 3.1 document without authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json", headers: NOAUTH });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as Doc;
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).length).toBeGreaterThan(10);
  });

  it("documents every route the server actually registers, and nothing that does not exist", async () => {
    const doc = await getDoc();
    const toOpenApi = (url: string) => url.replace(/:(\w+)/g, "{$1}");
    const skip = new Set(["/docs", "/openapi.json"]);

    const actual = new Set(
      app.registeredRoutes
        .filter((r) => !skip.has(r.url) && r.method !== "HEAD" && r.method !== "OPTIONS")
        .map((r) => `${r.method.toLowerCase()} ${toOpenApi(r.url)}`)
    );
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`))
    );

    expect([...actual].filter((r) => !documented.has(r)), "routes missing from the docs").toEqual([]);
    expect([...documented].filter((r) => !actual.has(r)), "documented routes that do not exist").toEqual([]);
  });

  it("marks who can call each route", async () => {
    const { paths } = await getDoc();
    expect(paths["/applications"]!.post.security).toEqual([{ AdminToken: [] }]);
    expect(paths["/applications/{applicationId}/otp/request"]!.post["x-required-scope"]).toBe("otp:request");
    expect(paths["/auth/me"]!.get.security).toEqual([{ SessionBearer: [] }]);
    expect(paths["/health"]!.get.security).toEqual([]);
  });

  it("derives request bodies from the real validation schemas", async () => {
    const { paths } = await getDoc();
    const verify = paths["/applications/{applicationId}/otp/verify"]!.post.requestBody.content["application/json"].schema;
    expect(verify.properties.code.pattern).toBe("^\\d{6}$");
    expect(verify.required).toEqual(["phone", "code"]);
    const channels = paths["/applications/{applicationId}/otp/request"]!.post.requestBody.content["application/json"].schema.properties.channel.enum;
    expect(channels).toEqual(["sms", "whatsapp", "voice", "email"]);
  });

  it("documents the webhook events and how to verify them", async () => {
    const doc = await getDoc();
    expect(Object.keys(doc.webhooks).sort()).toEqual(["delivery.delivered", "delivery.failed", "delivery.sent", "otp.verified"]);
    expect(JSON.stringify(doc)).toContain("x-otplease-signature");
  });

  it("serves the Swagger UI page", async () => {
    const res = await app.inject({ method: "GET", url: "/docs", headers: NOAUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("/openapi.json");
  });
});
