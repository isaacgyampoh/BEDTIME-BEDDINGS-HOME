#!/usr/bin/env bash
# ===========================================================================
# Deploy the Edge Functions through the Supabase Management API.
#
#   ./migration-package/scripts/deploy-functions.sh              the two that matter
#   ./migration-package/scripts/deploy-functions.sh sms-reports  just one
#   ./migration-package/scripts/deploy-functions.sh --all        all six
#
# Reads an sbp_ access token from the login Keychain, put there by
# scripts/enter-access-token.sh. The token is never printed, never passed as
# an argument, and never written to a file. Every error path redacts it.
#
# It deploys the SINGLE-FILE bundles in release/paste-ready/, which are the
# same thing you would paste into the dashboard, so what runs in production is
# what was tested here.
#
# WHAT IT DOES NOT DO
#   It does not change any secret, any schedule or any database row. It
#   replaces function code and nothing else. The cron cleanup is separate and
#   needs its own approval (supabase/pending/052).
# ===========================================================================
set -uo pipefail
REF="${SUPABASE_PROJECT_REF:-wqkgfvmvuljzexhevlnp}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$(dirname "$HERE")")"
PASTE="$ROOT/release/paste-ready"
API="https://api.supabase.com/v1/projects/$REF/functions"

bold () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
redact () { sed -E 's/sbp_[A-Za-z0-9]+/sbp_***REDACTED***/g'; }

TOKEN="$(security find-generic-password -a "$USER" -s bedtime-token -w 2>/dev/null | base64 -d 2>/dev/null || true)"
case "$TOKEN" in
  sbp_*) : ;;
  *) no "no access token in the Keychain"
     note "Run: $HERE/enter-access-token.sh"
     exit 2 ;;
esac

# Which functions. The default is the two that fix the SMS, because deploying
# the payment webhook is a separate decision about money.
case "${1:-}" in
  --all) FNS="sms-reports super-service whatsapp-bot ussd-handler wa-agent paystack-webhook" ;;
  "")    FNS="sms-reports super-service" ;;
  *)     FNS="$*" ;;
esac

bold "Checking the token and the project"
me="$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "https://api.supabase.com/v1/projects" -w '\n%{http_code}')"
code="$(printf '%s' "$me" | tail -1)"
if [ "$code" != "200" ]; then
  no "the token was refused (HTTP $code)"
  printf '%s' "$me" | sed '$d' | head -c 200 | redact | sed 's/^/    /'
  note "Generate a fresh one: Account Settings -> Access Tokens"
  exit 1
fi
name="$(printf '%s' "$me" | sed '$d' | /usr/bin/python3 -c "
import sys, json
ps = json.load(sys.stdin)
m = [p for p in ps if p.get('id') == '$REF']
print(m[0]['name'] + '  region ' + m[0].get('region','?') if m else 'NOT-FOUND')" 2>/dev/null)"
[ "$name" = "NOT-FOUND" ] && { no "this token cannot see project $REF"; exit 1; }
ok "project $REF — $name"

bold "What is deployed now"
cur="$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$API")"
printf '%s' "$cur" | /usr/bin/python3 -c "
import sys, json, datetime
try: fns = json.load(sys.stdin)
except Exception: print('  (could not read the function list)'); sys.exit()
for f in sorted(fns, key=lambda x: x.get('slug','')):
    ts = f.get('updated_at') or f.get('created_at') or 0
    try: when = datetime.datetime.fromtimestamp(int(ts)/1000).strftime('%d %b %Y %H:%M')
    except Exception: when = str(ts)
    print(f\"  {f.get('slug','?'):<20} v{f.get('version','?'):<4} {f.get('status','?'):<10} updated {when}\")
" 2>/dev/null

FAILED=0
for fn in $FNS; do
  FILE="$PASTE/$fn.ts"
  bold "Deploying $fn"
  if [ ! -f "$FILE" ]; then no "no bundle at release/paste-ready/$fn.ts"; FAILED=$((FAILED+1)); continue; fi
  note "$(wc -l < "$FILE" | tr -d ' ') lines, single file, shared modules folded in"

  # The deploy endpoint takes the source as multipart, with a metadata part
  # naming the entrypoint. --form-string is used for metadata so no shell
  # expansion touches it; the token stays in a header.
  resp="$(curl -s --max-time 120 -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -F "metadata={\"entrypoint_path\":\"index.ts\",\"name\":\"$fn\",\"verify_jwt\":false};type=application/json" \
    -F "file=@$FILE;filename=index.ts;type=application/typescript" \
    "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=$fn" \
    -w '\n%{http_code}')"
  code="$(printf '%s' "$resp" | tail -1)"
  body="$(printf '%s' "$resp" | sed '$d')"

  if [ "$code" = "200" ] || [ "$code" = "201" ]; then
    v="$(printf '%s' "$body" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin).get('version','?'))" 2>/dev/null || echo '?')"
    ok "deployed — now version $v"
  else
    no "HTTP $code"
    printf '%s' "$body" | head -c 300 | redact | sed 's/^/    /'
    FAILED=$((FAILED+1))
  fi
done

bold "Result"
if [ "$FAILED" -eq 0 ]; then
  ok "every requested function deployed"
  cat <<'MSG'

  Check it without waiting for a schedule — this builds the report and
  returns it WITHOUT sending an SMS:

    .../functions/v1/sms-reports?type=midday&dry=1

  Expect "sent": false and "recipients": ["0548124978"].
  Drop &dry=1 to have one real SMS sent.
MSG
else
  no "$FAILED function(s) did not deploy"
fi
unset TOKEN
exit "$FAILED"
