#!/usr/bin/env bash
# ===========================================================================
# Restore a production dump into an ISOLATED staging database and reconcile.
#
#   restore-and-reconcile.sh ~/.bedtime/backups/bedtime-2026….dump
#   restore-and-reconcile.sh <dump> bedtime_staging2      # a different target
#
# This never touches production and never touches an existing database: it
# refuses if the target already exists unless --recreate is passed, so a
# second run cannot quietly destroy the first restore.
# ===========================================================================
set -uo pipefail
DUMP="${1:-}"
TARGET="${2:-bedtime_staging}"
RECREATE=0
for a in "$@"; do [ "$a" = "--recreate" ] && RECREATE=1; done

[ -n "$DUMP" ] || { echo "usage: $0 <dump-file> [target-db] [--recreate]"; exit 2; }
[ -f "$DUMP" ] || { echo "no such dump: $DUMP"; exit 2; }
command -v pg_restore >/dev/null || { echo "pg_restore is not on PATH"; exit 2; }

say () { printf '\n\033[1m%s\033[0m\n' "$*"; }

# A production hostname here would mean restoring ONTO production.
case "$TARGET" in
  *supabase*|*://*|*pooler*) echo "REFUSING: '$TARGET' looks like a remote target. This restores to a LOCAL database only."; exit 2 ;;
esac

if psql -lqt | cut -d'|' -f1 | grep -qw "$TARGET"; then
  if [ "$RECREATE" -eq 1 ]; then
    say "Dropping and recreating $TARGET (--recreate)"
    dropdb "$TARGET"; createdb "$TARGET"
  else
    echo "REFUSING: database '$TARGET' already exists. Pass --recreate to replace it," >&2
    echo "or give a different target name. Not overwriting it silently." >&2
    exit 2
  fi
else
  say "Creating $TARGET"; createdb "$TARGET"
fi

say "Restoring"
# --no-owner --no-acl: the dump's roles do not exist here.
# Errors are expected for Supabase-managed objects and are counted, not hidden.
pg_restore --no-owner --no-acl --dbname "$TARGET" "$DUMP" 2> >(tee /tmp/bedtime-restore-errs.txt >&2) || true
errs=$(grep -c '^pg_restore: error' /tmp/bedtime-restore-errs.txt 2>/dev/null || echo 0)
echo "  pg_restore reported $errs error line(s); see /tmp/bedtime-restore-errs.txt"

say "What arrived"
psql -At -d "$TARGET" <<'SQL'
SELECT '  tables       : ' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';
SELECT '  functions    : ' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
SELECT '  RLS policies : ' || count(*) FROM pg_policies WHERE schemaname='public';
SQL
echo "  the five tables the public key cannot read:"
for t in staff pin_attempts sms_log sms_exempt_numbers social_connections; do
  c=$(psql -At -d "$TARGET" -c "SELECT count(*) FROM $t" 2>/dev/null || echo "ABSENT")
  printf '    %-22s %s\n' "$t" "$c"
done

say "Staff credentials: shape only, never values"
psql -At -d "$TARGET" <<'SQL' 2>/dev/null || echo "  (staff table absent)"
SELECT '  rows                      : ' || count(*) FROM staff;
SELECT '  with a bcrypt pin_hash    : ' || count(*) FROM staff WHERE pin_hash LIKE '$2%';
SELECT '  still holding plaintext   : ' || count(*) FROM staff WHERE pin IS NOT NULL AND pin <> '';
SELECT '  active                    : ' || count(*) FROM staff WHERE active;
SQL

say "Reconciling against production (read-only, public key)"
here="$(cd "$(dirname "$0")" && pwd)"
node "$here/reconcile.mjs" --db "$TARGET" --against api
rc=$?

say "Next"
cat <<MSG
  Point the apps at the restored database and run the acceptance suite:
    VITE_SUPABASE_URL=<staging-api> npm run test:pos

  Reconciliation exit code: $rc  (0 = everything comparable matched)
MSG
exit $rc
