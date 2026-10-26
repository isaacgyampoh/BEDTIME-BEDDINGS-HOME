#!/usr/bin/env bash
# A nightly dump, kept off the server, and proved restorable.
#
# A backup nobody has restored is a hope, not a backup. This one restores every
# dump it takes into a scratch database and counts the rows before calling it
# good, then deletes the scratch copy.
#
#   ./backup.sh            take, verify and upload one backup
#   ./backup.sh --list     what is stored off-server
#
# Needs rclone configured with a remote called `offsite` (Cloudflare R2's free
# tier is 10 GB, which is far more than this shop's database will need):
#   rclone config        # n) new remote, s3, provider Cloudflare R2
set -euo pipefail
cd "$(dirname "$0")"

STACK_DIR="${STACK_DIR:-/opt/supabase}"
REMOTE="${REMOTE:-offsite:bedtime-backups}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"
LOCAL_DIR="${LOCAL_DIR:-/var/backups/bedtime}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$LOCAL_DIR/bedtime-$STAMP.sql.gz"

if [ "${1:-}" = "--list" ]; then rclone ls "$REMOTE" | tail -20; exit 0; fi

mkdir -p "$LOCAL_DIR"; chmod 700 "$LOCAL_DIR"
say () { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

say "dumping"
docker compose -f "$STACK_DIR/docker-compose.yml" exec -T db \
  pg_dump -U postgres --schema=public --no-owner --no-privileges postgres | gzip -9 > "$FILE"
chmod 600 "$FILE"
say "dumped $(du -h "$FILE" | cut -f1)"

say "verifying by restoring it, which is the only way to know"
SCRATCH="verify_$STAMP"
docker compose -f "$STACK_DIR/docker-compose.yml" exec -T db psql -U postgres -q -c "CREATE DATABASE \"$SCRATCH\""
if gunzip -c "$FILE" | docker compose -f "$STACK_DIR/docker-compose.yml" exec -T db \
     psql -U postgres -q -v ON_ERROR_STOP=1 -d "$SCRATCH" >/dev/null 2>&1; then
  rows=$(docker compose -f "$STACK_DIR/docker-compose.yml" exec -T db \
         psql -U postgres -At -d "$SCRATCH" -c "SELECT count(*) FROM products" 2>/dev/null || echo 0)
  docker compose -f "$STACK_DIR/docker-compose.yml" exec -T db psql -U postgres -q -c "DROP DATABASE \"$SCRATCH\""
  if [ "${rows:-0}" -lt 1 ]; then say "RESTORED BUT EMPTY — treating as failed"; rm -f "$FILE"; exit 1; fi
  say "verified: $rows products came back"
else
  docker compose -f "$STACK_DIR/docker-compose.yml" exec -T db psql -U postgres -q -c "DROP DATABASE IF EXISTS \"$SCRATCH\"" || true
  say "THE BACKUP WOULD NOT RESTORE — keeping it for inspection"; exit 1
fi

say "sending it off the server"
# On the server only is not a backup: the server is the thing that fails.
rclone copy "$FILE" "$REMOTE" --no-traverse
say "uploaded"

find "$LOCAL_DIR" -name 'bedtime-*.sql.gz' -mtime +"$KEEP_LOCAL_DAYS" -delete
say "done — $(rclone ls "$REMOTE" | wc -l) backups held off-server"
