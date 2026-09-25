# Phase 22: optimisation results

What changed, what it bought, and how far to trust it. **Mock provider throughout; one laptop runs the load generator,
API, worker, Postgres and Redis together** (see [baseline.md](baseline.md) for the machine and the caveats, which all still apply).

## Headline

The optimisations are real but **modest: about 10 to 16% lower median latency on the OTP request path and 6 to 13% more
throughput at saturation, measured against a fresh run of the code just before the change.** They are not an 80% result, and
nothing in this phase should be quoted as one. The Phase 18 conclusion still stands: Postgres CPU is the limit
(about 1.2 to 1.5 cores of the machine's 4 at saturation), and the changes below trim round trips but do not remove that work.

## What changed (behaviour is identical; 351 unit, integration and security tests and 13 end-to-end tests pass)

| Change | Effect |
|---|---|
| Rate-limit rules sent to Redis in one pipeline instead of one round trip per rule | `/otp/request` counts 3 rules: 3 round trips became 1. Every rule is still counted on every call; a Redis error still fails the request closed. |
| Authentication lockout check reads one Redis key on the normal path (was two commands) | Every authenticated request. The TTL is read only when an IP is actually near lockout. |
| `/otp/request` no longer runs a separate "does the application exist" query, and reads the risk config and the user together | An API key can only exist for an existing application, and this route accepts only API keys. 4 sequential reads became 2 concurrent ones. |
| `/otp/verify` finds the user and their newest unused code in one joined query | 2 sequential queries became 1. Unknown phone and "no active code" still return the same error. |

Not done on purpose: caching API keys or the risk configuration. A cache would delay revocation and configuration changes, which the
scope treats as immediate. Holding the per-user advisory lock only when a code is active would weaken the guarantee of one active code
per user under concurrency. These stay as options if a future load justifies the trade.

## Measured: before this phase's changes vs after (same session, same machine, same options)

Options: `--scenarios me,otp_request,otp_verify --levels 10,50,100,500 --duration 20`. `/auth/me` is unchanged code and is the noise
control: its p95 moved from -18% to +132% between two identical runs, so **p95 and p99 differences on this machine are noise**. Only
shifts that are consistent across levels (medians, and the throughput where the machine saturates) carry information.

### GET /auth/me (session check: JWT + one DB query)

| Target RPS | Achieved before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after | p95 change |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 → 10 | 16.6 → 15.5 | 27.8 → 22.7 | 32.7 → 25.3 | -18% |
| 50 | 50 → 50 | 16.1 → 17.0 | 31.0 → 32.1 | 41.6 → 45.5 | 3% |
| 100 | 100 → 103.5 | 17.7 → 13.1 | 32.0 → 74.3 | 42.8 → 195.8 | 132% |
| 500 | 499.8 → 500.1 | 80.3 → 74.2 | 122.5 → 114.1 | 147.2 → 142.8 | -7% |

### POST /otp/request (creates user + code, queues the message)

| Target RPS | Achieved before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after | p95 change |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 → 10 | 146.5 → 123.3 | 250.8 → 230.1 | 262.6 → 250.5 | -8% |
| 50 | 38.7 → 49.5 | 204.6 → 173.1 | 549.4 → 253.5 | 797.8 → 433.7 | -54% |
| 100 | 47.3 → 58.6 | 189.3 → 164.8 | 301.9 → 226.2 | 610.3 → 253.9 | -25% |
| 500 | 58.6 → 66 | 807.7 → 729.8 | 1119.8 → 936.4 | 1268.2 → 973.1 | -16% |

### POST /otp/verify (correct code: creates a session)

| Target RPS | Achieved before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after | p95 change |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 → 10 | 115.4 → 96.6 | 171.5 → 158.7 | 177.3 → 173.5 | -7% |
| 50 | 50 → 49.9 | 117.9 → 121.7 | 184.9 → 274.3 | 284.1 → 471.4 | 48% |
| 100 | 82.5 → 91.2 | 114.3 → 105.8 | 154.8 → 141.4 | 235.4 → 162.1 | -9% |
| 500 | 89.6 → 94.8 | 540.0 → 497.0 | 671.3 → 703.7 | 771.7 → 731.7 | 5% |



Reading it: the median of `/otp/request` fell 16%, 15%, 13% and 10% at the four levels; at 50 requests per second the target rate is now met
(49.5 achieved, against 38.7 before), and the saturation point rose from about 59 to 66 requests per second. `/otp/verify` medians
moved -16%, +3%, -7% and -8%, saturation from 89.6 to 94.8. Those are small and partly inside the noise.

## Measured: against the Phase 18 baseline

The fresh "before" run was itself slightly slower than the Phase 18 baseline on unchanged code (`/auth/me` median 14.0 to 16.6 ms at 10 requests per
second). Two causes are possible and I cannot separate them with these runs: the request-timing metrics added earlier in this phase
(one histogram update per request), and ordinary run-to-run and thermal variation on this laptop. Against the older baseline the net gain is smaller:

### GET /auth/me (session check: JWT + one DB query)

| Target RPS | Achieved before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after | p95 change |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 → 10 | 14.0 → 15.5 | 21.2 → 22.7 | 25.2 → 25.3 | 7% |
| 50 | 50 → 50 | 14.9 → 17.0 | 25.7 → 32.1 | 33.1 → 45.5 | 25% |
| 100 | 100 → 103.5 | 12.6 → 13.1 | 22.7 → 74.3 | 31.8 → 195.8 | 227% |
| 500 | 438.9 → 500.1 | 95.1 → 74.2 | 190.5 → 114.1 | 333.1 → 142.8 | -40% |

### POST /otp/request (creates user + code, queues the message)

| Target RPS | Achieved before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after | p95 change |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 → 10 | 134.1 → 123.3 | 220.6 → 230.1 | 277.5 → 250.5 | 4% |
| 50 | 49.6 → 49.5 | 176.9 → 173.1 | 246.9 → 253.5 | 283.7 → 433.7 | 3% |
| 100 | 51.8 → 58.6 | 181.6 → 164.8 | 279.4 → 226.2 | 429.8 → 253.9 | -19% |
| 500 | 62 → 66 | 793.3 → 729.8 | 960.9 → 936.4 | 1017.4 → 973.1 | -3% |

### POST /otp/verify (correct code: creates a session)

| Target RPS | Achieved before → after | p50 ms before → after | p95 ms before → after | p99 ms before → after | p95 change |
|---:|---:|---:|---:|---:|---:|
| 10 | 10 → 10 | 114.5 → 96.6 | 211.3 → 158.7 | 257.2 → 173.5 | -25% |
| 50 | 50 → 49.9 | 118.4 → 121.7 | 158.7 → 274.3 | 189.0 → 471.4 | 73% |
| 100 | 76.9 → 91.2 | 124.1 → 105.8 | 175.8 → 141.4 | 253.8 → 162.1 | -20% |
| 500 | 87.4 → 94.8 | 553.6 → 497.0 | 670.9 → 703.7 | 736.8 → 731.7 | 5% |



Against Phase 18 the median of `/otp/request` is 8%, 2% and 9% lower at 10, 50 and 100 requests per second. That is the number I would
quote as the end-to-end improvement of this project so far: **a few percent to about 10% on the OTP request path**, with the new monitoring included.

## What I would do next, in order of expected value

1. **Repeat on the target hardware.** A dedicated server, with the load generator on a different machine, will move every number here. The comparison method carries over; the absolute numbers do not.
2. **Cut Postgres work per request.** About 8 statements run for one OTP request (transaction with advisory lock, code insert, delivery insert, user lookup, key lookup, risk config). Merging the delivery and code writes, or moving `lastUsedAt` and analytics to batch updates, would attack the real bottleneck.
3. **Several API processes behind Nginx**, once the database is sized for it (Phase 21 hardware).
4. Run each configuration three times and report the spread, so improvements below about 10% can be judged.

Raw data: `results/before-opt.json`, `results/after-opt.json`, `results/baseline.json`.
