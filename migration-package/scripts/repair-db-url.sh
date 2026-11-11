#!/usr/bin/env bash
# ===========================================================================
# Make the stored connection URI actually usable, and store the repaired one.
#
#   ./migration-package/scripts/repair-db-url.sh
#
# TWO THINGS GO WRONG WITH WHAT THE DASHBOARD HANDS YOU
#
# 1. A password containing a reserved character.
#    In a URI the password sits in the userinfo, and `@` there must be written
#    %40. Unencoded, libpq splits on the FIRST @ and treats the rest as the
#    hostname:
#      could not translate host name "12345@db.<ref>.supabase.co" to address
#    Every reserved character is percent-encoded here. The password is never
#    printed, never passed as an argument, and never written to a file.
#
# 2. db.<ref>.supabase.co is IPv6-ONLY.
#    Supabase retired IPv4 on direct connections. The host has an AAAA record
#    and no A record, so a machine without an IPv6 route cannot reach it at
#    all — checked before changing anything. The connection pooler is
#    dual-stack and is the documented path.
#
#    The pooler needs a different username: postgres.<project-ref> rather than
#    postgres, and a region in the hostname. The region is not in the direct
#    URI, so it is discovered by trying the pooler hosts with the real
#    credential: "Tenant or user not found" means the wrong region, an
#    authentication failure or a success means the right one. That is host
#    discovery with a credential we were given, not credential guessing.
#
# Read-only against Supabase: every probe is a connection attempt that runs
# `select 1`.
# ===========================================================================
set -uo pipefail
SERVICE=bedtime-db
ACCOUNT="$USER"

say  () { printf '\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

raw="$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null || true)"
[ -n "$raw" ] || { no "no credential in the Keychain"; exit 2; }
URL="$(printf '%s' "$raw" | base64 -d 2>/dev/null || printf '%s' "$raw")"
unset raw
case "$URL" in postgres://*|postgresql://*) : ;; *) no "not a postgres URI"; exit 2 ;; esac

# Split the URI without printing any of it. The LAST @ delimits userinfo from
# host, per RFC 3986, which is what makes a password containing @ recoverable.
SCHEME="${URL%%://*}"
REST="${URL#*://}"
USERINFO="${REST%@*}"
HOSTINFO="${REST##*@}"
DBUSER="${USERINFO%%:*}"
DBPASS="${USERINFO#*:}"
HOSTONLY="${HOSTINFO%%[:/]*}"
TAIL="${HOSTINFO#$HOSTONLY}"          # :5432/postgres
[ -n "$TAIL" ] || TAIL=":5432/postgres"

say "What was stored"
ok "scheme: $SCHEME   user: $DBUSER   host: $HOSTONLY   tail: $TAIL"
note "password: ${#DBPASS} characters, not shown"

# Percent-encode the password. Only the reserved set; nothing else is touched.
ENC="$(printf '%s' "$DBPASS" | /usr/bin/python3 -c \
  'import sys,urllib.parse; sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=""))')"
if [ "$ENC" != "$DBPASS" ]; then
  ok "password needed percent-encoding (${#DBPASS} -> ${#ENC} characters)"
else
  ok "password needs no encoding"
fi

# The project ref is the first label of db.<ref>.supabase.co.
REF=""
case "$HOSTONLY" in
  db.*.supabase.co) REF="${HOSTONLY#db.}"; REF="${REF%%.supabase.co}" ;;
  *.pooler.supabase.com) REF="${DBUSER#postgres.}" ;;
esac
[ -n "$REF" ] && ok "project ref: $REF" || note "could not read a project ref from the host"

say "Is the stored host reachable?"
HAS_A="$(dig +short A "$HOSTONLY" 2>/dev/null | head -1)"
HAS_AAAA="$(dig +short AAAA "$HOSTONLY" 2>/dev/null | head -1)"
[ -n "$HAS_A" ] && ok "IPv4: $HAS_A" || no "no IPv4 (A) record"
[ -n "$HAS_AAAA" ] && note "IPv6: $HAS_AAAA" || true
DIRECT_OK=0
if [ -n "$HAS_A" ] || { [ -n "$HAS_AAAA" ] && nc -z -G 6 -6 "$HAS_AAAA" 5432 2>/dev/null; }; then
  DIRECT_OK=1; ok "the stored host is reachable"
else
  no "the stored host cannot be reached from here"
fi

try_url () {          # try_url <url-without-printing> ; echoes the psql error
  PGCONNECT_TIMEOUT=8 psql "$1" -At -c 'select 1' 2>&1 | head -1
}

FINAL=""
if [ "$DIRECT_OK" -eq 1 ]; then
  say "Trying the stored host with the encoded password"
  CAND="$SCHEME://$DBUSER:$ENC@$HOSTONLY$TAIL"
  out="$(try_url "$CAND")"
  if [ "$out" = "1" ]; then ok "connected"; FINAL="$CAND"
  else no "$(printf '%s' "$out" | sed -E 's#postgres(ql)?://[^[:space:]]*#postgresql://***#g' | cut -c1-120)"; fi
fi

if [ -z "$FINAL" ] && [ -n "$REF" ]; then
  say "Finding the pooler that serves this project"
  note "the region is not in the direct URI, so each candidate is tried once"
  REGIONS="eu-west-2 eu-west-1 eu-central-1 eu-west-3 us-east-1 us-east-2 us-west-1
           ap-south-1 ap-southeast-1 ap-northeast-1 sa-east-1 ca-central-1 eu-north-1
           eu-central-2 ap-southeast-2 ap-northeast-2 us-west-2"
  for prefix in aws-0 aws-1; do
    for r in $REGIONS; do
      host="$prefix-$r.pooler.supabase.com"
      dig +short "$host" >/dev/null 2>&1 || continue
      [ -n "$(dig +short A "$host" 2>/dev/null | head -1)" ] || continue
      CAND="$SCHEME://postgres.$REF:$ENC@$host:5432/postgres"
      out="$(try_url "$CAND")"
      case "$out" in
        1) ok "$host — connected"; FINAL="$CAND"; break 2 ;;
        *"Tenant or user not found"*|*ENOTFOUND*) printf '  \033[90m–\033[0m %s — not this one\n' "$host" ;;
        *"password authentication failed"*)
           no "$host serves this project, but the password was rejected"
           note "the URI may have been copied with the placeholder still in it,"
           note "or the database password has been reset since."
           break 2 ;;
        *) printf '  \033[90m–\033[0m %s — %s\n' "$host" "$(printf '%s' "$out" | cut -c1-60)" ;;
      esac
    done
  done
fi

if [ -z "$FINAL" ]; then
  say "Could not establish a working connection"
  note "Nothing was changed. The stored credential is untouched."
  exit 1
fi

say "Storing the working URI"
security delete-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1 || true
printf 'add-generic-password -a %s -s %s -w %s\n' "$ACCOUNT" "$SERVICE" \
  "$(printf '%s' "$FINAL" | base64)" | security -i >/dev/null 2>&1 \
  && ok "stored (host $(printf '%s' "$FINAL" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#'))" \
  || { no "could not store it"; exit 1; }
unset FINAL ENC DBPASS URL
say "Next"
note "./migration-package/after-credential.sh"
