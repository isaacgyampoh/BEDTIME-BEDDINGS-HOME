#!/usr/bin/env bash
# ===========================================================================
# Give an application a way to call its own edge functions from a scheduled
# job, and register nothing anywhere it cannot work.
#
#   ensure-app-edge-caller.sh <app-name>
#
# THE TRAP THIS CLOSES
#
# pg_net's background worker runs against ONE database. On this server:
#
#   pg_net.database_name = postgres
#
# So net.http_post() called from an application's own database queues a row
# in net.http_request_queue that is never sent: nothing appears in
# net._http_response, no error is raised, and cron.job_run_details still
# reports "succeeded" because the dispatch itself did not fail. A migrated
# Supabase job therefore goes silent in a way nothing surfaces.
#
# That is why Everytinroom's HTTP jobs live in the postgres database and only
# its pure-SQL jobs sit in its own. Any new application must do the same.
#
# WHAT THIS CREATES, in the postgres database
#
#   <app>_private.app_config   two rows: functions_url and service_key
#   <app>_private.call_edge()  posts to functions_url || path with the key
#
# The schema is named per application, NOT `private`, because the postgres
# database is shared by every tenant and a generic name is a collision
# waiting to happen. Supabase's own helper was `private.call_edge`; migrated
# job bodies must be rewritten to the prefixed name.
#
# functions_url is the INTERNAL address, http://<app>-functions:9000.
# central-postgres is attached to the application's db network, so it reaches
# the container directly: the jobs work before any DNS record exists, and
# cutover does not change them. The public domain would make every job wait
# on DNS and TLS for no benefit.
#
# It is net.http_post, not extensions.http_post, on this platform.
#
# Keeping the key in one row rather than inline in each job means rotating it
# is one UPDATE instead of rewriting every job body -- and no service-role
# JWT ends up in cron.job, where anyone who can read the table can see it.
#
# SAFE TO RE-RUN.
# ===========================================================================
set -uo pipefail

APP="${1:-}"
[ -n "$APP" ] || { echo "usage: $(basename "$0") <app-name>" >&2; exit 2; }
case "$APP" in *[!a-z0-9_]*) echo "app name must be lowercase letters, digits and underscores: $APP" >&2; exit 2 ;; esac

ENVF="/srv/central/apps/$APP/.env"
SCHEMA="${APP}_private"
DNS="$(printf '%s' "$APP" | tr '_' '-')"
FURL="http://${DNS}-functions:9000"

ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }

[ -f "$ENVF" ] || { no "no $ENVF -- provision the application first"; exit 2; }
SRK="$(grep -E '^SERVICE_ROLE_KEY=' "$ENVF" | cut -d= -f2-)"
[ -n "$SRK" ] || { no "SERVICE_ROLE_KEY is not set in $ENVF"; exit 2; }

# The worker's database, read from the server rather than assumed.
PGDB="$(docker exec central-postgres psql -U postgres -tAqX \
  -c "select setting from pg_settings where name = 'pg_net.database_name';" 2>/dev/null | tr -d '[:space:]')"
PGDB="${PGDB:-postgres}"
note "pg_net worker database: $PGDB"

# The key is passed as a psql variable on stdin, never in argv.
docker exec -i central-postgres psql -U postgres -d "$PGDB" -v ON_ERROR_STOP=1 \
  -v srk="$SRK" -v schema="$SCHEMA" -v furl="$FURL" <<'SQL'
\set qschema :schema
SELECT format('CREATE SCHEMA IF NOT EXISTS %I', :'schema') \gexec
SELECT format('CREATE TABLE IF NOT EXISTS %I.app_config (key text PRIMARY KEY, value text)', :'schema') \gexec
SELECT format($f$INSERT INTO %I.app_config(key,value) VALUES ('functions_url', %L)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value$f$, :'schema', :'furl') \gexec
SELECT format($f$INSERT INTO %I.app_config(key,value) VALUES ('service_key', %L)
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value$f$, :'schema', :'srk') \gexec
SELECT format($f$
CREATE OR REPLACE FUNCTION %I.call_edge(p_path text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO %L, 'net', 'pg_temp'
AS $fn$
DECLARE v_url TEXT; v_key TEXT; v_headers JSONB;
BEGIN
  SELECT value INTO v_url FROM %I.app_config WHERE key = 'functions_url';
  IF v_url IS NULL THEN
    RAISE WARNING 'call_edge(%%): functions_url is not set - skipping', p_path;
    RETURN;
  END IF;
  SELECT value INTO v_key FROM %I.app_config WHERE key = 'service_key';
  v_headers := jsonb_build_object('Content-Type','application/json');
  IF v_key IS NOT NULL THEN
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_key);
  END IF;
  PERFORM net.http_post(url := v_url || p_path, headers := v_headers, body := '{}'::jsonb);
END;
$fn$$f$, :'schema', :'schema', :'schema', :'schema') \gexec
SQL
rc=$?
[ "$rc" -eq 0 ] || { no "could not create $SCHEMA.call_edge"; exit 3; }
ok "$SCHEMA.call_edge() ready in the $PGDB database"
note "functions_url = $FURL"
note "Register jobs there, prefixed, e.g.:"
note "  SELECT cron.schedule('${DNS:0:3}-sms-morning','0 8 * * 1-6',"
note "    \$\$SELECT ${SCHEMA}.call_edge('/sms-reports?type=morning')\$\$);"
note "Check net._http_response, not cron.job_run_details, to see what happened."
