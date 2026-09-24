import { expect, type Page } from "@playwright/test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";

export const env = () => ({
  api: process.env.E2E_API_URL!,
  dashboard: process.env.E2E_DASHBOARD_URL!,
  demo: process.env.E2E_DEMO_URL!,
  redis: process.env.E2E_REDIS_URL!,
  adminToken: process.env.E2E_ADMIN_TOKEN!,
  appId: process.env.E2E_APP_ID!,
  inspectorKey: process.env.E2E_INSPECTOR_KEY!,
});

/** A valid-looking Indian mobile number no other test has used, so per-phone limits never overlap. */
let counter = 0;
export function uniquePhone(): string {
  counter += 1;
  const tail = String(Math.floor(Math.random() * 90_000_000) + 10_000_000);
  return `+91${6 + (counter % 4)}${tail}${counter % 10}`.slice(0, 13);
}

/** Reads the code the worker "sent" from the mock provider's Redis outbox. */
export async function readCode(phone: string, since = 0, timeoutMs = 15_000): Promise<string> {
  const redis = new Redis(env().redis);
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const items = (await redis.lrange("mock:outbox", 0, 99)).map((s) => JSON.parse(s) as { to: string; code: string; at: number });
      const found = items.find((m) => m.to === phone && m.at >= since);
      if (found) return found.code;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`no code arrived for ${phone} within ${timeoutMs / 1000}s (is the worker running?)`);
  } finally {
    redis.disconnect();
  }
}

/** All codes ever sent to a phone, newest first. */
export async function allCodes(phone: string): Promise<string[]> {
  const redis = new Redis(env().redis);
  const items = (await redis.lrange("mock:outbox", 0, 199)).map((s) => JSON.parse(s) as { to: string; code: string });
  redis.disconnect();
  return items.filter((m) => m.to === phone).map((m) => m.code);
}

/** Types a phone number into the demo app and asks for a code. Returns when the code step is showing. */
export async function requestCodeInDemo(page: Page, phone: string) {
  await page.goto(env().demo);
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
}

/** The whole happy path: phone, code, signed in. */
export async function loginViaDemo(page: Page, phone: string) {
  const since = Date.now() - 1000;
  await requestCodeInDemo(page, phone);
  const code = await readCode(phone, since);
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/account$/);
  return code;
}

/** Calls the OTPlease API directly, the way a developer's backend would. */
export async function api(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${env().api}${path}`, {
    method: init.method ?? "GET",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

export const asAdmin = () => ({ "x-admin-token": env().adminToken });
export const asInspector = () => ({ "x-api-key": env().inspectorKey });

/** Signs in to the dashboard with the admin token. */
export async function signInToDashboard(page: Page) {
  await page.goto(`${env().dashboard}/login`);
  await page.getByLabel("Admin token").fill(env().adminToken);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
}

/** Reads one of the number cards on a dashboard application page, by its label. */
export async function cardValue(page: Page, label: string): Promise<number> {
  const card = page.locator(".card", { has: page.getByText(label, { exact: true }) });
  return Number((await card.locator(".value").innerText()).trim());
}

/** A tiny web server that plays the part of a developer's webhook receiver. */
export async function startReceiver() {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { received.push({ headers: req.headers, body }); res.end("ok"); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}
