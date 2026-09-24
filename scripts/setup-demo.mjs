#!/usr/bin/env node
// Creates a demo application and an API key in your running OTPlease API, and writes them to
// apps/demo/.env.local so the demo app can use them. Run it after the API is up:  npm run demo:setup
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEnv = path.join(root, "apps/server/.env");
const demoEnv = path.join(root, "apps/demo/.env.local");

const readEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")])
  );

if (!existsSync(serverEnv)) {
  console.error("apps/server/.env not found. Create it first (see apps/server/.env.example).");
  process.exit(1);
}
const env = readEnv(serverEnv);
const api = process.env.OTPLEASE_URL ?? `http://localhost:${env.PORT ?? 4000}`;
const admin = { "x-admin-token": env.ADMIN_TOKEN };

async function call(method, url, body) {
  const res = await fetch(`${api}${url}`, {
    method,
    headers: { ...admin, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (!res) {
    console.error(`Could not reach the API at ${api}. Start it first:  npm run dev -w server`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${method} ${url} failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

// Already set up and the application still exists: nothing to do (use --force to start over)
if (existsSync(demoEnv) && !process.argv.includes("--force")) {
  const existing = readEnv(demoEnv);
  if (existing.OTPLEASE_APP_ID) {
    const check = await fetch(`${api}/applications/${existing.OTPLEASE_APP_ID}`, { headers: admin }).catch(() => null);
    if (check?.ok) {
      console.log(`Demo already set up (application ${existing.OTPLEASE_APP_ID}). Use --force to create a new one.`);
      process.exit(0);
    }
  }
}

const app = await call("POST", "/applications", { name: "Demo Shop" });
// The demo app gets only what a real integration needs
const key = await call("POST", `/applications/${app.id}/api-keys`, { name: "demo app", scopes: ["otp:request", "otp:verify"] });

writeFileSync(demoEnv, `OTPLEASE_URL=${api}\nOTPLEASE_APP_ID=${app.id}\nOTPLEASE_API_KEY=${key.key}\n`, { mode: 0o600 });
console.log(`Created application "Demo Shop" (${app.id}) and wrote its API key to apps/demo/.env.local`);
console.log("Now start the demo app:  npm run dev -w demo   then open http://localhost:3002");
