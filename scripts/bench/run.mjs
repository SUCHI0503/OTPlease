#!/usr/bin/env node
// Load-tests the built API and worker and writes docs/benchmarks/results/<label>.json (+ a markdown summary).
//
//   npm run build:backend && node scripts/bench/run.mjs --label baseline
//   options: --levels 10,50,100,500,1000,2000   --duration 20   --scenarios health,me,otp_request,otp_verify
//
// It uses its OWN database (otplease_bench) and Redis database /2, always the MOCK provider (no message is ever
// sent), and raises the rate limits so the limiters are not what gets measured.
import autocannon from "autocannon";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { SignJWT } from "jose";
import { Redis } from "ioredis";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const LABEL = arg("label", "baseline");
const LEVELS = arg("levels", "10,50,100,500,1000,2000").split(",").map(Number);
const DURATION = Number(arg("duration", "20"));
const SCENARIOS = arg("scenarios", "health,me,otp_request,otp_verify").split(",");
const PORT = 4200;
const API = `http://127.0.0.1:${PORT}`;
const LOGS = path.join(root, "docs/benchmarks/.logs");
mkdirSync(LOGS, { recursive: true });

// ---------- environment: same secrets as development, but a separate database and Redis DB ----------
const parseEnv = (file) =>
  Object.fromEntries(readFileSync(file, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const base = parseEnv(path.join(root, "apps/server/.env"));
const dbUrl = base.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, "/otplease_bench$1");
const redisUrl = base.REDIS_URL.replace(/\/\d+$/, "/2");
if (!dbUrl.includes("otplease_bench") || !redisUrl.endsWith("/2")) throw new Error("refusing to run: not pointing at the bench database and Redis DB /2");

const HUGE = { limit: 10_000_000, windowSeconds: 3600 };
const limits = Object.fromEntries(["otpRequestPerPhone", "otpRequestPerIp", "otpRequestPerCountry", "otpRequestPerApplication", "verifyPerPhone", "verifyPerIp", "refreshPerIp", "authFailuresPerIp"].map((k) => [k, HUGE]));
const childEnv = {
  ...process.env, ...base,
  NODE_ENV: "test", PORT: String(PORT), DATABASE_URL: dbUrl, REDIS_URL: redisUrl,
  RATE_LIMITS_JSON: JSON.stringify(limits), MOCK_OUTBOX_REDIS: "false", WEBHOOK_ALLOW_PRIVATE_URLS: "false",
  LOG_LEVEL: process.env.BENCH_LOG_LEVEL ?? "info", // logging stays ON: production logs every request too
};
for (const k of Object.keys(childEnv)) if (k.startsWith("TWILIO_") || k.startsWith("SMTP_")) delete childEnv[k];

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------- database and Redis ----------
say("preparing the bench database and Redis DB /2");
sh("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "otplease", "-d", "postgres", "-c", "CREATE DATABASE otplease_bench"]); // fine if it exists
const migrate = sh("npx", ["prisma", "migrate", "deploy"], { cwd: path.join(root, "apps/server"), env: childEnv });
if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stdout}${migrate.stderr}`);
const prisma = new PrismaClient({ datasourceUrl: dbUrl });
const redis = new Redis(redisUrl);
const tables = (await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`).map((t) => `"${t.tablename}"`);
await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
await redis.flushdb();

// ---------- start the built API and worker ----------
for (const f of ["apps/server/dist/index.js", "apps/worker/dist/index.js"]) if (!existsSync(path.join(root, f))) throw new Error(`${f} missing: run npm run build:backend first`);
const procs = [];
const start = (name, file) => {
  const out = openSync(path.join(LOGS, `${name}.log`), "w");
  const child = spawn("node", [file], { cwd: root, env: childEnv, stdio: ["ignore", out, out] });
  procs.push(child);
  return child;
};
const api = start("api", "apps/server/dist/index.js");
const worker = start("worker", "apps/worker/dist/index.js");
const stopAll = () => procs.forEach((p) => { try { p.kill("SIGTERM"); } catch {} });
process.on("SIGINT", () => { stopAll(); process.exit(1); });
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${API}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

// ---------- helpers ----------
const admin = { "x-admin-token": base.ADMIN_TOKEN, "content-type": "application/json" };
const post = async (url, body) => (await fetch(`${API}${url}`, { method: "POST", headers: admin, body: JSON.stringify(body) })).json();
const app = await post("/applications", { name: "bench" });
const key = (await post(`/applications/${app.id}/api-keys`, { name: "bench", scopes: ["otp:request", "otp:verify"] })).key;

const hashCode = (code) => crypto.createHmac("sha256", base.OTP_HASH_SECRET).update(code).digest("hex");
const jwtKey = new TextEncoder().encode(base.JWT_SECRET);
let phoneCounter = 0;
// valid Indian mobile numbers, sequential so none repeats: +91 9 XXXXXXXXX
const nextPhone = () => `+919${String(100_000_000 + phoneCounter++).padStart(9, "0")}`;
const chunk = async (rows, size, fn) => { for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size)); };

async function seedVerifyUsers(n) {
  const users = Array.from({ length: n }, () => ({ id: crypto.randomUUID(), applicationId: app.id, phone: nextPhone() }));
  await chunk(users, 5000, (c) => prisma.user.createMany({ data: c }));
  const codeHash = hashCode("123456");
  const expiresAt = new Date(Date.now() + 3_600_000);
  await chunk(users, 5000, (c) => prisma.otpCode.createMany({ data: c.map((u) => ({ applicationId: app.id, userId: u.id, codeHash, expiresAt })) }));
  return users.map((u) => u.phone);
}

async function seedSessions(n) {
  const users = Array.from({ length: n }, () => ({ id: crypto.randomUUID(), applicationId: app.id, phone: nextPhone() }));
  await prisma.user.createMany({ data: users });
  const sessions = users.map((u) => ({ id: crypto.randomUUID(), applicationId: app.id, userId: u.id, refreshHash: "x", expiresAt: new Date(Date.now() + 7_200_000) }));
  await prisma.session.createMany({ data: sessions });
  return Promise.all(sessions.map((s) =>
    new SignJWT({ sid: s.id, aid: app.id }).setProtectedHeader({ alg: "HS256" }).setSubject(s.userId).setIssuedAt().setExpirationTime("2h").sign(jwtKey)));
}

async function resetData() {
  await prisma.$executeRawUnsafe(`TRUNCATE "Delivery","OtpCode","Session","Device","SeenIp","RiskDecision","AuditLog","WebhookLog","User" RESTART IDENTITY CASCADE`);
}

// CPU seconds used so far by a process, from `ps`. Deltas over a run give average cores used (100% = one core).
function cpuSeconds(pid) {
  const t = sh("ps", ["-p", String(pid), "-o", "time="]).stdout.trim();
  if (!t) return 0;
  const parts = t.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
const rssMb = (pid) => Number(sh("ps", ["-p", String(pid), "-o", "rss="]).stdout.trim() || 0) / 1024;
// IMPORTANT: this must never block the event loop. `docker stats` takes seconds on a busy laptop, and a
// synchronous call here froze the load generator, so it sent nothing while it waited (half the target rate, and
// inflated latencies). Everything that runs DURING a load test is async; the sync helpers below run only between tests.
const execFileP = promisify(execFile);
async function dockerStats() {
  const { stdout } = await execFileP("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"], { cwd: root });
  const r = {};
  for (const line of stdout.trim().split("\n")) {
    const [name, cpu, mem] = line.split("|");
    if (!name) continue;
    r[name.includes("postgres") ? "postgres" : name.includes("redis") ? "redis" : name] = { cpu: parseFloat(cpu), mem: mem.split("/")[0].trim() };
  }
  return r;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);

async function drive({ method, path: p, headers = () => ({}), body, rate, duration }) {
  const connections = Math.min(1000, Math.max(10, Math.ceil(rate / 10)));
  const latencies = [];
  const statuses = {};
  const requests = [{ method, path: p, headers: { "content-type": "application/json" }, setupRequest: (req) => { const h = headers(); if (Object.keys(h).length) req.headers = { ...req.headers, ...h }; if (body) req.body = JSON.stringify(body()); return req; } }];
  const inst = autocannon({ url: API, connections, overallRate: rate, duration, timeout: 10, requests });
  inst.on("response", (_c, status, _b, ms) => { latencies.push(ms); statuses[status] = (statuses[status] ?? 0) + 1; });
  return new Promise((resolve, reject) => { autocannon.track?.(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false }); inst.on("done", (r) => resolve({ r, latencies, statuses, connections })); inst.on("error", reject); });
}

// ---------- scenarios ----------
const scenarios = {
  health: { title: "GET /health (framework baseline)", prepare: async () => ({ method: "GET", path: "/health", body: null }) },
  me: {
    title: "GET /auth/me (session check: JWT + one DB query)",
    prepare: async () => { const tokens = await seedSessions(500); return { method: "GET", path: "/auth/me", headers: () => ({ authorization: `Bearer ${tokens[(Math.random() * tokens.length) | 0]}` }), body: null }; },
  },
  otp_request: {
    title: "POST /otp/request (creates user + code, queues the message)",
    prepare: async () => ({ method: "POST", path: `/applications/${app.id}/otp/request`, headers: () => ({ "x-api-key": key }), body: () => ({ phone: nextPhone() }) }),
  },
  otp_verify: {
    title: "POST /otp/verify (correct code: creates a session)",
    prepare: async (rate, duration) => {
      const phones = await seedVerifyUsers(Math.ceil(rate * (duration + 6) * 1.15) + 600);
      let i = 0;
      return { method: "POST", path: `/applications/${app.id}/otp/verify`, headers: () => ({ "x-api-key": key }), body: () => ({ phone: phones[i++ % phones.length], code: "123456" }) };
    },
  },
};

// After an otp_request run: how long did the worker take to send everything that was queued?
async function queueLag(sentBefore) {
  const start = Date.now();
  let pending;
  for (;;) {
    pending = Number((await prisma.$queryRaw`SELECT count(*) AS n FROM "Delivery" WHERE status IN ('queued')`)[0].n);
    if (pending === 0 || Date.now() - start > 120_000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const rows = await prisma.$queryRaw`SELECT count(*) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("updatedAt" - "createdAt")) * 1000) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ("updatedAt" - "createdAt")) * 1000) AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM ("updatedAt" - "createdAt")) * 1000) AS p99,
      max(extract(epoch FROM ("updatedAt" - "createdAt")) * 1000) AS max
    FROM "Delivery" WHERE status = 'sent'`;
  const failed = Number((await prisma.$queryRaw`SELECT count(*) AS n FROM "Delivery" WHERE status = 'failed'`)[0].n);
  const r = rows[0];
  return { sent: Number(r.n), stillQueued: pending, failed, drainedAfterMs: Date.now() - start, lagMs: { p50: Number(r.p50), p95: Number(r.p95), p99: Number(r.p99), max: Number(r.max) } };
}

// ---------- run ----------
const results = { label: LABEL, startedAt: new Date().toISOString(), durationSeconds: DURATION, environment: {}, scenarios: {} };
const pgVersion = (await prisma.$queryRaw`SELECT version() AS v`)[0].v;
const dockerInfo = sh("docker", ["info", "--format", "{{.NCPU}} CPUs, {{.MemTotal}} bytes"]).stdout.trim();
results.environment = {
  machine: `${sh("sysctl", ["-n", "machdep.cpu.brand_string"]).stdout.trim() || os.cpus()[0].model}, ${os.cpus().length} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM`,
  os: `${os.type()} ${os.release()}`, node: process.version, postgres: pgVersion.split(" on ")[0], redis: (await redis.info("server")).match(/redis_version:(\S+)/)?.[1],
  dockerVm: dockerInfo, apiProcess: "node apps/server/dist/index.js (single process, single thread)", workerProcess: "node apps/worker/dist/index.js (concurrency 10 per queue)",
  prismaPoolSize: `default: ${os.cpus().length * 2 + 1} connections (logical CPUs x 2 + 1)`, logLevel: childEnv.LOG_LEVEL, provider: "mock (no real messages are sent)",
  rateLimits: "raised to 10,000,000 per window so limiters are not measured", loadGenerator: `autocannon ${JSON.parse(readFileSync(path.join(root, "node_modules/autocannon/package.json"), "utf8")).version}, same machine`,
};
say(`environment: ${results.environment.machine}`);

for (const name of SCENARIOS) {
  const sc = scenarios[name];
  if (!sc) throw new Error(`unknown scenario ${name}`);
  results.scenarios[name] = { title: sc.title, levels: [] };
  say(`=== ${sc.title}`);
  for (const rate of LEVELS) {
    await resetData();
    const spec = await sc.prepare(rate, DURATION + 6);
    await drive({ ...spec, rate: Math.min(rate, 100), duration: 4 }); // warm-up, discarded (verify users are seeded with headroom for it)
    // verify keeps going through its (generously sized) pool of seeded users; request starts clean after the warm-up
    if (name === "otp_request") await resetData();

    const apiCpu0 = cpuSeconds(api.pid), workerCpu0 = cpuSeconds(worker.pid), selfCpu0 = process.cpuUsage();
    const samples = [];
    let sampling = false; // never let two samples overlap
    const sampler = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      try { samples.push(await dockerStats()); } catch { /* a missed sample is fine */ } finally { sampling = false; }
    }, 3000);
    const t0 = Date.now();
    const { r, latencies, statuses, connections } = await drive({ ...spec, rate, duration: DURATION });
    const wall = (Date.now() - t0) / 1000;
    clearInterval(sampler);
    const apiCores = (cpuSeconds(api.pid) - apiCpu0) / wall, workerCores = (cpuSeconds(worker.pid) - workerCpu0) / wall;
    const self = process.cpuUsage(selfCpu0), loadGenCores = (self.user + self.system) / 1e6 / wall;

    const sorted = latencies.slice().sort((a, b) => a - b);
    const ok = Object.entries(statuses).filter(([s]) => s.startsWith("2")).reduce((n, [, c]) => n + c, 0);
    const total = latencies.length;
    const pgCpu = samples.map((s) => s.postgres?.cpu ?? 0), redisCpu = samples.map((s) => s.redis?.cpu ?? 0);
    const level = {
      targetRps: rate, connections, seconds: DURATION, completed: total, achievedRps: +(total / DURATION).toFixed(1),
      success2xx: ok, errorRatePct: +(((total - ok + r.errors + r.timeouts) / Math.max(1, total + r.errors + r.timeouts)) * 100).toFixed(3),
      statusCodes: statuses, errors: r.errors, timeouts: r.timeouts,
      latencyMs: { mean: +(sorted.reduce((a, b) => a + b, 0) / Math.max(1, total)).toFixed(2), p50: pct(sorted, 0.5), p90: pct(sorted, 0.9), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99), max: sorted.at(-1) ?? null },
      cpuCores: { api: +apiCores.toFixed(2), worker: +workerCores.toFixed(2), postgres: +(Math.max(0, ...pgCpu) / 100).toFixed(2), redis: +(Math.max(0, ...redisCpu) / 100).toFixed(2), loadGenerator: +loadGenCores.toFixed(2) },
      apiMemoryMb: Math.round(rssMb(api.pid)),
    };
    level.saturated = level.achievedRps < rate * 0.95 || level.errorRatePct > 1;
    if (name === "otp_request") level.queue = await queueLag();
    results.scenarios[name].levels.push(level);
    const q = level.queue ? `  worker drained in ${(level.queue.drainedAfterMs / 1000).toFixed(1)}s, lag p95 ${level.queue.lagMs.p95.toFixed(0)}ms` : "";
    say(`${name} @ ${rate} rps -> achieved ${level.achievedRps}, p50 ${level.latencyMs.p50?.toFixed(1)} p95 ${level.latencyMs.p95?.toFixed(1)} p99 ${level.latencyMs.p99?.toFixed(1)} ms, errors ${level.errorRatePct}%, cpu api ${level.cpuCores.api} pg ${level.cpuCores.postgres} redis ${level.cpuCores.redis}${level.saturated ? "  [SATURATED]" : ""}${q}`);
    if (level.errorRatePct > 50) { say("more than half the requests failed here; skipping higher levels for this scenario"); break; }
    await new Promise((r) => setTimeout(r, 3000)); // let things settle
  }
}

results.finishedAt = new Date().toISOString();
mkdirSync(path.join(root, "docs/benchmarks/results"), { recursive: true });
const outFile = path.join(root, `docs/benchmarks/results/${LABEL}.json`);
writeFileSync(outFile, JSON.stringify(results, null, 2) + "\n");
say(`wrote ${path.relative(root, outFile)}`);

stopAll();
await prisma.$disconnect();
redis.disconnect();
setTimeout(() => process.exit(0), 1500);
