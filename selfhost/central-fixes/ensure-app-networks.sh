#!/usr/bin/env bash
# ===========================================================================
# Make sure an application's two Docker networks exist and that the shared
# Postgres and Caddy are attached to them, with the aliases the app images
# actually resolve.
#
#   ensure-app-networks.sh <app-name>
#
# WHY THIS FILE EXISTS
#
# compose/app.compose.yml declares each application's networks as
#   app_db:   { external: true, name: app_${APP_DNS}_db }
#   app_edge: { external: true, name: app_${APP_DNS}_edge }
# and its comment says provision-app.sh creates them. It did not: no file
# under /srv/central contained `docker network create`. Everytinroom's
# networks predate the move off the shared central_db/central_edge, so the
# gap was invisible until the next application was provisioned -- Bedtime, on
# 2026-11-24, which failed with
#
#   network app_bedtime_db declared as external, but could not be found
#
# THE ALIASES ARE NOT OPTIONAL
#
# gotrue and realtime both resolve the database as the bare name `postgres`.
# `docker network connect` with no --alias gives the container only its own
# name, so both crash-loop:
#
#   gotrue   : failed to connect to host=postgres ... hostname resolving error
#   realtime : Failed to detect IP version for DB_HOST: nxdomain
#
# On app_everytinroom_db central-postgres carries ['postgres','db'], so those
# are what any new application needs too. Caddy needs none: it is reached by
# the app's containers, not the other way round, and Everytinroom's edge
# attachment has no aliases either.
#
# SAFE TO RE-RUN. Every step checks first. `docker network connect` on a
# running container is additive and does not restart it, so this never
# interrupts another tenant.
# ===========================================================================
set -uo pipefail

APP="${1:-}"
[ -n "$APP" ] || { echo "usage: $(basename "$0") <app-name>" >&2; exit 2; }
case "$APP" in *[!a-z0-9_-]*) echo "bad app name: $APP" >&2; exit 2 ;; esac

# app.compose.yml builds the network names from APP_DNS, which is the
# application name with underscores turned into hyphens.
DNS="$(printf '%s' "$APP" | tr '_' '-')"
DB_NET="app_${DNS}_db"
EDGE_NET="app_${DNS}_edge"
PG=central-postgres
CADDY=central-caddy

ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }

for n in "$DB_NET" "$EDGE_NET"; do
  if docker network inspect "$n" >/dev/null 2>&1; then
    ok "$n exists"
  else
    docker network create "$n" >/dev/null || { no "could not create $n"; exit 3; }
    ok "created $n"
  fi
done

# Is a container attached to a network, and with which aliases?
aliases_on () {  # aliases_on <container> <network>
  docker inspect "$1" 2>/dev/null | python3 -c "
import sys,json
try: d=json.load(sys.stdin)[0]
except Exception: sys.exit(0)
n=d.get('NetworkSettings',{}).get('Networks',{}).get('$2')
if n is None: print('ABSENT')
else: print(','.join(sorted(a for a in (n.get('Aliases') or []) if a)) or 'NONE')
"
}

# ── the database: must be attached WITH the aliases ───────────────────────
if ! docker inspect "$PG" >/dev/null 2>&1; then
  no "$PG is not running -- start the central stack first"; exit 3
fi
CUR="$(aliases_on "$PG" "$DB_NET")"
case "$CUR" in
  *postgres*)
    ok "$PG on $DB_NET with aliases: $CUR" ;;
  ABSENT)
    docker network connect --alias postgres --alias db "$DB_NET" "$PG" \
      && ok "attached $PG to $DB_NET with aliases postgres,db" \
      || { no "could not attach $PG"; exit 3; } ;;
  *)
    # Attached, but without the alias the app images need. Reconnecting only
    # changes THIS network's attachment; every other network is untouched and
    # the container is not restarted.
    note "$PG is on $DB_NET but without the postgres alias (has: $CUR)"
    docker network disconnect "$DB_NET" "$PG" \
      && docker network connect --alias postgres --alias db "$DB_NET" "$PG" \
      && ok "reattached with aliases postgres,db" \
      || { no "could not reattach $PG"; exit 3; } ;;
esac

# ── the proxy: attachment only, no aliases needed ─────────────────────────
if docker inspect "$CADDY" >/dev/null 2>&1; then
  if [ "$(aliases_on "$CADDY" "$EDGE_NET")" = ABSENT ]; then
    docker network connect "$EDGE_NET" "$CADDY" \
      && ok "attached $CADDY to $EDGE_NET" \
      || { no "could not attach $CADDY"; exit 3; }
  else
    ok "$CADDY already on $EDGE_NET"
  fi
else
  note "$CADDY is not running; attach it when the central stack is up"
fi

note "networks ready for '$APP'"
