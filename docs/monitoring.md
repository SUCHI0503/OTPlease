# Monitoring

Three signals: structured logs, metrics, and error reports, plus two health checks.

## Health checks

| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /health` | The process is up. Cheap, touches nothing. | Docker health check |
| `GET /health/ready` | Postgres and Redis answer within 2 seconds. `503` with `{"checks":{"database":"ok","cache":"down"}}` when not. No internal detail. | The deploy script (a release counts only once this answers), an external uptime monitor |

Point an external uptime monitor (for example UptimeRobot, free) at `https://api.<domain>/health/ready` and alert on any non-200.

## Logs

The API and worker log JSON, one object per line (Fastify's logger). Phone numbers, codes, keys, tokens and emails are redacted, and
request bodies are never logged. Read them with `docker compose -f deploy/docker-compose.yml logs -f api worker`. Set `LOG_LEVEL`
(`info` by default) to change detail.

## Metrics (Prometheus)

`GET /metrics` on the API, **operator only** (send the `x-admin-token` header). Nginx returns 404 for it on the public name, so scrape it
from inside the server or over an SSH tunnel: `docker compose ... exec api node -e "fetch('http://localhost:4000/metrics',{headers:{'x-admin-token':process.env.ADMIN_TOKEN}}).then(r=>r.text()).then(console.log)"`.

| Metric | What it tells you |
|---|---|
| `http_request_duration_seconds{method,route,status}` | Latency and error rate per route. Routes are templates, so nothing personal appears. |
| `otp_requests_total{channel}` | OTP requests accepted, by channel |
| `otp_verifications_total{result}` | `verified`, `incorrect`, `expired`, `not_found`, `locked`. A rising `incorrect` or `locked` rate suggests code guessing. |
| `otp_queue_jobs{state}` | Jobs waiting, active, delayed, failed. **A growing `waiting` means the worker is down or behind**, and users are not receiving codes. |
| `process_*`, `nodejs_*` | CPU, memory, event loop lag |

Suggested alerts: `readiness` failing for 2 minutes; `otp_queue_jobs{state="waiting"}` above 100 for 5 minutes; 5xx share of
`http_request_duration_seconds_count` above 2%; a sudden jump of `otp_verifications_total{result="locked"}`.

## Error reports (Sentry)

Set `SENTRY_DSN` (a free project at sentry.io) in `deploy/.env` and redeploy. Unset means reporting is off. The API reports unexpected
server errors, and the worker reports a delivery that failed after all retries. Reports are tagged with the service, the environment
(`staging` or `production`) and the deployed version (`RELEASE`, the git commit). They contain the error type, code and stack trace only:
no request data, no user information, and exception messages are replaced (a database error can echo the value being written). See
`apps/server/src/lib/sentry.ts`, and its test for what is stripped.
