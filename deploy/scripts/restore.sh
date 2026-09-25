#!/usr/bin/env bash
# Restores a backup into a NEW database, so nothing live is overwritten by accident.
#   ./deploy/scripts/restore.sh /var/backups/otplease/otplease-XXXX.dump otplease_restored
# To replace the live database (after an outage), restore into a new name, check it, then point the app at it,
# or stop the stack and set ALLOW_LIVE_OVERWRITE=yes to restore over the live name.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
dump="${1:?usage: restore.sh <dump file> <target database name>}"
target="${2:?usage: restore.sh <dump file> <target database name>}"

if [ "$target" = "$PG_DB" ] && [ "${ALLOW_LIVE_OVERWRITE:-no}" != "yes" ]; then
  echo "refusing to restore over the live database '$PG_DB'. Use a new name, or set ALLOW_LIVE_OVERWRITE=yes with the app stopped." >&2
  exit 1
fi

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$target\"" -c "CREATE DATABASE \"$target\""
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$target" --no-owner --exit-on-error < "$dump"
echo "restored $dump into database '$target'"
