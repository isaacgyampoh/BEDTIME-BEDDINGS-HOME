#!/usr/bin/env bash
# Rebuild the shop's database on any PostgreSQL, from nothing.
#
#   ./restore/restore.sh "postgres://user:pass@host/db"
#
# This reproduces PRODUCTION: every migration that has actually been applied
# to the live project, which as of 10 November 2026 is everything except 043,
# 044 and 047. Those three are still pending — they move the business tables
# behind a staff session and would blank every admin screen until the
# staff-login function is deployed, so a restore must NOT include them.
#
#   --pending   additionally apply 043, 044 and 047 (not production's state)
#
# The migrations are applied one file at a time, in order, exactly as they were
# written. An earlier version of this script concatenated them into one file;
# that silently swallowed a CREATE TABLE — psql exited 0, the statement was
# echoed, and the table was not there. One file at a time cannot do that, and
# every file's result is reported.
#
# This writes nothing to disk except copies under $TMPDIR, and never prints the
# connection string.
set -uo pipefail
URL="${1:-}"
[ -n "$URL" ] || { echo "usage: $0 <DATABASE_URL> [--pending]"; exit 1; }
command -v psql >/dev/null || { echo "psql is not on PATH"; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
work="${TMPDIR:-/tmp}/bedtime-restore.$$"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work"

echo "== 1/3  what this PostgreSQL already provides"
psql "$URL" -v ON_ERROR_STOP=1 -q -f "$here/00-prelude.sql" >/dev/null || { echo "   prelude failed"; exit 1; }
echo "   roles, extensions, storage tables and any needed stand-ins are in place"

# pg_cron and pg_net exist only on a PostgreSQL that ships them. The prelude has
# already put stand-ins in place, so the CREATE EXTENSION lines are made
# conditional in COPIES — the migrations themselves are never edited.
cp "$root"/supabase/migrations/0*.sql "$work"/
perl -0pi -e 's/CREATE EXTENSION IF NOT EXISTS\s+"?(pg_cron|pg_net)"?[^;]*;/DO \$restore\$ BEGIN IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = \x27$1\x27) THEN EXECUTE \x27CREATE EXTENSION IF NOT EXISTS $1\x27; ELSE RAISE NOTICE \x27$1 unavailable here, using the stand-in\x27; END IF; END \$restore\$;/gi' "$work"/*.sql

echo "== 2/3  the schema, one migration at a time"
fail=0; ran=0
# WHY THE DEFAULT CHANGED
# This used to exclude 042 through 047 and hide 042/045/046 behind
# --with-fixes. Production has 042, 045, 046 and 048, so the default restore
# produced a database that did not match it — and specifically a pre-045 one,
# where staff.pin is still NOT NULL. In that database verify_pin's conversion
# path raises on its own UPDATE (it sets pin = NULL), so a cashier with an
# unhashed PIN cannot sign in with the correct PIN, and admin_save_staff
# cannot add anyone. A disaster-recovery script whose default output cannot
# be logged into is not a recovery script. Found by rebuilding, loading the
# real rows, and signing in.
SKIP='04[347]_'
[ "${2:-}" = "--pending" ] && SKIP='^$'
for f in $(ls "$work"/0*.sql | sort | grep -vE "$SKIP"); do
  n=$(basename "$f")
  if out=$(psql "$URL" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1); then
    ran=$((ran+1))
  else
    fail=$((fail+1))
    printf '   FAILED %-42s %s\n' "$n" "$(echo "$out" | grep -m1 ERROR | cut -c1-90)"
  fi
done
echo "   $ran applied, $fail failed"
[ "$fail" -eq 0 ] || { echo "   stopping: the schema is incomplete"; exit 1; }

echo "== 3/3  what was NOT applied, on purpose"
if [ "${2:-}" = "--pending" ]; then
  echo "   043, 044 and 047 WERE applied (--pending): this is not production's state"
else
  echo "   043, 044 and 047 skipped — production does not have them either"
fi

echo
echo "== what is there now"
psql "$URL" -At <<'SQL'
SELECT '   tables        : ' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r';
SELECT '   functions     : ' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';
SELECT '   RLS policies  : ' || count(*) FROM pg_policies WHERE schemaname='public';
SELECT '   scheduled jobs: ' || count(*) FROM cron.job;
SELECT '   products      : ' || count(*) FROM products;
SQL
echo
echo "The schema is complete and holds NO rows. The migrations never contained"
echo "the shop's data — restoring products, sales, customers and orders needs a"
echo "dump from the old project. See restore/MIGRATION.md."
