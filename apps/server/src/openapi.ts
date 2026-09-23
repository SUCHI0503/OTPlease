import { z } from "zod";
import { RULE_CODES, riskConfigSchema } from "./lib/risk";
import { SCOPES } from "./lib/apikeys";
import { WEBHOOK_EVENTS } from "./queue/webhook-queue";
import {
  createApiKeySchema,
  createApplicationSchema,
  createUserSchema,
  createWebhookSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
} from "./lib/schemas";

// Request bodies come straight from the Zod schemas that validate them, so docs cannot drift from behaviour.
const schemaOf = (s: z.ZodType) => {
  const { $schema: _omit, ...json } = z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return json;
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object, description = "Success") => ({ description, content: { "application/json": { schema } } });
const errorResponse = (description: string) => json(ref("Error"), description);

type Auth = "admin" | "adminOrKey" | "key" | "session" | "signature" | "none";
interface Op {
  summary: string;
  description?: string;
  tag: string;
  auth: Auth;
  scope?: (typeof SCOPES)[number];
  body?: object;
  query?: boolean;
  ok: { status: string; response: object };
  extraErrors?: Record<string, string>;
}

const security: Record<Auth, object[]> = {
  admin: [{ AdminToken: [] }],
  adminOrKey: [{ ApiKey: [] }, { AdminToken: [] }],
  key: [{ ApiKey: [] }],
  session: [{ SessionBearer: [] }],
  signature: [],
  none: [],
};

const appId = { name: "applicationId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const pathParam = (name: string) => ({ name, in: "path", required: true, schema: { type: "string", format: "uuid" } });

function operation(path: string, o: Op) {
  const params: object[] = [];
  if (path.includes("{applicationId}")) params.push(appId);
  for (const p of ["userId", "keyId", "webhookId", "deliveryId"]) if (path.includes(`{${p}}`)) params.push(pathParam(p));
  if (o.query) params.push({ name: "days", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 30, default: 7 } });

  const errors: Record<string, object> = { "400": errorResponse("Validation error") };
  if (o.auth !== "none") errors["401"] = errorResponse("Missing or invalid credentials");
  if (o.auth === "key" || o.auth === "adminOrKey") errors["403"] = errorResponse("Key lacks the required scope or belongs to another application");
  for (const [code, text] of Object.entries(o.extraErrors ?? {})) errors[code] = errorResponse(text);

  return {
    summary: o.summary,
    ...(o.description ? { description: o.description } : {}),
    tags: [o.tag],
    ...(o.scope ? { "x-required-scope": o.scope } : {}),
    security: security[o.auth],
    ...(params.length ? { parameters: params } : {}),
    ...(o.body ? { requestBody: { required: true, content: { "application/json": { schema: o.body } } } } : {}),
    responses: { [o.ok.status]: o.ok.response, ...errors },
  };
}

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, object>> = {};
  const add = (method: string, path: string, o: Op) => ((paths[path] ??= {})[method] = operation(path, o));
  const noContent = { status: "204", response: { description: "Done" } };
  const A = "/applications/{applicationId}";

  add("get", "/health", { summary: "Health check", tag: "System", auth: "none", ok: { status: "200", response: json({ type: "object" }) } });

  add("post", "/applications", { summary: "Create an application (tenant)", tag: "Applications", auth: "admin", body: schemaOf(createApplicationSchema), ok: { status: "201", response: json(ref("Application"), "Created") } });
  add("get", "/applications", { summary: "List applications", tag: "Applications", auth: "admin", ok: { status: "200", response: json({ type: "array", items: ref("Application") }) } });
  add("get", A, { summary: "Get an application", tag: "Applications", auth: "adminOrKey", scope: "analytics:read", ok: { status: "200", response: json(ref("Application")) }, extraErrors: { "404": "Not found" } });

  add("post", `${A}/otp/request`, {
    summary: "Request a one-time code",
    description: "The response includes `risk` ({ decision, enforced, score, reasons }). A `challenge` still sends the code: your backend decides what extra proof to ask for. A `block` (only in enforce mode) returns 403 and sends nothing. Optionally send `context` ({ ip, deviceId, userAgent }) forwarded from your user's request to get `signals` back: whether the device or IP is new for this user, and how many different phones used them recently. Creates or finds the user, invalidates older codes, and queues the message. Returns immediately (202); a worker sends it. When `channel` is `email`, `email` is required. `fallback` lists phone channels to try, in order, if the first fails. Rate limited (429).",
    tag: "OTP", auth: "key", scope: "otp:request", body: schemaOf(otpRequestSchema),
    ok: { status: "202", response: json({ type: "object", properties: { status: { type: "string" }, userId: { type: "string" }, deliveryId: { type: "string" } } }, "Accepted") },
    extraErrors: { "403": "Blocked by the risk rules (code RISK_BLOCKED), or key not allowed", "429": "Rate limited. See the Retry-After header." },
  });
  add("post", `${A}/otp/verify`, {
    summary: "Verify a one-time code and start a session",
    description: "Codes are single use and expire after 5 minutes. A wrong code counts an attempt; too many attempts return 429. Success returns an access token and a refresh token. If `context` is sent, the device and IP are remembered and `device` says whether they were new; a new device also fires the `device.new` webhook.",
    tag: "OTP", auth: "key", scope: "otp:verify", body: schemaOf(otpVerifySchema),
    ok: { status: "200", response: json(ref("Tokens")) },
    extraErrors: { "429": "Too many attempts or rate limited" },
  });
  add("get", `${A}/deliveries/{deliveryId}`, { summary: "Get delivery status", tag: "OTP", auth: "key", scope: "deliveries:read", ok: { status: "200", response: json(ref("Delivery")) }, extraErrors: { "404": "Not found" } });

  add("get", `${A}/users/{userId}/devices`, { summary: "Devices a user has logged in from", description: "Only devices from successful logins appear. Raw device ids and IPs are never stored; the IP is shown masked.", tag: "Users", auth: "key", scope: "users:read", ok: { status: "200", response: json({ type: "array", items: ref("Device") }) }, extraErrors: { "404": "User not found" } });
  add("post", `${A}/users`, { summary: "Create a user", tag: "Users", auth: "key", scope: "users:write", body: schemaOf(createUserSchema), ok: { status: "201", response: json(ref("User"), "Created") }, extraErrors: { "404": "Application not found", "409": "User already exists" } });
  add("get", `${A}/users`, { summary: "List users", tag: "Users", auth: "key", scope: "users:read", ok: { status: "200", response: json({ type: "array", items: ref("User") }) } });
  add("get", `${A}/users/{userId}`, { summary: "Get a user", tag: "Users", auth: "key", scope: "users:read", ok: { status: "200", response: json(ref("User")) }, extraErrors: { "404": "Not found" } });

  add("post", `${A}/api-keys`, { summary: "Create an API key", description: "The full key is returned once and cannot be retrieved later.", tag: "API keys", auth: "adminOrKey", scope: "keys:manage", body: schemaOf(createApiKeySchema), ok: { status: "201", response: json(ref("ApiKeyCreated"), "Created") }, extraErrors: { "404": "Application not found" } });
  add("get", `${A}/api-keys`, { summary: "List API keys (never includes the key itself)", tag: "API keys", auth: "adminOrKey", scope: "keys:manage", ok: { status: "200", response: json({ type: "array", items: ref("ApiKey") }) } });
  add("delete", `${A}/api-keys/{keyId}`, { summary: "Revoke an API key", tag: "API keys", auth: "adminOrKey", scope: "keys:manage", ok: noContent, extraErrors: { "404": "Not found" } });

  add("post", `${A}/webhooks`, { summary: "Register a webhook endpoint", description: "See the Webhooks section above for how to verify deliveries. The signing secret is returned once.", tag: "Webhooks", auth: "adminOrKey", scope: "webhooks:manage", body: schemaOf(createWebhookSchema), ok: { status: "201", response: json(ref("WebhookCreated"), "Created") }, extraErrors: { "404": "Application not found" } });
  add("get", `${A}/webhooks`, { summary: "List webhook endpoints", tag: "Webhooks", auth: "adminOrKey", scope: "webhooks:manage", ok: { status: "200", response: json({ type: "array", items: ref("Webhook") }) } });
  add("delete", `${A}/webhooks/{webhookId}`, { summary: "Revoke a webhook endpoint", tag: "Webhooks", auth: "adminOrKey", scope: "webhooks:manage", ok: noContent, extraErrors: { "404": "Not found" } });
  add("get", `${A}/webhooks/{webhookId}/logs`, { summary: "Recent delivery attempts for a webhook", tag: "Webhooks", auth: "adminOrKey", scope: "webhooks:manage", ok: { status: "200", response: json({ type: "array", items: { type: "object" } }) } });

  add("get", `${A}/risk-config`, { summary: "Get the risk rules for an application", description: "Returns the effective configuration: saved values with defaults filling the gaps.", tag: "Risk", auth: "adminOrKey", scope: "risk:manage", ok: { status: "200", response: json(ref("RiskConfig")) } });
  add("put", `${A}/risk-config`, {
    summary: "Replace the risk rules",
    description: "Anything you leave out returns to its default. `mode` is `off` (no evaluation), `log` (evaluate and record, never block; the default) or `enforce` (block for real). A score at or above `challengeScore` gives `challenge`; at or above `blockScore`, or any hard rule (blocked country, velocity limits), gives `block`.",
    tag: "Risk", auth: "adminOrKey", scope: "risk:manage", body: schemaOf(riskConfigSchema), ok: { status: "200", response: json(ref("RiskConfig")) }, extraErrors: { "404": "Application not found" },
  });
  add("get", `${A}/risk/decisions`, { summary: "Recent challenge and block decisions", description: "Allow decisions are not stored. In log mode, blocks appear with `enforced: false`, so you can review what would have been blocked before turning enforcement on.", tag: "Risk", auth: "adminOrKey", scope: "risk:manage", ok: { status: "200", response: json({ type: "array", items: ref("RiskDecision") }) } });
  add("get", `${A}/analytics`, { summary: "Usage statistics for one application", tag: "Analytics", auth: "adminOrKey", scope: "analytics:read", query: true, ok: { status: "200", response: json({ type: "object" }) }, extraErrors: { "404": "Application not found" } });
  add("get", "/analytics/overview", { summary: "Statistics across all applications", tag: "Analytics", auth: "admin", query: true, ok: { status: "200", response: json({ type: "object" }) } });

  add("post", "/auth/refresh", { summary: "Exchange a refresh token for a new token pair", description: "Each refresh token works once. Reusing an old one revokes the whole session.", tag: "Sessions", auth: "none", body: schemaOf(refreshSchema), ok: { status: "200", response: json(ref("Tokens")) } });
  add("get", "/auth/me", { summary: "Who is this session?", tag: "Sessions", auth: "session", ok: { status: "200", response: json({ type: "object" }) } });
  add("post", "/auth/logout", { summary: "Log out (revokes the session on the server)", tag: "Sessions", auth: "session", ok: noContent });
  add("post", "/webhooks/twilio/status", { summary: "Twilio delivery-status callback", description: "Called by Twilio, not by API clients. Verified with the X-Twilio-Signature header.", tag: "Internal", auth: "signature", ok: noContent, extraErrors: { "403": "Invalid signature" } });

  const eventSchema = (type: string, data: object) => ({
    type: "object",
    properties: { id: { type: "string", description: "Same for retries of one event; use it to deduplicate" }, type: { const: type }, createdAt: { type: "string", format: "date-time" }, applicationId: { type: "string" }, data },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "OTPlease API",
      version: "1.0.0",
      description: [
        "Multi-tenant OTP authentication. Send a one-time code by SMS, WhatsApp, voice or email, verify it, and get a session.",
        "",
        "## Authentication",
        "- **API key** (`x-api-key`): used by your backend. Keys are scoped and belong to one application.",
        "- **Admin token** (`x-admin-token`): platform operator only.",
        "- **Session bearer token** (`Authorization: Bearer ...`): the end user's access token from `/otp/verify`.",
        "",
        "## Verifying webhooks",
        "Each delivery has three headers: `x-otplease-signature` (`v1=<hex>`), `x-otplease-timestamp` (unix seconds) and `x-otplease-event-id`.",
        "The signature is HMAC-SHA256 of `<timestamp>.<raw body>` with your endpoint secret. Reject deliveries whose timestamp is more than 5 minutes old, and remember event ids to reject replays. Retries reuse the event id.",
      ].join("\n"),
    },
    tags: ["System", "Applications", "OTP", "Users", "API keys", "Webhooks", "Risk", "Analytics", "Sessions", "Internal"].map((name) => ({ name })),
    paths,
    webhooks: {
      "otp.verified": { post: { summary: "A user verified a code", requestBody: { content: { "application/json": { schema: eventSchema("otp.verified", { type: "object", properties: { userId: { type: "string" } } }) } } }, responses: { "2XX": { description: "Acknowledge with any 2xx" } } } },
      "device.new": { post: { summary: "A user logged in from a device not seen before", requestBody: { content: { "application/json": { schema: eventSchema("device.new", { type: "object", properties: { userId: { type: "string" }, deviceId: { type: "string" }, isFirstDevice: { type: "boolean", description: "True when this is the user's first known device, so usually not suspicious" }, ip: { type: "string", description: "Masked" }, userAgent: { type: ["string", "null"] } } }) } } }, responses: { "2XX": { description: "Acknowledge with any 2xx" } } } },
      "risk.challenged": { post: { summary: "A request scored as needing extra proof", requestBody: { content: { "application/json": { schema: eventSchema("risk.challenged", { type: "object", properties: { userId: { type: ["string", "null"] }, score: { type: "integer" }, reasons: { type: "array", items: { enum: [...RULE_CODES] } }, enforced: { type: "boolean" } } }) } } }, responses: { "2XX": { description: "Acknowledge with any 2xx" } } } },
      "risk.blocked": { post: { summary: "A request was (or, in log mode, would have been) blocked", requestBody: { content: { "application/json": { schema: eventSchema("risk.blocked", { type: "object", properties: { userId: { type: ["string", "null"] }, score: { type: "integer" }, reasons: { type: "array", items: { enum: [...RULE_CODES] } }, enforced: { type: "boolean" } } }) } } }, responses: { "2XX": { description: "Acknowledge with any 2xx" } } } },
      "delivery.sent": { post: { summary: "A message was handed to the provider", requestBody: { content: { "application/json": { schema: eventSchema("delivery.sent", { type: "object" }) } } }, responses: { "2XX": { description: "Acknowledge with any 2xx" } } } },
      "delivery.delivered": { post: { summary: "The provider confirmed delivery", requestBody: { content: { "application/json": { schema: eventSchema("delivery.delivered", { type: "object" }) } } }, responses: { "2XX": { description: "Acknowledge with any 2xx" } } } },
      "delivery.failed": { post: { summary: "Delivery failed on every channel", requestBody: { content: { "application/json": { schema: eventSchema("delivery.failed", { type: "object" }) } } }, responses: { "2XX": { description: "Acknowledge with any 2xx" } } } },
    },
    components: {
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        AdminToken: { type: "apiKey", in: "header", name: "x-admin-token" },
        SessionBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} }, required: ["code", "message"] } } },
        Application: { type: "object", properties: { id: { type: "string", format: "uuid" }, name: { type: "string" }, createdAt: { type: "string", format: "date-time" } } },
        User: { type: "object", properties: { id: { type: "string", format: "uuid" }, applicationId: { type: "string" }, phone: { type: "string", description: "E.164" }, createdAt: { type: "string", format: "date-time" } } },
        RiskConfig: schemaOf(riskConfigSchema),
        RiskDecision: { type: "object", properties: { id: { type: "string" }, userId: { type: ["string", "null"] }, decision: { enum: ["challenge", "block"] }, enforced: { type: "boolean" }, score: { type: "integer" }, reasons: { type: "array", items: { enum: [...RULE_CODES] } }, country: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" } } },
        Device: { type: "object", properties: { id: { type: "string" }, userAgent: { type: ["string", "null"] }, lastIpMasked: { type: ["string", "null"] }, firstSeenAt: { type: "string", format: "date-time" }, lastSeenAt: { type: "string", format: "date-time" } } },
        Tokens: { type: "object", properties: { accessToken: { type: "string" }, refreshToken: { type: "string" }, tokenType: { const: "Bearer" }, expiresIn: { type: "integer", description: "Access token lifetime in seconds" }, userId: { type: "string" } } },
        Delivery: { type: "object", properties: { id: { type: "string" }, requestedChannel: { type: "string" }, channel: { type: ["string", "null"], description: "Channel actually used, after any fallback" }, status: { enum: ["queued", "sent", "delivered", "failed"] }, toMasked: { type: "string" }, attempts: { type: "integer" }, error: { type: ["string", "null"] } } },
        ApiKey: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, prefix: { type: "string" }, scopes: { type: "array", items: { enum: [...SCOPES] } }, createdAt: { type: "string", format: "date-time" }, lastUsedAt: { type: ["string", "null"] }, revokedAt: { type: ["string", "null"] } } },
        ApiKeyCreated: { allOf: [ref("ApiKey"), { type: "object", properties: { key: { type: "string", description: "Shown once" } } }] },
        Webhook: { type: "object", properties: { id: { type: "string" }, url: { type: "string" }, events: { type: "array", items: { enum: [...WEBHOOK_EVENTS] } }, createdAt: { type: "string", format: "date-time" }, revokedAt: { type: ["string", "null"] } } },
        WebhookCreated: { allOf: [ref("Webhook"), { type: "object", properties: { secret: { type: "string", description: "Signing secret, shown once" } } }] },
      },
    },
  };
}

export const DOCS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>OTPlease API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui" });</script></body></html>`;
