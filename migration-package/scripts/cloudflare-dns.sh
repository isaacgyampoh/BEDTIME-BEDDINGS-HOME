#!/usr/bin/env bash
# ===========================================================================
# Create Bedtime's API DNS record, without being able to damage any other.
#
#   ./cloudflare-dns.sh token           store a Cloudflare API token (dialog)
#   ./cloudflare-dns.sh list            read-only: every record in the zone
#   ./cloudflare-dns.sh create          create api.bedtimehome.com -> the VPS
#
# PRESERVING EXISTING RECORDS IS ENFORCED, NOT PROMISED
#
# `create` only ever issues POST /dns_records, which can add a record and
# cannot alter one. There is no PUT, PATCH or DELETE anywhere in this file --
# grep it. Before posting, it lists the zone and REFUSES if any record already
# answers for api.bedtimehome.com, so an existing record is never shadowed by
# a second one either.
#
# It also prints the full record list before and after, so "nothing else
# changed" is something you can read rather than take on trust.
#
# THE RECORD
#   type A, name api, content 169.58.120.116, proxied FALSE, ttl 1 (= Auto)
#
# Proxy must be OFF. api.everytinroom.com resolves straight to the IP with no
# Cloudflare proxy, and proxying would also break Caddy's ACME HTTP-01
# challenge, so the certificate would never issue.
#
# THE TOKEN
#   Needs Zone:DNS:Edit on this zone and nothing more. Create it at
#   dash.cloudflare.com -> My Profile -> API Tokens -> Create Token ->
#   "Edit zone DNS" template -> Zone Resources: bedtimehome.com.
#   It is stored base64'd in the login Keychain as `bedtime-cf-dns`, fed to
#   `security` on stdin, and never printed, logged or placed in argv.
# ===========================================================================
set -uo pipefail
SERVICE=bedtime-cf-dns
ZONE_NAME=bedtimehome.com
REC_NAME=api.bedtimehome.com
REC_CONTENT=169.58.120.116
API=https://api.cloudflare.com/client/v4

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

CMD="${1:-list}"

# ── the dialog ────────────────────────────────────────────────────────────
if [ "$CMD" = token ]; then
  [ "$(uname -s)" = Darwin ] || { echo "macOS only." >&2; exit 2; }
  PROMPT="Cloudflare API token for Bedtime's DNS record.

Create it at dash.cloudflare.com → My Profile → API Tokens → Create Token,
using the \"Edit zone DNS\" template, with Zone Resources limited to
bedtimehome.com.

It needs Zone:DNS:Edit and nothing more.

Stored only in your login Keychain. Never shown, logged or committed."
  AS="$(printf '%s' "$PROMPT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}')"
  EF="$(mktemp -t bedtime-cf)"
  RAW="$(osascript 2>"$EF" <<APPLESCRIPT
with timeout of 1800 seconds
    tell application "System Events"
        activate
        display dialog "$AS" with title "Cloudflare DNS token" default answer "" with hidden answer buttons {"Cancel", "Store"} default button "Store" with icon note
    end tell
end timeout
APPLESCRIPT
)"
  rc=$?; err="$(tr -d '\n' < "$EF")"; rm -f "$EF"
  if [ "$rc" -ne 0 ]; then
    case "$err" in
      *"User canceled"*|*"user canceled"*|*-128*) echo "Cancelled. Nothing was stored."; exit 1 ;;
      *) no "the dialog could not be shown:"; printf '      %s\n' "$err" >&2; exit 3 ;;
    esac
  fi
  TOK="${RAW#*text returned:}"; TOK="${TOK%%, button returned:*}"; unset RAW
  TOK="$(printf '%s' "$TOK" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
  [ -n "$TOK" ] || { no "nothing was entered"; exit 1; }
  case "$TOK" in
    *[!A-Za-z0-9_-]*) no "that contains characters a Cloudflare token does not have. Nothing stored."; exit 1 ;;
  esac
  [ "${#TOK}" -ge 30 ] || { no "that is ${#TOK} characters; a token is around 40. Nothing stored."; exit 1; }
  ok "token accepted (${#TOK} characters, not shown)"

  # Verify BEFORE storing, so a wrong value is rejected at the door.
  V="$(curl -s --max-time 25 "$API/user/tokens/verify" -H "Authorization: Bearer $TOK")"
  if ! printf '%s' "$V" | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
    no "Cloudflare refused that token"
    printf '%s' "$V" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for e in d.get('errors',[])[:2]: print('      ', e.get('message'))" 2>/dev/null
    note "Nothing was stored."
    exit 4
  fi
  ok "Cloudflare verified the token is active"
  if printf 'add-generic-password -a %s -s %s -w %s -U\n' "$USER" "$SERVICE" "$(printf '%s' "$TOK" | base64)" | security -i >/dev/null 2>&1; then
    ok "stored in the login Keychain as '$SERVICE'"
  else
    no "the Keychain refused to store it"; exit 5
  fi
  unset TOK
  note "Next: ./cloudflare-dns.sh list   (read-only)"
  exit 0
fi

# ── token for the read/write commands ─────────────────────────────────────
TOK="$(security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null | base64 -d 2>/dev/null)"
[ -n "$TOK" ] || { no "no Cloudflare token stored"; note "Run: $0 token"; exit 2; }

cf () { curl -s --max-time 40 -H "Authorization: Bearer $TOK" "$@"; }

ZID="$(cf "$API/zones?name=$ZONE_NAME" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if not d.get('success'): raise SystemExit
r=d.get('result') or []
print(r[0]['id'] if r else '')" 2>/dev/null)"
if [ -z "$ZID" ]; then
  no "could not find the zone $ZONE_NAME with this token"
  note "The token may be scoped to a different zone, or lack Zone:Read."
  exit 3
fi
ok "zone $ZONE_NAME found"

show_records () {
  cf "$API/zones/$ZID/dns_records?per_page=100" | python3 -c "
import sys,json
d=json.load(sys.stdin)
rs=d.get('result') or []
print(f'  {len(rs)} record(s):')
for r in sorted(rs,key=lambda x:(x['type'],x['name'])):
    px='proxied' if r.get('proxied') else 'dns-only'
    c=(r.get('content') or '')[:46]
    print(f\"    {r['type']:<6} {r['name']:<34} {c:<48} {px}\")"
}

case "$CMD" in

list)
  say "Every record in $ZONE_NAME (read-only)"
  show_records
  ;;

create)
  say "Before — every record in $ZONE_NAME"
  show_records

  EXISTING="$(cf "$API/zones/$ZID/dns_records?name=$REC_NAME&per_page=100" | python3 -c "
import sys,json
d=json.load(sys.stdin)
rs=d.get('result') or []
for r in rs: print(f\"{r['type']} {r['name']} -> {r.get('content')}\")" 2>/dev/null)"
  if [ -n "$EXISTING" ]; then
    no "something already answers for $REC_NAME:"
    printf '%s\n' "$EXISTING" | sed 's/^/      /'
    note "REFUSING. This script never alters or removes a record, and will not"
    note "add a second one that shadows an existing answer."
    exit 6
  fi
  ok "nothing answers for $REC_NAME yet"

  say "Creating the record"
  note "A  $REC_NAME  ->  $REC_CONTENT  (dns-only, ttl auto)"
  BODY="$(python3 -c "
import json
print(json.dumps({'type':'A','name':'$REC_NAME','content':'$REC_CONTENT',
                  'proxied':False,'ttl':1,
                  'comment':'Bedtime API on the central Contabo platform'}))")"
  R="$(cf -X POST "$API/zones/$ZID/dns_records" -H 'Content-Type: application/json' --data "$BODY")"
  if printf '%s' "$R" | python3 -c "import sys,json;sys.exit(0 if json.load(sys.stdin).get('success') else 1)" 2>/dev/null; then
    ok "created"
  else
    no "Cloudflare refused the create"
    printf '%s' "$R" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for e in d.get('errors',[])[:3]: print('      ', e.get('code'), e.get('message'))" 2>/dev/null
    exit 7
  fi

  say "After — every record in $ZONE_NAME"
  show_records
  note "Compare the two lists: exactly one line should be new."
  ;;

*) no "unknown command '$CMD'"; note "token | list | create"; exit 2 ;;
esac
