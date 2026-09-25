# shellcheck shell=bash
# Shared by backup.sh, restore.sh and restore-test.sh
PG_CONTAINER="${POSTGRES_CONTAINER:-otplease-staging-postgres-1}"
PG_USER="${POSTGRES_USER:-otplease}"
PG_DB="${POSTGRES_DB:-otplease}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/otplease}"

# Row count of every table in a database: "table count" lines. Run as: table_counts <container> <db>
table_counts() {
  docker exec "$1" psql -U "$PG_USER" -d "$2" -At -F ' ' -c "
    SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text
    FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"
}
