#!/usr/bin/env node
// Turns a results file into markdown, or compares two of them (the before/after of an optimisation).
//   node scripts/bench/report.mjs baseline                       -> tables for docs/benchmarks/results/baseline.json
//   node scripts/bench/report.mjs baseline --notes docs/benchmarks/baseline.notes.md --out docs/benchmarks/baseline.md
//   node scripts/bench/report.mjs --compare baseline after       -> before/after table
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = (label) => JSON.parse(readFileSync(path.join(root, `docs/benchmarks/results/${label}.json`), "utf8"));
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "n/a" : Number(x).toFixed(1));
const f0 = (x) => (x === null || x === undefined ? "n/a" : Number(x).toFixed(0));
const goodLevels = (sc) => sc.levels.filter((l) => !l.failed);

function scenarioTable(name, sc) {
  const rows = goodLevels(sc).map((l) => {
    const c = l.cpuCores;
    return `| ${l.targetRps} | ${l.achievedRps}${l.saturated ? " ⚠" : ""} | ${f1(l.latencyMs.p50)} | ${f1(l.latencyMs.p95)} | ${f1(l.latencyMs.p99)} | ${f0(l.latencyMs.max)} | ${l.errorRatePct}% | ${c.api} | ${c.postgres} | ${c.redis} | ${c.worker} |`;
  });
  const failed = sc.levels.filter((l) => l.failed).map((l) => `- ${l.targetRps} rps did not finish: ${l.failed}`);
  return [
    `### ${sc.title}`, "",
    "| Target RPS | Achieved RPS | p50 ms | p95 ms | p99 ms | max ms | Errors | API cores | Postgres cores | Redis cores | Worker cores |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|", ...rows, "", ...failed, failed.length ? "" : null,
  ].filter((x) => x !== null).join("\n");
}

function costTable(r) {
  const rows = Object.entries(r.scenarios).map(([, sc]) => {
    const lv = goodLevels(sc);
    if (!lv.length) return null;
    const peak = lv.reduce((a, b) => (b.achievedRps > a.achievedRps ? b : a));
    const per = (cores) => f1((cores / peak.achievedRps) * 1000);
    const c = peak.cpuCores;
    return `| ${sc.title.split(" (")[0]} | ${peak.achievedRps} | ${per(c.api)} | ${per(c.postgres)} | ${per(c.redis)} | ${per(c.worker)} | ${(c.api + c.postgres + c.redis + c.worker + c.loadGenerator).toFixed(2)} |`;
  }).filter(Boolean);
  return ["| Scenario | Peak RPS | API CPU ms/request | Postgres CPU ms/request | Redis CPU ms/request | Worker CPU ms/request | Cores busy in total |", "|---|---:|---:|---:|---:|---:|---:|", ...rows].join("\n");
}

function queueTable(r) {
  const sc = r.scenarios.otp_request;
  if (!sc) return "";
  const rows = goodLevels(sc).filter((l) => l.queue).map((l) => `| ${l.targetRps} | ${l.queue.sent} | ${l.queue.failed} | ${f0(l.queue.lagMs.p50)} | ${f0(l.queue.lagMs.p95)} | ${f0(l.queue.lagMs.p99)} | ${(l.queue.drainedAfterMs / 1000).toFixed(1)} s |`);
  return ["| Target RPS | Messages sent | Failed | Lag p50 ms | Lag p95 ms | Lag p99 ms | Queue empty after load stopped |", "|---:|---:|---:|---:|---:|---:|---:|", ...rows].join("\n");
}

function envList(e) {
  return Object.entries(e).map(([k, v]) => `- **${k}**: ${v}`).join("\n");
}

function report(label, notes) {
  const r = load(label);
  return [
    notes ? notes.trimEnd() + "\n" : `# Benchmark results: ${label}\n`,
    "## Results", "",
    `Run started ${r.startedAt}, finished ${r.finishedAt}. Each level ran for ${r.durationSeconds} seconds after a short warm-up. ⚠ marks a level where the server could not keep up (achieved below 95% of the target, or more than 1% errors). Latencies are exact percentiles over every request, in milliseconds. "Cores" are CPU cores' worth of work (1.0 = one core fully busy; this machine has 4 logical CPUs).`, "",
    ...Object.entries(r.scenarios).flatMap(([n, sc]) => [scenarioTable(n, sc), ""]),
    "### CPU cost of one request, at each scenario's peak", "",
    "This is the most portable number here: the machine sets how many requests per second you get, but the work each request costs stays roughly the same.", "",
    costTable(r), "",
    "### Delivery queue (worker) under the OTP request load", "",
    "Lag is the time from the API accepting a request to the worker marking the message sent, measured on every delivery of that level.", "",
    queueTable(r), "",
    "## Environment", "", envList(r.environment), "",
    `Reproduce: \`npm run bench -- --label ${label}\` (see docs/benchmarks/README.md).`, "",
  ].join("\n");
}

function compare(a, b) {
  const A = load(a), B = load(b);
  const pctChange = (x, y) => (x ? `${(((y - x) / x) * 100).toFixed(0)}%` : "n/a");
  const out = [`# Before / after: ${a} vs ${b}`, "", `Same machine and method required for a fair comparison. Environment before: ${A.environment.machine}; after: ${B.environment.machine}.`, ""];
  for (const [name, scA] of Object.entries(A.scenarios)) {
    const scB = B.scenarios[name];
    if (!scB) continue;
    out.push(`### ${scA.title}`, "", `| Target RPS | Achieved before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after | p95 change |`, "|---:|---:|---:|---:|---:|---:|");
    for (const la of goodLevels(scA)) {
      const lb = goodLevels(scB).find((l) => l.targetRps === la.targetRps);
      if (!lb) continue;
      out.push(`| ${la.targetRps} | ${la.achievedRps} → ${lb.achievedRps} | ${f1(la.latencyMs.p50)} → ${f1(lb.latencyMs.p50)} | ${f1(la.latencyMs.p95)} → ${f1(lb.latencyMs.p95)} | ${f1(la.latencyMs.p99)} → ${f1(lb.latencyMs.p99)} | ${pctChange(la.latencyMs.p95, lb.latencyMs.p95)} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

const cmp = process.argv.indexOf("--compare");
const text = cmp > -1 ? compare(process.argv[cmp + 1], process.argv[cmp + 2]) : report(process.argv[2], arg("notes") ? readFileSync(path.join(root, arg("notes")), "utf8") : null);
if (arg("out")) { writeFileSync(path.join(root, arg("out")), text); console.log(`wrote ${arg("out")}`); } else console.log(text);
