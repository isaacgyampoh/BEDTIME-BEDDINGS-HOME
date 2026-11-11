#!/usr/bin/env bash
# ===========================================================================
# Run the Edge Functions for real, against a staging database.
#
#   ./migration-package/scripts/exec-functions.sh bedtime_staging
#
# Not a parse check. Each function runs under the real Deno runtime, pulling
# the real @supabase/* client from esm.sh, answering real HTTP, reading rows
# served from a local PostgreSQL by postgrest-shim.mjs.
#
# NOTHING LEAVES THIS MACHINE
#   MNOTIFY_KEY, ARKESEL_API_KEY and WASENDER_API_KEY are deliberately unset,
#   and every sender in this codebase returns early without a key. The report
#   endpoints are called with &dry=1, which builds the message and returns it
#   without sending. No SMS, no WhatsApp, no payment is initiated.
#
# WHY DENO IS AVAILABLE AT ALL
#   `curl … | sh` from deno.land is refused in the environment this was built
#   in. `npm install deno` is not, and installs the same binary. One refused
#   route is not an absent capability.
# ===========================================================================
set -uo pipefail
set +m          # no "Terminated" chatter when the previous function is killed
DB="${1:-bedtime_staging}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$(dirname "$HERE")")"
PORT_SHIM=54321
PORT_FN=8000

bold () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# Deno. An already-installed one wins — CI and a developer's machine will
# usually have it, and $DENO_BIN lets a caller point at any copy. Only if
# none is found does this install one from npm, and the output is NOT
# silenced: hiding that install's errors is what made this script report
# "could not obtain Deno" with no reason the first time it ran.
DENO=""
for cand in "${DENO_BIN:-}" "$(command -v deno 2>/dev/null)" "$HERE/.deno/node_modules/.bin/deno"; do
  [ -n "$cand" ] && [ -x "$cand" ] && { DENO="$cand"; break; }
done
if [ -z "$DENO" ]; then
  bold "No Deno found; installing it from npm (once)"
  DENO_DIR="$HERE/.deno"
  mkdir -p "$DENO_DIR"
  ( cd "$DENO_DIR" \
    && printf '{"name":"bedtime-deno-host","private":true,"version":"0.0.0"}\n' > package.json \
    && npm install deno@2.9.6 --no-audit --no-fund --loglevel=error ) || {
      no "npm could not install Deno — the output above says why"
      no "install it yourself, or set DENO_BIN=/path/to/deno"
      exit 1
    }
  DENO="$DENO_DIR/node_modules/.bin/deno"
fi
[ -x "$DENO" ] || { no "no usable Deno at '$DENO'"; exit 1; }
ok "deno $("$DENO" --version 2>/dev/null | head -1 | awk '{print $2}') ($DENO)"

psql -lqt | cut -d'|' -f1 | grep -qw "$DB" || { no "database '$DB' does not exist"; exit 1; }
ok "staging database: $DB"

cleanup () { kill $SHIM_PID 2>/dev/null; pkill -f "deno run.*supabase/functions" 2>/dev/null; }
trap cleanup EXIT

bold "Seeding fixtures"
# Self-contained on purpose: this used to rely on rows seeded by hand, so a
# run against a freshly rebuilt staging database failed with HTTP 500s and
# "second run sent None". A harness that needs manual setup is not rerunnable.
if psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/fixtures.sql" 2>/dev/null; then
  ok "7 fx-* fixtures in $DB (disposable; never real orders)"
else
  no "could not seed fixtures into $DB"; exit 1
fi

bold "Starting the PostgREST shim"
node "$HERE/postgrest-shim.mjs" "$DB" "$PORT_SHIM" --allow-writes >/tmp/bedtime-shim.log 2>&1 &
SHIM_PID=$!
for i in $(seq 1 20); do
  curl -s -o /dev/null --max-time 2 "http://localhost:$PORT_SHIM/rest/v1/products?select=id&limit=1" 2>/dev/null && break
  sleep 0.3
done
curl -s --max-time 3 "http://localhost:$PORT_SHIM/rest/v1/products?select=id&limit=1" 2>/dev/null | grep -q '\[' \
  && ok "shim answering on :$PORT_SHIM" || { no "shim did not come up"; exit 1; }

run_fn () {           # run_fn <name> ; leaves it listening on $PORT_FN
  pkill -f "deno run.*supabase/functions" 2>/dev/null; sleep 0.5
  SUPABASE_URL="http://localhost:$PORT_SHIM" \
  SUPABASE_SERVICE_ROLE_KEY=shim-key \
  APP_URL=https://bedtimehome.com \
  ADMIN_SMS_PHONES=0548124978 \
  SHOP_PHONE="054 812 4978" \
  OWNER_PHONE=233548124978 \
  PAYSTACK_SECRET_KEY="${PAYSTACK_SECRET_KEY:-sk_test_local_only}" \
    "$DENO" run --no-lock --allow-net --allow-env "$ROOT/supabase/functions/$1/index.ts" \
      >"/tmp/bedtime-fn-$1.log" 2>&1 &
  # Readiness means the port answers, NOT that a GET succeeds. `curl -f`
  # treats a 4xx as failure, and whatsapp-bot correctly answers a GET with
  # 400 while paystack-webhook answers 405 — so -f reported both as "did not
  # start" when both were running perfectly well.
  for i in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$PORT_FN/" 2>/dev/null)
    [ -n "$code" ] && [ "$code" != "000" ] && return 0
    sleep 0.4
  done
  return 1
}

fail=0

bold "sms-reports — all seven report types"
if run_fn sms-reports; then
  for t in morning midday evening lowstock weekly monthly test; do
    code=$(curl -s -o /tmp/r.json -w '%{http_code}' "http://localhost:$PORT_FN/?type=$t&dry=1")
    sent=$(python3 -c "import json;print(json.load(open('/tmp/r.json')).get('sent'))" 2>/dev/null)
    len=$(python3 -c "import json;print(len(json.load(open('/tmp/r.json')).get('message') or ''))" 2>/dev/null)
    if [ "$code" = "200" ] && [ "$sent" = "False" ] && [ "${len:-0}" -gt 0 ]; then ok "$t: 200, $len chars, sent=false"
    else no "$t: HTTP $code sent=$sent len=$len"; fail=$((fail+1)); fi
  done
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT_FN/?type=quarterly")
  [ "$code" = "400" ] && ok "an unknown type is refused with 400" || { no "unknown type gave $code, expected 400"; fail=$((fail+1)); }
else no "sms-reports did not start"; fail=$((fail+1)); fi

bold "super-service — the payment reminder, twice"
if run_fn super-service; then
  psql -q -d "$DB" -f "$HERE/fixtures.sql" 2>/dev/null
  a=$(curl -s -X POST "http://localhost:$PORT_FN/?action=remind" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reminders'))" 2>/dev/null)
  b=$(curl -s -X POST "http://localhost:$PORT_FN/?action=remind" | python3 -c "import sys,json;print(json.load(sys.stdin).get('reminders'))" 2>/dev/null)
  ok "first run sent $a"
  if [ "${b:-x}" = "0" ]; then ok "second run sent 0 — idempotent"
  else no "second run sent $b; reminders are NOT idempotent"; fail=$((fail+1)); fi
else no "super-service did not start"; fail=$((fail+1)); fi

bold "ussd-handler — must answer in the telco's envelope, not text/plain"
if run_fn ussd-handler; then
  ct=$(curl -s -o /dev/null -D - -X POST "http://localhost:$PORT_FN/" | grep -i '^content-type' | tr -d '\r' | awk '{print $2}')
  case "$ct" in application/json*) ok "content-type: $ct" ;; *) no "content-type: $ct"; fail=$((fail+1)) ;; esac
  curl -s -X POST "http://localhost:$PORT_FN/" | grep -q '"continueSession":false' \
    && ok "ends the session rather than offering a dead menu" || { no "did not end the session"; fail=$((fail+1)); }
else no "ussd-handler did not start"; fail=$((fail+1)); fi

bold "wa-agent"
if run_fn wa-agent; then
  curl -s "http://localhost:$PORT_FN/?action=ping" | grep -q '"ok":true' && ok "ping" || { no "ping"; fail=$((fail+1)); }
  curl -s -X POST "http://localhost:$PORT_FN/?action=follow-ups" | grep -q '"ok":true' && ok "follow-ups" || { no "follow-ups"; fail=$((fail+1)); }
else no "wa-agent did not start"; fail=$((fail+1)); fi

bold "whatsapp-bot"
if run_fn whatsapp-bot; then
  c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT_FN/" -H 'Content-Type: application/json' -d '{}')
  [ "$c" = "200" ] && ok "a valid body: 200" || { no "valid body gave $c"; fail=$((fail+1)); }
  c=$(curl -s -o /tmp/w.json -w '%{http_code}' -X POST "http://localhost:$PORT_FN/" -H 'Content-Type: application/json' -d '{not json')
  if [ "$c" = "400" ]; then ok "malformed JSON: 400, so a webhook will not retry it forever"
  else no "malformed JSON gave $c, expected 400"; fail=$((fail+1)); fi
  grep -q 'body must be JSON' /tmp/w.json && ok "and the parser's own message is not echoed back" || { no "internals may be leaking"; fail=$((fail+1)); }
else no "whatsapp-bot did not start"; fail=$((fail+1)); fi

bold "paystack-webhook — signature, amount, idempotency"
psql -q -d "$DB" -f "$HERE/fixtures.sql" 2>/dev/null
if run_fn paystack-webhook; then
  PAYSTACK_SECRET_KEY="${PAYSTACK_SECRET_KEY:-sk_test_local_only}" FN_URL="http://localhost:$PORT_FN/" node "$HERE/hit-webhook.mjs" || fail=$((fail+1))
else no "paystack-webhook did not start"; fail=$((fail+1)); fi

bold "Result"
if [ "$fail" -eq 0 ]; then printf '  \033[32mall checks passed\033[0m — 0 SMS, 0 WhatsApp, 0 payments initiated\n'
else printf '  \033[31m%s check(s) failed\033[0m\n' "$fail"; fi
exit "$fail"
