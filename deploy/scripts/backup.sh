#!/usr/bin/env bash
# Takes a compressed Postgres backup, checks that it can be read, and (if BACKUP_BUCKET is set) copies it to S3.
# Run daily from cron. Keeps KEEP_DAYS days of local copies (default 14).
#   BACKUP_BUCKET=my-bucket ./deploy/scripts/backup.sh
set -euo pipefail
. "$(dirname "$0")/lib.sh"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/otplease-$stamp.dump"

# Row counts before and after the dump: the restore test uses them to prove the restore is complete
table_counts "$PG_CONTAINER" "$PG_DB" > "$file.counts-before"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$file.partial"
table_counts "$PG_CONTAINER" "$PG_DB" > "$file.counts-after"

# A backup nobody has read is not a backup: make sure pg_restore can list what is inside
entries="$(docker exec -i "$PG_CONTAINER" pg_restore -l < "$file.partial" | grep -c '^[0-9]' || true)"
if [ "$entries" -lt 10 ]; then
  echo "backup looks empty or broken ($entries entries), keeping it as $file.partial" >&2
  exit 1
fi
mv "$file.partial" "$file"
chmod 600 "$file" "$file.counts-before" "$file.counts-after"
echo "backup written: $file ($(du -h "$file" | cut -f1), $entries entries)"

if [ -n "${BACKUP_BUCKET:-}" ]; then
  for f in "$file" "$file.counts-before" "$file.counts-after"; do
    aws s3 cp --only-show-errors "$f" "s3://$BACKUP_BUCKET/postgres/$(basename "$f")"
  done
  echo "uploaded to s3://$BACKUP_BUCKET/postgres/"
fi

find "$BACKUP_DIR" -name 'otplease-*' -mtime "+$KEEP_DAYS" -delete
