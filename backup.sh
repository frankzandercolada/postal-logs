#!/usr/bin/env bash
# Online snapshot of the SQLite DB. Run from a cron entry on the host.
# Keeps 14 daily backups locally under ./backups/.
#
# Cron example (root crontab):
#   15 3 * * *  cd /root/postal-logs && ./backup.sh >> backups/cron.log 2>&1
#
# If you want offsite copies, pipe / sync `./backups/` to a bucket after this
# script runs (e.g. `gsutil rsync -d ./backups gs://your-bucket/postal-logs/`).
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p backups
TS=$(date -u +%Y%m%dT%H%M%SZ)
SNAPSHOT="data/snapshot-${TS}.db"
OUT="backups/postal-logs-${TS}.db.gz"

# Use sqlite3 .backup so we get a consistent snapshot even while the app is
# writing. The container has sqlite installed via the Dockerfile.
docker compose exec -T app sqlite3 /app/data/postal-logs.db \
  ".backup '/app/data/snapshot-${TS}.db'"

# The snapshot landed in ./data on the host (bind mount). Compress it into
# ./backups/ and remove the uncompressed copy.
gzip -c "$SNAPSHOT" > "$OUT"
rm -f "$SNAPSHOT"

# Retention: keep 14 days of dailies.
find backups -maxdepth 1 -name 'postal-logs-*.db.gz' -mtime +14 -delete

echo "$(date -u +%FT%TZ) backup written: $OUT ($(du -h "$OUT" | cut -f1))"
