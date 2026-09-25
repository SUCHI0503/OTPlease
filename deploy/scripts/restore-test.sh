#!/usr/bin/env bash
# Proves a backup can really be restored: loads it into a throwaway Postgres container (never the live one)
# and checks that every table came back with the row count the backup recorded. Run monthly, and after any
# change to the backup setup:   ./deploy/scripts/restore-test.sh [dump file]   (default: the newest backup)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
dump="${1:-$(ls -1t "$BACKUP_DIR"/otplease-*.dump 2>/dev/null | head -1)}"
[ -n "$dump" ] && [ -f "$dump" ] || { echo "no backup found in $BACKUP_DIR" >&2; exit 1; }

scratch="otplease-restore-test-$$"
trap 'docker rm -f "$scratch" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$scratch" -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD=scratch -e POSTGRES_DB=restored postgres:16 >/dev/null
for _ in $(seq 1 30); do docker exec "$scratch" pg_isready -U "$PG_USER" -d restored >/dev/null 2>&1 && break; sleep 1; done

echo "restoring $(basename "$dump") into a throwaway database..."
docker exec -i "$scratch" pg_restore -U "$PG_USER" -d restored --no-owner --exit-on-error < "$dump"

table_counts "$scratch" restored > "$dump.counts-restored"
before="$dump.counts-before"; after="$dump.counts-after"
fail=0
while read -r table count; do
  b="$(awk -v t="$table" '$1==t{print $2}' "$before")"; a="$(awk -v t="$table" '$1==t{print $2}' "$after")"
  if [ -z "$b" ] || [ -z "$a" ]; then echo "  MISSING in backup record: $table"; fail=1; continue; fi
  lo=$(( b < a ? b : a )); hi=$(( b > a ? b : a ))
  # Writes that happen while the dump runs can move a count between the two readings
  if [ "$count" -lt "$lo" ] || [ "$count" -gt "$hi" ]; then echo "  MISMATCH $table: restored $count, expected $lo..$hi"; fail=1; else echo "  ok  $table: $count"; fi
done < "$dump.counts-restored"
# Every table that existed at backup time must exist again
while read -r table _; do
  grep -q "^$table " "$dump.counts-restored" || { echo "  MISSING table after restore: $table"; fail=1; }
done < "$before"

migrations="$(docker exec "$scratch" psql -U "$PG_USER" -d restored -At -c 'SELECT count(*) FROM _prisma_migrations')"
echo "  migrations recorded: $migrations"
if [ "$fail" -eq 0 ]; then echo "RESTORE TEST PASSED ($(wc -l < "$dump.counts-restored" | tr -d ' ') tables checked)"; else echo "RESTORE TEST FAILED" >&2; exit 1; fi
