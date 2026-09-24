// Demo only: waits for the API, then creates a "Demo Shop" application and a key with just the scopes a real
// integration needs, and hands them to the demo through the environment. Reused across restarts via /data.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const api = process.env.OTPLEASE_URL;
const admin = { "x-admin-token": process.env.ADMIN_TOKEN, "content-type": "application/json" };
const saved = "/data/demo.json";

async function call(method, url, body) {
  const res = await fetch(`${api}${url}`, { method, headers: admin, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}`);
  return res.json();
}

export async function bootstrap() {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${api}/health`)).ok) break;
    } catch {}
    if (i > 60) throw new Error(`OTPlease API not reachable at ${api}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  let creds = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : null;
  if (creds) {
    const check = await fetch(`${api}/applications/${creds.id}`, { headers: admin });
    if (!check.ok) creds = null;
  }
  if (!creds) {
    const app = await call("POST", "/applications", { name: "Demo Shop" });
    const key = await call("POST", `/applications/${app.id}/api-keys`, { name: "demo app", scopes: ["otp:request", "otp:verify"] });
    creds = { id: app.id, key: key.key };
    try { writeFileSync(saved, JSON.stringify(creds)); } catch {}
  }
  process.env.OTPLEASE_APP_ID = creds.id;
  process.env.OTPLEASE_API_KEY = creds.key;
  delete process.env.ADMIN_TOKEN; // the demo itself never needs the admin token
}
