#!/usr/bin/env bash
# ===========================================================================
# Prove that no application on this server can reach another one's data.
#
#   check-tenant-isolation.sh              every application pair
#   check-tenant-isolation.sh bedtime      one application against the others
#
# READ-ONLY. Every check is a privilege query, a network probe from a
# throwaway container, or a file mode. Nothing is created, changed or removed.
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH IN A README
#
# Each of these was a real hole on this server, found one at a time during
# Bedtime's migration, and each would have been invisible without being asked
# about directly:
#
#   1. bedtime_private.call_edge() is SECURITY DEFINER and posts with the
#      application's service key. PostgreSQL's default is PUBLIC EXECUTE, so
#      one GRANT USAGE on the schema away from letting any tenant issue
#      requests authenticated as another.
#   2. The per-app Docker networks are what stop one application's containers
#      resolving another's by service name. provision-app.sh did not create
#      them, so the first application provisioned after that change had none.
#   3. The app's own .env and functions.env hold its database password and
#      service-role key. Mode 600 is the only thing between them and any
#      other account on the box.
#   4. An application's database role must not be able to CONNECT to another
#      application's database at all.
#
# Exit status is the number of problems, so it can gate a deploy.
# ===========================================================================
set -uo pipefail

ONLY="${1:-}"
PROBLEMS=0

ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad  () { printf '  \033[31m✗\033[0m %s\n' "$*"; PROBLEMS=$((PROBLEMS+1)); }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }

pq () { docker exec -i central-postgres psql -U postgres -d "${1}" -tAqX -c "${2}" < /dev/null 2>/dev/null; }

APPS="$(pq postgres "select name from central.applications order by name" | tr '\n' ' ')"
[ -n "$APPS" ] || { echo "No applications registered in central.applications." >&2; exit 2; }
say "Applications on this server"
note "$APPS"

# ── 1. database connect isolation, every ordered pair ─────────────────────
say "1. No application's role may connect to another's database"
for a in $APPS; do
  [ -n "$ONLY" ] && [ "$a" != "$ONLY" ] && continue
  for b in $APPS; do
    [ "$a" = "$b" ] && continue
    for role in "${a}_authenticator" "${a}_storage" "${a}_auth" "${a}_realtime"; do
      exists="$(pq postgres "select 1 from pg_roles where rolname = '$role'")"
      [ "$exists" = "1" ] || continue
      can="$(pq postgres "select has_database_privilege('$role','$b','CONNECT')::text")"
      if [ "$can" = "true" ]; then
        bad "$role CAN connect to the $b database"
      else
        ok "$role cannot reach $b"
      fi
    done
  done
done

# ── 2. the edge-caller must not be PUBLIC-executable ──────────────────────
say "2. Each <app>_private.call_edge is owner-only"
for a in $APPS; do
  [ -n "$ONLY" ] && [ "$a" != "$ONLY" ] && continue
  sch="${a}_private"
  present="$(pq postgres "select 1 from pg_namespace where nspname = '$sch'")"
  [ "$present" = "1" ] || { note "$sch does not exist (no scheduled edge calls)"; continue; }
  pub="$(pq postgres "select has_function_privilege('public','$sch.call_edge(text)','EXECUTE')::text")"
  [ "$pub" = "true" ] && bad "$sch.call_edge is executable by PUBLIC" || ok "$sch.call_edge is not PUBLIC-executable"
  su="$(pq postgres "select has_schema_privilege('public','$sch','USAGE')::text")"
  [ "$su" = "true" ] && bad "$sch has PUBLIC USAGE" || ok "$sch USAGE is owner-only"
  # And no other tenant's role may read the config table that holds the key.
  for b in $APPS; do
    [ "$a" = "$b" ] && continue
    r="${b}_authenticator"
    e="$(pq postgres "select 1 from pg_roles where rolname = '$r'")"
    [ "$e" = "1" ] || continue
    cr="$(pq postgres "select has_table_privilege('$r','$sch.app_config','SELECT')::text")"
    [ "$cr" = "true" ] && bad "$r can read $sch.app_config (service key!)" || ok "$r cannot read $sch.app_config"
  done
done

# ── 3. network isolation, proved rather than assumed ──────────────────────
say "3. One application's containers cannot reach another's"
for a in $APPS; do
  [ -n "$ONLY" ] && [ "$a" != "$ONLY" ] && continue
  adns="$(printf '%s' "$a" | tr '_' '-')"
  net="app_${adns}_edge"
  docker network inspect "$net" >/dev/null 2>&1 || { bad "$net does not exist -- run ensure-app-networks.sh $a"; continue; }
  # Positive control first: if the app's own service is not reachable from its
  # own network, the probe itself is broken and every "unreachable" below
  # would be meaningless.
  self="$(docker run --rm --network "$net" curlimages/curl:8.11.1 -s -o /dev/null \
            -w '%{http_code}' --max-time 6 "http://${adns}-rest:3000/" 2>/dev/null)"
  if [ "${self:-000}" = "000" ]; then
    bad "control failed: ${adns}-rest is unreachable from its OWN network, so this probe proves nothing"
    continue
  fi
  ok "control: ${adns}-rest answers ${self} from $net"
  for b in $APPS; do
    [ "$a" = "$b" ] && continue
    bdns="$(printf '%s' "$b" | tr '_' '-')"
    for svc in rest storage functions; do
      code="$(docker run --rm --network "$net" curlimages/curl:8.11.1 -s -o /dev/null \
                -w '%{http_code}' --max-time 6 "http://${bdns}-${svc}:3000/" 2>/dev/null)"
      [ "${code:-000}" = "000" ] && ok "$a cannot reach ${bdns}-${svc}" \
                                 || bad "$a CAN reach ${bdns}-${svc} (HTTP $code)"
    done
  done
done

# ── 4. secret file modes ──────────────────────────────────────────────────
say "4. Each application's secrets are readable only by root"
for a in $APPS; do
  [ -n "$ONLY" ] && [ "$a" != "$ONLY" ] && continue
  for f in "/srv/central/apps/$a/.env" "/srv/central/apps/$a/functions.env"; do
    [ -f "$f" ] || { note "$(basename "$f") absent for $a"; continue; }
    m="$(stat -c '%a' "$f")"
    case "$m" in
      600|400) ok "$(basename "$f") ($a) is mode $m" ;;
      *)       bad "$(basename "$f") ($a) is mode $m -- should be 600" ;;
    esac
  done
done

# ── 5. no shared network left behind ──────────────────────────────────────
say "5. Applications are off the shared central_db / central_edge networks"
for n in central_db central_edge; do
  docker network inspect "$n" >/dev/null 2>&1 || { note "$n does not exist"; continue; }
  members="$(docker network inspect "$n" --format '{{range $k,$v := .Containers}}{{$v.Name}} {{end}}' 2>/dev/null)"
  shared=""
  for m in $members; do
    case "$m" in central-*) : ;; *) shared="${shared}${m} " ;; esac
  done
  if [ -n "$shared" ]; then
    note "$n still carries: $shared"
    note "not a hole by itself -- both tenants would have to be on it -- but"
    note "it is how the per-app isolation gets quietly undone. Move them with"
    note "scripts/leave-shared-networks.sh when convenient."
  else
    ok "$n carries only shared infrastructure"
  fi
done

say "Result"
[ "$PROBLEMS" -eq 0 ] && ok "no cross-tenant exposure found" || bad "$PROBLEMS problem(s)"
exit "$PROBLEMS"
