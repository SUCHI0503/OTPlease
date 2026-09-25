# OTPlease

[![CI](https://github.com/SUCHI0503/OTPlease/actions/workflows/ci.yml/badge.svg)](https://github.com/SUCHI0503/OTPlease/actions/workflows/ci.yml)

A multi-tenant authentication service. Developers connect their apps to OTPlease; it verifies their users with a one-time code (OTP) sent by **WhatsApp, SMS, email or voice**, then creates a secure login session.

```
Developer's backend ──► OTPlease API ──► queue ──► worker ──► provider ──► the user's phone or inbox
                              ▲
   verify the code ───────────┘──► session (access token + rotating refresh token)
```

Each developer's data is fully isolated (an "application" is a tenant), the API replies immediately while a background worker sends the message, and every layer that touches secrets, cost or abuse has its own protection and its own test.

## Contents

[Features](#features) · [Project status](#project-status) · [Quick start](#quick-start) · [Using the API](#using-the-api) · [Configuration](#configuration) · [Architecture](#architecture) · [Security](#security) · [Testing](#testing) · [Performance](#performance) · [Deployment and monitoring](#deployment-and-monitoring) · [Documentation](#documentation)

## Features

**Core**
- Multi-tenant model with isolation proven by tests (tenant A cannot read or affect tenant B, including with a valid key for A).
- OTP engine: random 6-digit codes, HMAC-hashed at rest, 5-minute expiry, 5 attempts, single use, and exactly one active code per user even under concurrent requests.
- Sessions: short-lived JWT access tokens tied to a server-side session row, rotating refresh tokens with reuse detection, logout and revoke-all, all effective immediately on the server.
- Redis rate limiting and brute-force protection (per phone, per IP, per country, per tenant), background queue with retries and backoff.

**Delivery**
- WhatsApp, SMS and voice through Twilio (WhatsApp via approved templates), email through SMTP, all behind one provider interface with a mock provider for development and tests.
- Fallback chains (for example SMS, then WhatsApp) and delivery-status callbacks with signature verification.
- Phone numbers normalised to E.164. E-mail can be requested per call, with the phone number as the user's identity.

**Platform**
- API keys: hashed, revocable, shown once, with scopes (`otp:request`, `otp:verify`, `users:read`, `webhooks:manage`, and so on).
- Signed webhooks with replay protection and SSRF blocking, secret rotation, and per-attempt delivery logs.
- Developer dashboard (Next.js): create applications and keys, manage webhooks, see usage analytics, deliveries, devices, risk decisions and the audit log.
- OpenAPI 3 spec generated from the same Zod schemas the API validates with, served as Swagger UI at `/docs`.

**Intelligence and security**
- Device and IP intelligence: new-device and new-IP detection, velocity signals.
- Rule-based risk engine (allow, challenge or block) with configurable rules; modes `off`, `log` and `enforce`.
- Security hardening: audit log, CORS allow-list, security headers, startup checks that refuse weak or reused secrets, scrubbed logs, and generated attack tests.

**Operations**
- Docker images and a one-command full stack; CI on every push; Terraform, Nginx with HTTPS, backups with a tested restore for a staging deployment on AWS.
- Health and readiness checks, Prometheus metrics, and privacy-scrubbed Sentry error reports.

## Project status

Built in 22 phases, one branch each. Honest status:

| Area | Status | How it was verified |
|---|---|---|
| API, OTP engine, sessions, rate limits, queue, webhooks, API keys, risk engine, dashboard | Done | 351 automated tests, 13 browser end-to-end tests |
| Email delivery | Done and tried for real | A real code sent through Gmail SMTP, received and verified |
| WhatsApp, SMS, voice delivery | Code done, **not yet proven on real phones** | Tested against Twilio's exact request format and signature scheme, and the mock provider. Live delivery needs a paid Twilio account (trial accounts cannot create WhatsApp templates or message unverified numbers) |
| Docker, CI | Done | The full stack boots in CI and is smoke-tested on every push |
| Staging on AWS | Code written and tested locally, **not yet run on AWS** | Terraform validates, Nginx config is valid, the staging stack boots in production mode, the backup restore test passes and fails when it should. Needs an AWS account and a domain |
| Monitoring and optimisation | Done | See [docs/monitoring.md](docs/monitoring.md) and [docs/benchmarks/phase-22.md](docs/benchmarks/phase-22.md) |

Known limits: the dashboard is an operator console (sign-in with the platform admin token), not yet a self-service portal with developer accounts; spend caps count messages, not currency; billing, GDPR-style deletion and a client SDK are out of scope for now.

## Quick start

Requires Node 24+, npm and Docker (Docker Desktop must be running).

### Option 1: everything in Docker (one command)

```bash
docker compose -f docker-compose.stack.yml up --build
```

| What | Where |
|---|---|
| Demo shop (a product that signs users in) | http://localhost:3002 |
| Developer dashboard (sign in with the `ADMIN_TOKEN` in the compose file) | http://localhost:3000 |
| API reference (Swagger UI) | http://localhost:4000/docs |
| Test inbox for the email channel | http://localhost:8025 |

The stack uses the mock provider and throwaway secrets written in the compose file, so it is for local demos only. Stop it with `docker compose -f docker-compose.stack.yml down` (add `-v` to wipe its data).

### Option 2: develop locally

```bash
npm install
docker compose up -d                       # Postgres, Redis, Mailpit (a local inbox for test emails)

# One-time: create apps/server/.env from the template and fill in three secrets
cp apps/server/.env.example apps/server/.env
for v in OTP_HASH_SECRET JWT_SECRET ADMIN_TOKEN; do echo "$v=$(openssl rand -hex 32)"; done   # paste these into .env
(cd apps/server && npx prisma migrate dev) # creates the tables

# Then, in four terminals:
npm run dev:api                            # the API on :4000
npm run dev:worker                         # sends the messages (watch this terminal for codes)
npm run demo:setup && npm run dev:demo     # creates a demo application + key, then the demo app on :3002
npm run dev:dashboard                      # the developer dashboard on :3000
```

Without Twilio settings every phone channel uses the **mock provider**: nothing real is sent, and the worker prints each code, for example `[mock provider] sms to +91********78: code 234321`.

A good tour: sign in on the demo app, then open the dashboard and click **Demo Shop**. You will see one OTP request, one login and one new device. Sign in again from a private window to see a second device.

## Using the API

```bash
ADMIN=$(grep '^ADMIN_TOKEN=' apps/server/.env | cut -d= -f2- | tr -d '"')

# 1. Create an application (a tenant) and an API key for its backend
curl -X POST localhost:4000/applications -H "x-admin-token: $ADMIN" -H 'content-type: application/json' -d '{"name":"My app"}'
curl -X POST localhost:4000/applications/APP_ID/api-keys -H "x-admin-token: $ADMIN" -H 'content-type: application/json' \
     -d '{"name":"backend","scopes":["otp:request","otp:verify"]}'      # the key is shown once

# 2. Request a code (channel: sms | whatsapp | voice | email; optional fallback list)
curl -X POST localhost:4000/applications/APP_ID/otp/request -H "x-api-key: API_KEY" -H 'content-type: application/json' \
     -d '{"phone":"+919876543210","channel":"sms","fallback":["whatsapp"]}'

# 3. Verify it; success returns the user and an access and a refresh token
curl -X POST localhost:4000/applications/APP_ID/otp/verify -H "x-api-key: API_KEY" -H 'content-type: application/json' \
     -d '{"phone":"+919876543210","code":"123456"}'
```

Replace `APP_ID` and `API_KEY` with the values from the earlier responses; do not type the angle brackets that some examples use.

- **Email:** send `"channel":"email","email":"user@example.com"` together with the phone number that identifies the user.
- **Sessions:** `POST /auth/refresh` rotates the refresh token, `POST /auth/logout` ends the session, `GET /auth/me` checks it. Reusing an old refresh token revokes the whole session.
- **Errors** are always `{ "error": { "code", "message", "details?" } }`, and rate limits answer `429` with `Retry-After`.
- **Webhooks** are signed and carry `otp.verified`, `device.new`, `risk.challenged`, `risk.blocked`, `delivery.sent`, `delivery.delivered` and `delivery.failed`.
- **Full reference:** `GET /docs` (Swagger UI) or `GET /openapi.json`.

## Configuration

Settings come from environment variables, validated at startup: the server refuses to start with anything missing, weak, reused or unsafe. The annotated template is [apps/server/.env.example](apps/server/.env.example).

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Postgres and Redis |
| `OTP_HASH_SECRET`, `JWT_SECRET`, `ADMIN_TOKEN` | Three different secrets, at least 32 characters (`openssl rand -hex 32`) |
| `TWILIO_*` | SMS, WhatsApp (`TWILIO_WHATSAPP_CONTENT_SID` for the approved template) and voice; unset means the mock provider |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Real email; local Mailpit needs only host and port |
| `TRUST_PROXY` | Number of trusted proxy hops. Set it behind Nginx or a load balancer, or every user shares one IP |
| `CORS_ORIGINS` | Exact browser origins allowed to call the API; empty means no CORS |
| `RATE_LIMITS_JSON`, `LOG_LEVEL` | Tune limits and logging without a code change |
| `SENTRY_DSN` | Optional error reporting |
| `DEPLOY_ENV`, `ALLOW_MOCK_PROVIDERS` | Staging only: production mode with mock phone channels. Production refuses this |

`NODE_ENV=production` additionally refuses the mock provider, mock outbox and private webhook URLs.

## Architecture

| Path | What it is |
|---|---|
| `apps/server` | Fastify API: Prisma (Postgres 16), Redis rate limits, BullMQ producers, OpenAPI |
| `apps/worker` | BullMQ worker: sends OTP messages and webhooks with retries, hourly cleanup of expired data |
| `apps/web` | Next.js developer dashboard |
| `apps/demo` | Sample product that signs users in with OTPlease (reference integration and end-to-end test target) |
| `tests/` | Unit, integration, security and Playwright end-to-end tests |
| `docker/`, `docker-compose*.yml` | Images, local infrastructure, and the one-command full stack |
| `deploy/` | Terraform, Nginx, backup and restore scripts for the staging server |
| `scripts/` | Backend bundler, demo setup, benchmark harness, CI helpers |
| `docs/` | Deployment, monitoring and benchmark documents |
| `.github/workflows/` | CI and the staging deploy workflow |

Stack: Turborepo with npm workspaces, TypeScript on Node.js, Fastify, PostgreSQL 16 with Prisma 6, Redis, BullMQ, Zod, Next.js, Vitest and Playwright, Docker, GitHub Actions, Terraform.

## Security

- OTP codes are HMAC-hashed, expire, are single use and attempt-limited; codes are encrypted while in the job queue and never logged.
- API keys, refresh tokens and webhook secrets are stored hashed or encrypted and shown once. Webhook secrets can be rotated.
- Repeated wrong API keys or admin tokens lock the calling IP out (429).
- The three secrets must differ, be at least 32 characters and not look like placeholders, or the server refuses to start.
- No CORS headers are sent unless `CORS_ORIGINS` lists exact origins. API responses are `no-store`, non-sniffable and non-frameable; request bodies are capped at 64 KB.
- Each application has an hourly cost cap on OTP requests (`sendCapPerHour`, platform default 1000) in every risk mode, plus per-phone, per-IP and per-country limits against SMS pumping.
- An audit log records who changed keys, webhooks and risk rules. It never holds secrets, full phone numbers or full URLs.
- Webhooks are HMAC-signed with a timestamp and blocked from private addresses (SSRF).
- Logs are scrubbed of credentials, codes, tokens and phone numbers. Error reports to Sentry carry no request data and no exception messages.
- CI scans dependencies (`npm audit`) and the whole git history (gitleaks) for secrets.

The `tests/security` folder holds the attack tests: they are generated from the registered routes, so a new route without authentication or a tenant check fails them automatically.

## Testing

| Level | What it checks | Command |
|---|---|---|
| Unit + integration + security | Logic, the API with Postgres, Redis and the queue, attack scenarios (351 tests) | `npm test` |
| Coverage | Same tests with a floor of 90% lines and 80% branches (currently 95% and 85%) | `npm run test:coverage` |
| End to end | Real browsers driving the real stack: a user signing in and out, a developer using the dashboard, webhooks (13 tests) | `npm run test:e2e` |
| Everything | Types first, then all of the above | `npm run test:all` |

`npm run typecheck` checks the server, worker and tests.

**Tests never touch real services.** They refuse to run unless `DATABASE_URL` points at `otplease_test` and `REDIS_URL` ends in `/1`; put those in `apps/server/.env.test` (create the database once and run `prisma migrate deploy` against it). They always use the mock provider, and real provider settings from your `.env` are blanked out for test runs. Do not run unit and end-to-end tests at the same time: they share the test database.

**End-to-end tests** start the whole stack themselves on their own ports (API 4100, dashboard 3100, demo 3102). The mock provider writes each code to a Redis list (`MOCK_OUTBOX_REDIS`, refused in production) so a test can read it like a user reads their phone. Failure reports and traces land in `tests/e2e/report` and `tests/e2e/results`. Locally the browser is your installed Google Chrome; in CI use `npx playwright install chromium` and `PW_CHANNEL=chromium`. `E2E_SKIP_BUILD=1` reuses the previous Next.js build.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request: types, tests with the coverage floor, the end-to-end suite, a dependency audit plus secret scan, and a Docker build that boots the full stack. CI generates random test secrets and has no real credentials. The audit fails on critical findings in production dependencies and warns on high ones (today one: `deepmerge-ts` inside the Prisma CLI, fixable only by a Prisma major upgrade).

## Performance

Real measurements with the method to repeat them, in [docs/benchmarks](docs/benchmarks/README.md). All runs use the mock provider on one older laptop (4 logical CPUs) running the load generator, API, worker, Postgres and Redis together, so absolute numbers are modest and only comparisons on the same machine mean anything.

| Endpoint | Comfortable up to (Phase 18 baseline) |
|---|---|
| `GET /health` | 2000+ requests per second (p99 137 ms) |
| `GET /auth/me` | 100 requests per second (p99 32 ms) |
| `POST /otp/request` | about 50 requests per second (p50 177 ms, p99 284 ms) |
| `POST /otp/verify` | about 50 requests per second (p50 118 ms, p99 189 ms) |

The Phase 22 optimisations (fewer Redis and Postgres round trips, behaviour unchanged) lowered the OTP request median by 10 to 16% against a same-session run of the code before them, and about 2 to 9% against the Phase 18 baseline; tail latencies on this machine are noise. Postgres CPU is the limit, so the next gains need a dedicated server, less database work per request, and several API processes. Details and caveats: [docs/benchmarks/phase-22.md](docs/benchmarks/phase-22.md).

## Deployment and monitoring

Staging on AWS: Terraform creates one server and a private backup bucket; Docker Compose runs the stack behind Nginx with HTTPS; a daily backup goes to S3 and a script proves the restore works; a workflow deploys `main` after CI passes. Staging runs email for real and WhatsApp, SMS and voice on the mock provider (with a warning at every start). See [docs/deployment.md](docs/deployment.md).

Health checks (`/health`, `/health/ready`), Prometheus metrics (`/metrics`, operator only), structured logs and privacy-scrubbed Sentry reports are described in [docs/monitoring.md](docs/monitoring.md).

Before real users: a paid Twilio account (or the Meta WhatsApp Business route) with an approved WhatsApp template, email from your own domain (SPF and DKIM), and a separate production environment.

## Documentation

| Document | Contents |
|---|---|
| [docs/deployment.md](docs/deployment.md) | Staging on AWS step by step, backups and restore, what to change before real users |
| [docs/monitoring.md](docs/monitoring.md) | Health checks, metrics, logs, Sentry, suggested alerts |
| [docs/benchmarks/](docs/benchmarks/README.md) | Benchmark method, the Phase 18 baseline, the Phase 22 results |
| `GET /docs` on a running API | Interactive OpenAPI reference |

## License

MIT, see [LICENSE](LICENSE).
