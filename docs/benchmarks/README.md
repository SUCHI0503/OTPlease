# Benchmarks

Real measurements of the OTPlease API, with the method to repeat them.

- [baseline.md](baseline.md): the Phase 18 baseline (the "before" for Phase 22).
- `results/*.json`: the raw data for each run.

## Run it

```bash
docker compose up -d                       # Postgres and Redis must be running
npm run bench -- --label my-run            # builds the backend, runs everything (about 16 minutes)
node scripts/bench/report.mjs my-run       # turns results/my-run.json into markdown
node scripts/bench/report.mjs --compare baseline my-run   # before/after tables
```

Options: `--levels 10,50,100,500,1000,2000`, `--duration 20` (seconds per level), `--scenarios health,me,otp_request,otp_verify`.

The run uses its own database (`otplease_bench`) and Redis database `/2`, so it never touches development or test data. It always uses the **mock provider**, so no message is ever sent. Rate limits are raised through `RATE_LIMITS_JSON`, so the limiters are not what gets measured.

## For a fair comparison

Run before and after on the same machine, with the same options, and close other heavy applications first (the run records the machine's load and swap at the start). Do not run tests or other work while a benchmark is running.

## Scenarios

| Name | What it does |
|---|---|
| `health` | `GET /health`: the framework alone |
| `me` | `GET /auth/me`: the session check, run for every protected request |
| `otp_request` | `POST /otp/request` with a new phone number each time; also measures how long the worker takes to deliver |
| `otp_verify` | `POST /otp/verify` with a correct code, each for a pre-seeded user, so every request creates a session |
