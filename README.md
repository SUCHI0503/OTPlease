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
| `tests/` | Vitest unit and integration tests (they use a separate database and Redis DB) |

## Run it locally

Requires Node 24+, npm and Docker.

```bash
npm install
docker compose up -d          # Postgres, Redis, Mailpit (local email inbox)

# apps/server/.env (see apps/server/.env.example for every variable)
#   DATABASE_URL, OTP_HASH_SECRET, JWT_SECRET, ADMIN_TOKEN, REDIS_URL
#   generate secrets with: openssl rand -hex 32
cd apps/server && npx prisma migrate dev && cd ../..

# in three terminals
npm run dev -w server         # API on :4000  (docs at http://localhost:4000/docs)
npm run dev -w worker         # sends messages and webhooks
npm run dev -w web            # dashboard on :3000, sign in with ADMIN_TOKEN
```

Without Twilio settings every phone channel uses the **mock provider**, which prints the code (masked recipient) to the worker terminal in development. Nothing real is ever sent.

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

## Tests and checks

```bash
npm run typecheck             # server, worker and the tests
cd apps/server && npx vitest run
```

Tests refuse to run unless `DATABASE_URL` points at `otplease_test` and `REDIS_URL` ends in `/1`. Create the test database once and apply migrations with `DATABASE_URL=... npx prisma migrate deploy`.

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
