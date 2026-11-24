#!/usr/bin/env bash
# ===========================================================================
# Reload an application's database from hosted Supabase, completely, and put
# back everything the reload destroys.
#
#   SUPABASE_DB_URL='postgresql://…' app-full-resync.sh bedtime [--go]
#
# Dry run unless --go is given.
#
# WHY THIS EXISTS RATHER THAN JUST RUNNING migrate-from-supabase.sh
#
# That script is safe to re-run, but re-running it into a POPULATED database
# does not sync anything: every CREATE collides ("trigger already exists",
# "relation already exists") and new rows are silently skipped. It reports
# MISMATCH rather than lying, which is the only reason it gets noticed. A true
# reload therefore has to drop and recreate the public schema first.
#
# AND THAT DROP TAKES THREE THINGS WITH IT, each of which breaks the shop:
#
#   1. pgcrypto and uuid-ossp. pg_net is installed into PUBLIC on Supabase, so
#      a cascade through public removes them, and the dump carries no
#      CREATE EXTENSION. verify_pin() compares with crypt(), so EVERY STAFF
#      LOGIN FAILS until they are reinstalled. Nothing in the data hints at it.
#   2. The RLS tightening in migrations 043/044/047. Without them the public
#      anon key -- which ships in every browser bundle -- can read sales,
#      customers and expenses.
#   3. The retired WhatsApp agent tables come BACK, because they still exist
#      on Supabase until pending/053 is applied there.
#
# Each of those was found the hard way during Bedtime's migration. This script
# exists so the next reload cannot repeat any of them.
#
# It only reads Supabase. Nothing there is dropped, altered or disabled.
# ===========================================================================
set -uo pipefail

APP="${1:-}"
GO=0
[ "${2:-}" = "--go" ] && GO=1
[ -n "$APP" ] || { echo "usage: SUPABASE_DB_URL=… $(basename "$0") <app> [--go]" >&2; exit 2; }
[ -n "${SUPABASE_DB_URL:-}" ] || { echo "SUPABASE_DB_URL is not set" >&2; exit 2; }

ROOT=/srv/central
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/srv/central/apps/$APP/sql}"

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
step () { printf '\n\033[1m[%s] %s\033[0m\n' "$1" "$2"; }

psqlq () { docker exec -i central-postgres psql -U postgres -d "$APP" -tAqX "$@"; }

say "Full resync of '$APP' from hosted Supabase"
note "$([ "$GO" -eq 1 ] && printf 'LIVE RUN' || printf 'DRY RUN -- nothing will be changed')"

# What we must be able to put back afterwards.
for f in 043_staff_only_reads 044_public_order_functions 047_order_total_computed_server_side; do
  if [ -f "$MIGRATIONS_DIR/$f.sql" ]; then ok "found $f.sql"
  else no "MISSING $MIGRATIONS_DIR/$f.sql"; note "Refusing: the reload would drop the RLS tightening with no way to restore it."; exit 3; fi
done

BEFORE="$(psqlq -c "select 'orders='||(select count(*) from whatsapp_orders)||' seq='||(select last_value from ussd_code_seq)" < /dev/null 2>/dev/null || echo '(unreadable)')"
note "before: $BEFORE"

if [ "$GO" -ne 1 ]; then
  say "What a live run would do"
  note "1. DROP SCHEMA public CASCADE; CREATE SCHEMA public  (on $APP only)"
  note "2. migrate-from-supabase.sh --app $APP   (reads Supabase only)"
  note "3. reinstall pgcrypto, uuid-ossp, pg_stat_statements into extensions"
  note "4. re-apply 043, 044, 047"
  note "5. drop the three retired agent tables, under guards"
  note "6. reconcile, and refuse to finish if ussd_code_seq went backwards"
  exit 0
fi

step 1/6 "Dropping and recreating public"
psqlq -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;" >/dev/null \
  && ok "public recreated" || { no "could not recreate public"; exit 4; }

step 2/6 "Restoring from a fresh Supabase dump"
ASSUME_YES=1 "$ROOT/scripts/migrate-from-supabase.sh" --app "$APP" 2>&1 \
  | grep -E "^    [a-z_]+ +[0-9]+ +[0-9]+|every row count|MISMATCH|ussd_code_seq ->|FAILED" | sed 's/^/  /'

step 3/6 "Reinstalling the extensions the cascade removed"
psqlq -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto           WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp"        WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
SQL
# Read the result with its own stdin closed. psqlq is `docker exec -i`, and
# leaving it sharing the script's stdin made this check return nothing and
# wrongly report crypt() as unavailable when it was working.
CRYPT="$(psqlq -c "select (extensions.crypt('x', extensions.gen_salt('bf')) is not null)::text" < /dev/null 2>&1 | tr -d '[:space:]')"
case "$CRYPT" in
  t|true) ok "crypt() resolves, so verify_pin can work" ;;
  *)      no "crypt() still unavailable -- staff login WOULD fail"
          note "psql said: ${CRYPT:-(nothing)}"
          exit 5 ;;
esac

step 4/6 "Re-applying the RLS tightening"
for f in 043_staff_only_reads 044_public_order_functions 047_order_total_computed_server_side; do
  docker exec -i central-postgres psql -U postgres -d "$APP" -q -v ON_ERROR_STOP=0 < "$MIGRATIONS_DIR/$f.sql" >/dev/null 2>&1
  ok "applied $f"
done

step 5/6 "Dropping the retired agent tables again"
psqlq -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$
DECLARE c bigint;
BEGIN
  IF to_regclass('public.wa_conversations') IS NOT NULL THEN
    SELECT count(*) INTO c FROM wa_conversations;
    IF c > 0 THEN RAISE EXCEPTION 'wa_conversations has % rows -- refusing', c; END IF;
  END IF;
  IF to_regclass('public.wa_messages') IS NOT NULL THEN
    SELECT count(*) INTO c FROM wa_messages;
    IF c > 0 THEN RAISE EXCEPTION 'wa_messages has % rows -- refusing', c; END IF;
  END IF;
  IF to_regclass('public.wa_agent_settings') IS NOT NULL THEN
    SELECT count(*) INTO c FROM wa_agent_settings
      WHERE key NOT IN ('agent_master_enabled','business_hours_only');
    IF c > 0 THEN RAISE EXCEPTION 'wa_agent_settings has % unexpected key(s) -- refusing', c; END IF;
  END IF;
END $$;
DROP TABLE IF EXISTS wa_messages, wa_conversations, wa_agent_settings;
SQL
ok "agent tables gone"

step 6/6 "Reconciling"
AFTER="$(psqlq -c "select 'orders='||(select count(*) from whatsapp_orders)||' seq='||(select last_value from ussd_code_seq)" < /dev/null)"
note "after : $AFTER"
SEQ_A="$(printf '%s' "$AFTER"  | sed -E 's/.*seq=//')"
SEQ_B="$(printf '%s' "$BEFORE" | sed -E 's/.*seq=//')"
case "$SEQ_B" in ''|*[!0-9]*) SEQ_B=0 ;; esac
if [ "${SEQ_A:-0}" -lt "$SEQ_B" ]; then
  no "ussd_code_seq went BACKWARDS: $SEQ_B -> $SEQ_A"
  note "That reissues USSD codes already given to customers. Investigate before serving traffic."
  exit 6
fi
ok "ussd_code_seq did not go backwards ($SEQ_B -> $SEQ_A)"
psqlq -c "select '  anon can read sales: '||(select count(*) > 0 from pg_policies where tablename='sales' and 'anon' = any(roles))::text"
say "Done"
note "Now verify a staff PIN sign-in before putting traffic on this database."
