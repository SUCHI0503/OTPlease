#!/usr/bin/env bash
# Updates the running stack to the latest main and waits until the API answers. Used by hand and by the deploy workflow.
set -euo pipefail
cd "$(dirname "$0")/../.."
DC="sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env"

git fetch --quiet origin main
git merge --ff-only origin/main
$DC up -d --build --remove-orphans

# Health gate: the release counts only once the API answers through Nginx
DOMAIN="$(grep '^DOMAIN=' deploy/.env | cut -d= -f2- | awk '{print $1}')"
for _ in $(seq 1 30); do
  if curl -fsS "https://api.$DOMAIN/health" >/dev/null 2>&1; then echo "deployed: $(git rev-parse --short HEAD) is answering at https://api.$DOMAIN"; sudo docker image prune -f >/dev/null; exit 0; fi
  sleep 5
done
echo "deploy FAILED: https://api.$DOMAIN/health did not answer. Recent logs:" >&2
$DC logs --tail 40 api nginx >&2
exit 1
