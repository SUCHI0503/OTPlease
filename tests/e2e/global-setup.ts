import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";

const ROOT = path.resolve(__dirname, "../..");
const LOGS = path.join(__dirname, ".logs");

// Ports are different from the development ones, so a running dev stack does not get in the way
const PORTS = { api: 4100, dashboard: 3100, demo: 3102 };

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

async function waitFor(url: string, name: string, log: string, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-25).join("\n") : "(no log)";
  throw new Error(`${name} did not start within ${timeoutMs / 1000}s. Last log lines:\n${tail}`);
}

export default async function globalSetup() {
  const serverEnvFile = path.join(ROOT, "apps/server/.env.test");
  if (!existsSync(serverEnvFile)) throw new Error("apps/server/.env.test is missing: see the README for test setup");
  const fileEnv = parseEnvFile(serverEnvFile);

  // Safety first: this run wipes its database and Redis, so refuse anything that is not clearly a test one
  if (!fileEnv.DATABASE_URL?.includes("otplease_test")) throw new Error("E2E refuses to run: DATABASE_URL is not the test database");
  if (!fileEnv.REDIS_URL?.endsWith("/1")) throw new Error("E2E refuses to run: REDIS_URL is not the test Redis database (/1)");

  // Never call real providers from a test: drop Twilio and SMTP, use the mock with the Redis outbox
  const stackEnv: Record<string, string> = { ...(process.env as Record<string, string>), ...fileEnv, NODE_ENV: "test", MOCK_OUTBOX_REDIS: "true", WEBHOOK_ALLOW_PRIVATE_URLS: "true" };
  // Blank, not just deleted: Prisma loads apps/server/.env by itself and would fill in any variable that is missing
  for (const k of [...Object.keys(stackEnv), "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM", "TWILIO_WHATSAPP_FROM", "TWILIO_VOICE_FROM", "TWILIO_WHATSAPP_CONTENT_SID", "TWILIO_STATUS_CALLBACK_URL", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"]) {
    if (k.startsWith("TWILIO_") || k.startsWith("SMTP_")) stackEnv[k] = "";
  }

  mkdirSync(LOGS, { recursive: true });

  // 1. Database and Redis: migrated and empty
  const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], { cwd: path.join(ROOT, "apps/server"), env: stackEnv, encoding: "utf8" });
  if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed:\n${migrate.stdout}${migrate.stderr}`);

  const prisma = new PrismaClient({ datasources: { db: { url: fileEnv.DATABASE_URL } } });
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await prisma.$disconnect();
  const redis = new Redis(fileEnv.REDIS_URL);
  await redis.flushdb();
  redis.disconnect();

  // 2. Build the two Next.js apps (in parallel) so they run as they would in production
  if (!process.env.E2E_SKIP_BUILD) {
    const builds = ["web", "demo"].map(
      (app) =>
        new Promise<void>((resolve, reject) => {
          const out = openSync(path.join(LOGS, `build-${app}.log`), "w");
          const child = spawn("npx", ["next", "build"], { cwd: path.join(ROOT, "apps", app), env: { ...stackEnv, NODE_ENV: "production" }, stdio: ["ignore", out, out] });
          child.on("exit", (code) => { closeSync(out); code === 0 ? resolve() : reject(new Error(`next build failed for apps/${app}; see tests/e2e/.logs/build-${app}.log`)); });
        })
    );
    await Promise.all(builds);
  }

  const children: ChildProcess[] = [];
  const start = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) => {
    const out = openSync(path.join(LOGS, `${name}.log`), "w");
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
    children.push(child);
    return path.join(LOGS, `${name}.log`);
  };

  const apiUrl = `http://localhost:${PORTS.api}`;
  const adminToken = fileEnv.ADMIN_TOKEN!;

  try {
    // 3. API and worker
    const apiLog = start("api", "npx", ["tsx", "apps/server/src/index.ts"], ROOT, { ...stackEnv, PORT: String(PORTS.api) });
    start("worker", "npx", ["tsx", "apps/worker/src/index.ts"], ROOT, stackEnv);
    await waitFor(`${apiUrl}/health`, "API", apiLog);

    // 4. The application the demo app signs users into, and the keys the tests use
    const post = async (url: string, body: unknown, headers: Record<string, string>) => {
      const res = await fetch(`${apiUrl}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`setup call ${url} failed: ${res.status} ${await res.text()}`);
      return res.json() as Promise<Record<string, string>>;
    };
    const admin = { "x-admin-token": adminToken };
    const app = await post("/applications", { name: "E2E Demo Shop" }, admin);
    // The demo app gets only what a real integration needs
    const demoKey = await post(`/applications/${app.id}/api-keys`, { name: "demo app", scopes: ["otp:request", "otp:verify"] }, admin);
    // The tests get a broader key to look inside the system
    const inspectorKey = await post(`/applications/${app.id}/api-keys`, { name: "e2e inspector", scopes: ["users:read", "users:write", "deliveries:read", "analytics:read", "audit:read", "risk:manage"] }, admin);

    // 5. Dashboard and demo app
    const webLog = start("dashboard", "npx", ["next", "start", "--port", String(PORTS.dashboard)], path.join(ROOT, "apps/web"), { ...stackEnv, NODE_ENV: "production", API_URL: apiUrl });
    const demoLog = start("demo", "npx", ["next", "start", "--port", String(PORTS.demo)], path.join(ROOT, "apps/demo"), {
      ...stackEnv, NODE_ENV: "production", OTPLEASE_URL: apiUrl, OTPLEASE_APP_ID: app.id!, OTPLEASE_API_KEY: demoKey.key!,
    });
    await Promise.all([waitFor(`http://localhost:${PORTS.dashboard}/login`, "dashboard", webLog), waitFor(`http://localhost:${PORTS.demo}/`, "demo app", demoLog)]);

    // Everything the tests need, passed through the environment
    Object.assign(process.env, {
      E2E_API_URL: apiUrl,
      E2E_DASHBOARD_URL: `http://localhost:${PORTS.dashboard}`,
      E2E_DEMO_URL: `http://localhost:${PORTS.demo}`,
      E2E_REDIS_URL: fileEnv.REDIS_URL,
      E2E_ADMIN_TOKEN: adminToken,
      E2E_APP_ID: app.id,
      E2E_INSPECTOR_KEY: inspectorKey.key,
    });
  } catch (err) {
    for (const c of children) if (c.pid) try { process.kill(-c.pid, "SIGTERM"); } catch { /* already gone */ }
    throw err;
  }

  // Teardown: stop every process we started (each has its own process group)
  return async () => {
    for (const c of children) if (c.pid) try { process.kill(-c.pid, "SIGTERM"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1000));
    for (const c of children) if (c.pid) try { process.kill(-c.pid, "SIGKILL"); } catch { /* already gone */ }
  };
}
