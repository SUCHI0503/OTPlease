# Baseline benchmark (Phase 18)

The "before" measurement. Phase 22 repeats it after optimising and compares against these numbers.

**Provider: mock.** Every message in these runs went to the mock provider, so no real SMS, WhatsApp, voice call or email was sent, and provider network time is not included. Real providers add their own latency, but that happens in the worker after the API has already replied.

## Summary

| Endpoint | Comfortable up to (this machine) | What happens beyond |
|---|---|---|
| `GET /health` (framework alone) | 2000 RPS and beyond: p99 137 ms, API using a third of a core | not reached |
| `GET /auth/me` (session check) | **100 RPS**: p50 12.6 ms, p95 22.7 ms, p99 31.8 ms | saturates near 440 to 720 RPS |
| `POST /otp/request` | **50 RPS**: p50 177 ms, p95 247 ms, p99 284 ms | saturates near 52 to 66 RPS |
| `POST /otp/verify` | **50 RPS**: p50 118 ms, p95 159 ms, p99 189 ms | saturates near 77 to 92 RPS |

Against the scope's levels (10, 50, 100, 500, 1000+ RPS): 10 and 50 RPS are met by every endpoint with no errors. 100 RPS is met by `/health` and `/auth/me`, while OTP request and verify already fall short (52 and 77 RPS achieved). 500 RPS is met only by `/health`. 1000+ RPS is met only by `/health`. **On this machine, with a single API process, the write paths (requesting and verifying codes) top out at roughly 50 to 90 requests per second.** That is far below the 500 to 1000+ RPS levels in the scope, and it is the main finding of this phase.

Under overload the system degrades without breaking: at 2000 target RPS the OTP endpoints answered every request they accepted (0 failed messages), with a small number of connection errors (1.4% for request, 0.5% for verify) and latency growing into seconds. Nothing crashed, no message was lost, and the worker emptied its queue within a second of the load stopping.

## What limits it

The framework is not the problem. `/health` sustained 2000 RPS while using 0.33 of a core. The cost is in the work each real request does:

| Per request, at peak | API (incl. Prisma engine) | Postgres | Redis | Worker |
|---|---:|---:|---:|---:|
| `/auth/me` | 1.8 ms CPU | 2.1 ms | 0.1 ms | none |
| `/otp/verify` | 11.4 ms | 12.7 ms | 2.3 ms | none |
| `/otp/request` | 12.4 ms | **22.9 ms** | 7.4 ms | 4.1 ms |

- **Postgres is the largest cost on the write path**: about 23 ms of CPU per OTP request, roughly half of everything spent on it. A separate in-process measurement counted about 8 Postgres transactions and about 24 Redis commands per OTP request, made one after another.
- **At saturation the whole machine is busy**: about 3.0 to 3.1 of its 4 logical CPUs across API, Postgres, Redis and the worker (2.5 for verify). So part of these limits belongs to this laptop, which is why the CPU-per-request table above is the more portable result than the requests-per-second numbers.
- **The worker and queue are not bottlenecks.** Delivery lag (API accepts, worker sends) was p95 of 52 to 65 ms up to 100 RPS, and its p95 stayed under 0.75 s even at 2000 RPS of overload (worst single message 0.84 s). Every accepted request became a sent message (0 failed).
- **Low-load latency is high for a write.** An OTP request takes p50 134 ms even at 10 RPS, against 14 ms for `/auth/me`. That comes from the many sequential round trips, not from load.

## Candidates for Phase 22 (hypotheses, to be proven by measurement)

None of these has been tried. Phase 22 should change one thing at a time and re-run this benchmark.

1. **Fewer database round trips on the OTP paths.** Cache the API key check, application existence and risk config for a short time. Skip the transaction and advisory lock when the user has no active code.
2. **Fewer Redis round trips.** Run the rate-limit rules in one round trip instead of one per rule, and skip the failed-authentication check on the normal path.
3. **More than one API process.** The API is single-process, and Prisma's engine and Node share one process. Running several instances behind Nginx, and a database sized for it, is the route to the scope's 500 to 1000+ RPS.
4. **A Postgres tuned beyond Docker's defaults.**
5. **`/auth/me`:** a short-lived cache of session validity would cut its database work, but it must keep the guarantee that logout takes effect immediately (invalidate on revoke).

## How much to trust these numbers

- **Same machine for everything.** The load generator, API, worker, Postgres (in Docker) and Redis all shared one older laptop (Intel Core i5-5350U, 2 cores and 4 logical CPUs, 8 GB RAM, already using about 1.3 GB of swap from other applications). A dedicated environment will give higher numbers. Compare runs only against runs on the same machine.
- **One run per level, 20 seconds each.** Differences below about 10% are within noise. No confidence intervals.
- **The load generator is "closed loop"** (it waits for answers). When the server is saturated, latencies therefore look better than a real crowd would experience, so a level marked ⚠ (achieved below target) should be read as "over capacity", not as its exact latency.
- **Logging stayed on** (`info`, written to a file), as it would be in production.
- **Rate limits were raised** so the limiters were not what was measured. Users were unique per request, so no database row was contended.
- **A first attempt was thrown away.** My own resource sampler blocked the load generator, so it delivered about half the target rate with inflated latencies. It was fixed and checked against the target rates before this run, and a second attempt was stopped when the laptop ran out of memory (the harness now saves after every level, limits each level's time and caps the seed data).

## Results

Run started 2026-09-24T15:49:36.406Z, finished 2026-09-24T16:00:59.251Z. Each level ran for 20 seconds after a short warm-up. ⚠ marks a level where the server could not keep up (achieved below 95% of the target, or more than 1% errors). Latencies are exact percentiles over every request, in milliseconds. "Cores" are CPU cores' worth of work (1.0 = one core fully busy; this machine has 4 logical CPUs).

### GET /health (framework baseline)

| Target RPS | Achieved RPS | p50 ms | p95 ms | p99 ms | max ms | Errors | API cores | Postgres cores | Redis cores | Worker cores |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 3.6 | 6.9 | 7.9 | 8 | 0% | 0.01 | 0 | 0.01 | 0 |
| 50 | 50 | 2.7 | 7.6 | 11.9 | 30 | 0% | 0.02 | 0 | 0.01 | 0 |
| 100 | 101.5 | 2.0 | 9.5 | 26.3 | 100 | 0% | 0.03 | 0 | 0.01 | 0 |
| 500 | 504.2 | 8.3 | 15.9 | 21.1 | 138 | 0% | 0.11 | 0 | 0.02 | 0 |
| 1000 | 1005 | 15.7 | 31.1 | 53.2 | 184 | 0% | 0.17 | 0.03 | 0.03 | 0 |
| 2000 | 2008.2 | 32.4 | 83.5 | 136.9 | 817 | 0.007% | 0.33 | 0.01 | 0.02 | 0 |


### GET /auth/me (session check: JWT + one DB query)

| Target RPS | Achieved RPS | p50 ms | p95 ms | p99 ms | max ms | Errors | API cores | Postgres cores | Redis cores | Worker cores |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 14.0 | 21.2 | 25.2 | 27 | 0% | 0.03 | 0.01 | 0.02 | 0 |
| 50 | 50 | 14.9 | 25.7 | 33.1 | 44 | 0% | 0.12 | 0.07 | 0.01 | 0 |
| 100 | 100 | 12.6 | 22.7 | 31.8 | 73 | 0% | 0.22 | 0.09 | 0.01 | 0 |
| 500 | 438.9 ⚠ | 95.1 | 190.5 | 333.1 | 512 | 0% | 0.93 | 1.57 | 0.04 | 0 |
| 1000 | 624.3 ⚠ | 141.1 | 294.8 | 392.5 | 473 | 0% | 1.18 | 1.67 | 0.03 | 0 |
| 2000 | 720.2 ⚠ | 262.9 | 371.6 | 483.4 | 667 | 0% | 1.32 | 1.54 | 0.04 | 0 |


### POST /otp/request (creates user + code, queues the message)

| Target RPS | Achieved RPS | p50 ms | p95 ms | p99 ms | max ms | Errors | API cores | Postgres cores | Redis cores | Worker cores |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 134.1 | 220.6 | 277.5 | 285 | 0% | 0.15 | 0.11 | 0.05 | 0.05 |
| 50 | 49.6 | 176.9 | 246.9 | 283.7 | 313 | 0% | 0.74 | 1.06 | 0.41 | 0.24 |
| 100 | 51.8 ⚠ | 181.6 | 279.4 | 429.8 | 571 | 0% | 0.77 | 1.21 | 0.45 | 0.25 |
| 500 | 62 ⚠ | 793.3 | 960.9 | 1017.4 | 1085 | 0% | 0.81 | 1.24 | 0.4 | 0.26 |
| 1000 | 66.3 ⚠ | 1469.9 | 1665.6 | 1709.7 | 1753 | 0% | 0.82 | 1.52 | 0.49 | 0.27 |
| 2000 | 64 ⚠ | 2960.4 | 5741.2 | 6691.4 | 10015 | 1.386% | 0.81 | 1.19 | 0.38 | 0.24 |


### POST /otp/verify (correct code: creates a session)

| Target RPS | Achieved RPS | p50 ms | p95 ms | p99 ms | max ms | Errors | API cores | Postgres cores | Redis cores | Worker cores |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 10 | 114.5 | 211.3 | 257.2 | 267 | 0% | 0.13 | 0.07 | 0.02 | 0 |
| 50 | 50 | 118.4 | 158.7 | 189.0 | 197 | 0% | 0.63 | 0.69 | 0.2 | 0 |
| 100 | 76.9 ⚠ | 124.1 | 175.8 | 253.8 | 289 | 0% | 0.97 | 1.3 | 0.2 | 0 |
| 500 | 87.4 ⚠ | 553.6 | 670.9 | 736.8 | 787 | 0% | 1.02 | 1.33 | 0.19 | 0 |
| 1000 | 81 ⚠ | 1154.7 | 1669.7 | 1770.3 | 1839 | 0% | 1 | 1.33 | 0.16 | 0 |
| 2000 | 92.3 ⚠ | 2091.2 | 2407.5 | 4257.3 | 4548 | 0.485% | 1.05 | 1.17 | 0.21 | 0 |


### CPU cost of one request, at each scenario's peak

This is the most portable number here: the machine sets how many requests per second you get, but the work each request costs stays roughly the same.

| Scenario | Peak RPS | API CPU ms/request | Postgres CPU ms/request | Redis CPU ms/request | Worker CPU ms/request | Cores busy in total |
|---|---:|---:|---:|---:|---:|---:|
| GET /health | 2008.2 | 0.2 | 0.0 | 0.0 | 0.0 | 0.60 |
| GET /auth/me | 720.2 | 1.8 | 2.1 | 0.1 | 0.0 | 3.02 |
| POST /otp/request | 66.3 | 12.4 | 22.9 | 7.4 | 4.1 | 3.13 |
| POST /otp/verify | 92.3 | 11.4 | 12.7 | 2.3 | 0.0 | 2.46 |

### Delivery queue (worker) under the OTP request load

Lag is the time from the API accepting a request to the worker marking the message sent, measured on every delivery of that level.

| Target RPS | Messages sent | Failed | Lag p50 ms | Lag p95 ms | Lag p99 ms | Queue empty after load stopped |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 210 | 0 | 36 | 63 | 86 | 0.0 s |
| 50 | 1004 | 0 | 30 | 65 | 84 | 0.0 s |
| 100 | 1053 | 0 | 29 | 52 | 122 | 0.3 s |
| 500 | 1294 | 0 | 107 | 162 | 191 | 0.8 s |
| 1000 | 1364 | 0 | 261 | 565 | 603 | 0.3 s |
| 2000 | 1368 | 0 | 484 | 729 | 780 | 0.8 s |

## Environment

- **machine**: Intel(R) Core(TM) i5-5350U CPU @ 1.80GHz, 4 logical CPUs, 8 GB RAM
- **os**: Darwin 21.6.0
- **node**: v24.21.0
- **postgres**: PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2)
- **redis**: 7.4.11
- **dockerVm**: 4 CPUs, 4104380416 bytes
- **apiProcess**: node apps/server/dist/index.js (single process, single thread)
- **workerProcess**: node apps/worker/dist/index.js (concurrency 10 per queue)
- **prismaPoolSize**: default: 9 connections (logical CPUs x 2 + 1)
- **logLevel**: info
- **provider**: mock (no real messages are sent)
- **systemAtStart**: load average 2.4 / 7.4 / 8.0, total = 3072.00M  used = 1369.50M  free = 1702.50M  (encrypted)
- **rateLimits**: raised to 10,000,000 per window so limiters are not measured
- **loadGenerator**: autocannon 8.0.0, same machine

Reproduce: `npm run bench -- --label baseline` (see docs/benchmarks/README.md).
