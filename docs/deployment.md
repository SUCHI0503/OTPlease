# Deploying OTPlease (staging on AWS)

One small Ubuntu server runs the whole stack in Docker behind Nginx with HTTPS. A private S3 bucket holds the
database backups. Everything below is scripted: `deploy/terraform` creates the AWS side, `deploy/scripts` sets up
and updates the server.

```
Internet -> Nginx (80/443, TLS) -> api / dashboard / demo -> Postgres + Redis (not reachable from outside)
                                                             worker  -> email (real SMTP), phone channels (mock on staging)
```

Names: `api.<domain>` (the API and `/docs`), `app.<domain>` (dashboard), `demo.<domain>` (demo shop).

## What staging is, and is not

Staging runs in production mode with `DEPLOY_ENV=staging` and `ALLOW_MOCK_PROVIDERS=true`. Email is real. WhatsApp, SMS
and voice use the mock provider: requests succeed and show as `sent`, but **nothing is delivered**. The server logs a
warning on every start. Production refuses this switch, so a live service can never run on mock delivery.

## Before you start

| You need | Notes |
|---|---|
| AWS account and an IAM user with access keys | `aws configure` on your laptop; set a budget alarm first |
| A domain you control | Route 53 makes DNS automatic; any registrar works if you add three A records yourself |
| `awscli` and `terraform` on your laptop | `brew install awscli terraform` |
| An SSH key | `ssh-keygen -t ed25519` if you have none |
| A Gmail app password (or another SMTP login) | for real email |

Rough cost: a `t3.small` server (about $15 a month), 30 GB disk, an Elastic IP, and pennies of S3. Check current AWS prices.

## 1. Create the AWS resources

```bash
cd deploy/terraform
cp staging.tfvars.example staging.tfvars      # fill in region, domain, your IP (/32), your public key
terraform init
terraform plan -var-file=staging.tfvars       # read it: nothing is created yet
terraform apply -var-file=staging.tfvars
```

It prints the server IP and the backup bucket name. Without `hosted_zone_id`, create three A records
(`api`, `app`, `demo` under your staging name) pointing at that IP. Wait until they resolve.

## 2. Set up the server

```bash
ssh ubuntu@<server ip>
curl -fsSLO https://raw.githubusercontent.com/SUCHI0503/OTPlease/main/deploy/scripts/bootstrap.sh
DOMAIN=staging.example.com CERT_EMAIL=you@example.com BACKUP_BUCKET=<bucket> bash bootstrap.sh
```

It installs Docker, gets one TLS certificate for the three names, writes `deploy/.env` with fresh random secrets,
and schedules the daily backup and certificate renewal. It then asks you to edit `~/otplease/deploy/.env`
(`SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`) and to run `./deploy/scripts/deploy.sh`. If the repository is private, add a
read-only deploy key on the server first.

Check: open `https://api.<domain>/health`, `https://api.<domain>/docs`, and sign in to `https://app.<domain>` with the
`ADMIN_TOKEN` from `deploy/.env`.

## 3. Automatic deploys

`.github/workflows/deploy-staging.yml` runs after CI passes on `main`. In GitHub, create an environment called
`staging` with the secrets `STAGING_HOST` (server IP or name), `STAGING_USER` (`ubuntu`) and `STAGING_SSH_KEY`
(a private key whose public half is in the server's `authorized_keys`). A deploy pulls `main`, rebuilds, and reports
success only when `https://api.<domain>/health` answers. You can also run it by hand from the Actions tab.

Roll back by deploying an older commit: on the server, `git reset --hard <good commit>` and run `deploy.sh`
(migrations only ever move forward, so keep schema changes backward compatible).

## Backups and restore

`deploy/scripts/backup.sh` runs daily at 02:30 (cron). It dumps Postgres, checks the dump can be read, keeps 14 days on
the server and copies to S3 (35-day expiry, private, encrypted, versioned).

**A backup counts only once a restore has been shown to work.** Run this after setup and every month:

```bash
./deploy/scripts/restore-test.sh        # restores the newest backup into a throwaway Postgres and checks every table
```

It compares the restored row counts with the counts recorded at backup time and exits non-zero on any difference.
To recover for real: `./deploy/scripts/restore.sh <dump> <new database name>`, check it, then switch the app to it
(it refuses to overwrite the live database unless you stop the app and set `ALLOW_LIVE_OVERWRITE=yes`). To restore
from S3, `aws s3 cp` the `.dump` file to the server first. Redis holds only short-lived queue and rate-limit data, so
it is not backed up.

## Before real users

- Replace mock delivery: paid Twilio (or Meta WhatsApp) plus an approved WhatsApp template, then set
  `ALLOW_MOCK_PROVIDERS=false` and `DEPLOY_ENV=production`, and fill in the Twilio settings.
- Send email from your own domain (SPF and DKIM), for example through Amazon SES, not a personal Gmail.
- Add a production environment with its own server, database and secrets; do not reuse staging's.
- Monitoring and alerts (Phase 22).
