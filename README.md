# OTPlease

Multi-tenant authentication service. Developers connect their apps, OTPlease verifies their users with a one-time code (SMS, WhatsApp, voice or email) and starts a session.

```
Your backend -> OTPlease API -> queue -> worker -> provider -> user
                     ^ verify code -> session (access + refresh tokens)
```

## Layout

| Path | What it is |
|---|---|
| `apps/server` | Fastify API (Prisma, Redis rate limits, BullMQ producers) |
| `apps/worker` | Sends OTP messages and webhooks, runs the hourly cleanup |
| `apps/web` | Next.js dashboard (create apps, API keys, webhooks, see usage) |
| `apps/demo` | Sample product that signs users in with OTPlease (reference integration, end-to-end test target) |
| `tests/` | Vitest unit and integration tests (they use a separate database and Redis DB) |

## See it working

Requires Node 24+, npm and Docker (Docker Desktop must be running).

```bash
npm install
docker compose up -d                       # Postgres, Redis, Mailpit (a local inbox for test emails)

# One-time: create apps/server/.env from the template and fill in three secrets
cp apps/server/.env.example apps/server/.env
for v in OTP_HASH_SECRET JWT_SECRET ADMIN_TOKEN; do echo "$v=$(openssl rand -hex 32)"; done   # paste these into .env
(cd apps/server && npx prisma migrate dev) # creates the tables

# Then, in four terminals:
npm run dev:api                            # the API on :4000
npm run dev:worker                         # sends the messages (watch this terminal for codes!)
npm run demo:setup && npm run dev:demo     # creates a demo application + key, then the demo app on :3002
npm run dev:dashboard                      # the developer dashboard on :3000
```

| What | Where | Notes |
|---|---|---|
| **Demo app**: a product that signs users in | http://localhost:3002 | Enter any valid phone number, e.g. `+91 98123 45678` |
| **The code** | the `dev:worker` terminal | Look for `[mock provider] sms to +91********78: code 234321`. Nothing is really sent |
| **Dashboard** | http://localhost:3000 | Sign in with `ADMIN_TOKEN` from `apps/server/.env`. Create apps and keys, add webhooks, watch usage |
| **API reference** | http://localhost:4000/docs | Interactive Swagger UI (spec at `/openapi.json`) |
| **Test emails** | http://localhost:8025 | Only used for the email channel, with `SMTP_HOST=localhost` and `SMTP_PORT=1025` set |

A good tour: sign in on the demo app, then open the dashboard and click **Demo Shop**. You will see one OTP request, one login and one new device. Sign in again from a private window to see a second device.

Without Twilio settings every phone channel uses the **mock provider**. Nothing real is ever sent.

## Run everything in Docker

One command builds and starts Postgres, Redis, Mailpit, the API, the worker, the dashboard and the demo shop:

```bash
docker compose -f docker-compose.stack.yml up --build
```

- Dashboard: http://localhost:3000 (sign in with the `ADMIN_TOKEN` in the compose file)
- Demo shop: http://localhost:3002 (it creates its own application and API key on first start)
- API docs: http://localhost:4000/docs, Mailpit: http://localhost:8025
- Stop with `docker compose -f docker-compose.stack.yml down` (add `-v` to wipe the data)

This stack is for a local demo: it uses the mock provider and throwaway secrets that are written in the compose file. Real deployments pass their own secrets (`NODE_ENV=production` refuses mock delivery and placeholder secrets). Use the plain `docker-compose.yml` when you only want the databases for `npm run dev`.

## Try the API

```bash
ADMIN=<your ADMIN_TOKEN>
# 1. create an application and an API key (or use the dashboard)
curl -X POST localhost:4000/applications -H "x-admin-token: $ADMIN" -H 'content-type: application/json' -d '{"name":"My app"}'
curl -X POST localhost:4000/applications/<id>/api-keys -H "x-admin-token: $ADMIN" -H 'content-type: application/json' \
     -d '{"name":"backend","scopes":["otp:request","otp:verify"]}'
# 2. request and verify a code with the key
curl -X POST localhost:4000/applications/<id>/otp/request -H "x-api-key: <key>" -H 'content-type: application/json' -d '{"phone":"+919876543210"}'
curl -X POST localhost:4000/applications/<id>/otp/verify  -H "x-api-key: <key>" -H 'content-type: application/json' -d '{"phone":"+919876543210","code":"123456"}'
```

Full reference: `GET /docs` (Swagger UI) or `GET /openapi.json`.

## Tests

| Level | What it checks | Command |
|---|---|---|
| Unit + integration + security | Logic, API with Postgres and Redis and the queue, attack scenarios (about 350 tests) | `npm test` |
| Coverage | Same tests, with a coverage report and a floor (90% lines, 80% branches) | `npm run test:coverage` |
| End to end | Real browsers driving the real stack: an end user signing in and out in the demo app, a developer using the dashboard, webhooks | `npm run test:e2e` |
| Everything | Types, then all of the above | `npm run test:all` |

`npm run typecheck` checks the server, worker and tests.

**Test databases.** Tests refuse to run unless `DATABASE_URL` points at `otplease_test` and `REDIS_URL` ends in `/1`. Create the test database once and apply migrations with `DATABASE_URL=... npx prisma migrate deploy`. Put those values in `apps/server/.env.test`. Tests always use the mock provider, so no real message is ever sent.

**End-to-end tests** start the whole stack themselves in separate processes on their own ports (API 4100, dashboard 3100, demo 3102), against the test database, with Twilio and SMTP switched off. The mock provider writes each code to a Redis list (`MOCK_OUTBOX_REDIS`, refused in production) so a test can read it like a user reading their phone. Reports and traces from failures land in `tests/e2e/report` and `tests/e2e/results`.

- Locally the browser is your installed **Google Chrome**. Playwright cannot download its own browser on older macOS versions.
- In CI use Playwright's browser: `npx playwright install chromium`, then `PW_CHANNEL=chromium npm run test:e2e`.
- `E2E_SKIP_BUILD=1` reuses the previous build of the two Next.js apps, which saves about 30 seconds.
- Do not run the unit tests and the end-to-end tests at the same time: they share the test database and Redis.

**The demo app** (`apps/demo`, port 3002) is a small product that signs users in with OTPlease. It doubles as the reference integration: all API calls are in `apps/demo/lib/otplease.ts`, the API key stays on the server, tokens are kept in httpOnly cookies, and the visitor's device and IP are forwarded so OTPlease can spot new devices.

## Monitoring

Health checks, Prometheus metrics and privacy-scrubbed Sentry error reports: [docs/monitoring.md](docs/monitoring.md).

## Deployment

Staging on AWS (Terraform, Docker, Nginx with HTTPS, daily backups with a tested restore, deploys after CI passes) is described in [docs/deployment.md](docs/deployment.md).

## CI

`.github/workflows/ci.yml` runs on every push and pull request, with four jobs: types + unit/integration/security tests with the coverage floor, the Playwright end-to-end suite, a dependency audit plus a gitleaks secret scan over the whole history, and a Docker build that boots the full stack and smoke-tests it. CI has no real credentials: it generates random test secrets (`scripts/ci/make-test-env.mjs`) and always uses the mock provider. The `npm audit` step fails on critical findings in production dependencies and warns on high ones (today: `deepmerge-ts` inside the Prisma CLI, fixed only by a Prisma major upgrade).

## Performance

Measured numbers, and how to repeat them, are in [docs/benchmarks](docs/benchmarks/README.md). The Phase 18 baseline ([baseline.md](docs/benchmarks/baseline.md)) shows p50/p95/p99 and CPU cost at 10 to 2000 requests per second. Rate limits and the log level can be tuned with `RATE_LIMITS_JSON` and `LOG_LEVEL` (see `apps/server/.env.example`), and `npm run build:backend` produces the plain-JavaScript build used for benchmarking.

## Security notes

- OTP codes are HMAC-hashed, expire, are single use and attempt-limited; codes are encrypted while in the job queue and never logged.
- API keys, refresh tokens and webhook secrets are stored hashed or encrypted and shown once. Webhook secrets can be rotated.
- Repeated wrong API keys or admin tokens lock the calling IP out (429). Set `TRUST_PROXY` correctly behind a proxy, or every user shares one IP.
- The three secrets (`OTP_HASH_SECRET`, `JWT_SECRET`, `ADMIN_TOKEN`) must differ, be at least 32 characters and not look like placeholders, or the server refuses to start.
- No CORS headers are sent unless `CORS_ORIGINS` lists exact origins. API responses are `no-store`, non-sniffable and non-frameable; request bodies are capped at 64 KB.
- Each application has an hourly cost cap on OTP requests (`sendCapPerHour` in its risk config, platform default 1000) that applies in every mode, plus per-phone, per-IP and per-country limits. `DELETE /applications/:id/users/:userId/sessions` ends all of a user's sessions at once.
- An audit log records who changed keys, webhooks and risk rules (`GET /audit-logs`, or per application). It never holds secrets, full phone numbers or full URLs.
- Webhooks are HMAC-signed with a timestamp (replay protection) and blocked from private addresses (SSRF).
- `WEBHOOK_ALLOW_PRIVATE_URLS` is for local development only; the server refuses to start with it in production.
- Logs are scrubbed of credentials, codes, tokens and phone numbers, and crash logs omit error messages (database errors can echo values).

The `tests/security` folder holds the attack tests: they are generated from the registered routes, so a new route without authentication or a tenant check fails them automatically.
