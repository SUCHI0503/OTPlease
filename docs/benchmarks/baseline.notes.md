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
