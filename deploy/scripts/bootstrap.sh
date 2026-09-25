#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu server (run as the normal user with sudo):
#   DOMAIN=staging.example.com CERT_EMAIL=you@example.com BACKUP_BUCKET=bucket-name REPO=https://github.com/SUCHI0503/OTPlease.git \
#     bash bootstrap.sh
# It installs Docker, gets a TLS certificate, writes deploy/.env with fresh random secrets, starts everything
# and schedules the daily backup and the certificate renewal. Safe to run again: it keeps existing secrets.
set -euo pipefail
: "${DOMAIN:?set DOMAIN, e.g. staging.example.com}"
: "${CERT_EMAIL:?set CERT_EMAIL for certificate expiry notices}"
REPO="${REPO:-https://github.com/SUCHI0503/OTPlease.git}"
APP_DIR="${APP_DIR:-$HOME/otplease}"

sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose-v2 git certbot cron
command -v aws >/dev/null || sudo snap install aws-cli --classic
sudo systemctl enable --now docker cron
sudo usermod -aG docker "$USER" || true

[ -d "$APP_DIR/.git" ] || git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"

if [ ! -f deploy/.env ]; then
  cp deploy/.env.example deploy/.env
  chmod 600 deploy/.env
  for key in POSTGRES_PASSWORD OTP_HASH_SECRET JWT_SECRET ADMIN_TOKEN; do
    sed -i "s|^$key=.*|$key=$(openssl rand -hex 32)|" deploy/.env
  done
  sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|; s|^BACKUP_BUCKET=.*|BACKUP_BUCKET=${BACKUP_BUCKET:-}|" deploy/.env
  echo ">> deploy/.env created with new random secrets. Fill in SMTP_USER, SMTP_PASS and MAIL_FROM, then run deploy.sh."
fi

# Certificate for all three names (needs DNS for api./app./demo. to point here already, and port 80 free)
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  sudo mkdir -p /var/www/certbot
  sudo certbot certonly --standalone --non-interactive --agree-tos -m "$CERT_EMAIL" --cert-name "$DOMAIN" \
    -d "api.$DOMAIN" -d "app.$DOMAIN" -d "demo.$DOMAIN"
fi
# Renewal goes through Nginx's challenge folder, then Nginx reloads to pick the new certificate up
sudo tee /etc/cron.d/otplease-certbot >/dev/null <<CRON
17 3 * * * root certbot renew --quiet --webroot -w /var/www/certbot --deploy-hook "docker exec otplease-staging-nginx-1 nginx -s reload"
CRON
sudo tee /etc/cron.d/otplease-backup >/dev/null <<CRON
30 2 * * * root cd $APP_DIR && BACKUP_BUCKET=${BACKUP_BUCKET:-} ./deploy/scripts/backup.sh >> /var/log/otplease-backup.log 2>&1
CRON

if grep -q '^SMTP_USER=$' deploy/.env; then
  echo ">> Edit deploy/.env (SMTP_USER, SMTP_PASS, MAIL_FROM) and then run: ./deploy/scripts/deploy.sh"
  exit 0
fi
./deploy/scripts/deploy.sh
