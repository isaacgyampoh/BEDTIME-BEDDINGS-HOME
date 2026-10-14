#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Everything outstanding, in the order it is safe to do it.
#
#   ./scripts/go-live.sh functions   deploy the edge functions
#   ./scripts/go-live.sh db          apply 042, 045, 046, 047
#   ./scripts/go-live.sh verify      check it all from outside (writes nothing)
#   ./scripts/go-live.sh sessions    apply 043 + 044  — LAST, see below
#   ./scripts/go-live.sh cloudflare  create the Pages projects and publish
#
# ORDER MATTERS. 043 and 044 move the portal and the orders table to
# "signed-in staff only". Applied before staff sessions are working, every
# admin screen goes blank. That is why they are a separate step you run only
# after signing in on a real device.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=wqkgfvmvuljzexhevlnp
FN=https://$PROJECT.supabase.co/functions/v1
REST=https://$PROJECT.supabase.co/rest/v1
ANON=$(grep -ohE "eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+" src/lib/supabase.js | head -1)

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

case "${1:-}" in

functions)
  say "Deploying the edge functions"
  echo "  super-service carries staff sign-in, the voice token and the payment guard."
  echo "  sms-reports sends the daily reports to the new number."
  supabase functions deploy super-service --project-ref "$PROJECT"
  supabase functions deploy sms-reports  --project-ref "$PROJECT"
  ok "deployed — now run: $0 db"
  ;;

db)
  say "Applying 042, 045, 046, 047"
  echo "  042  removes anon privileges nothing uses"
  echo "  045  lets a staff member be created again (staff.pin NOT NULL)"
  echo "  046  exempts the new SMS number from the message cap"
  echo "  047  the order total is computed by the database, not sent by the browser"
  echo
  echo "  043 and 044 are held back; they are the 'sessions' step."
  HOLD=$(mktemp -d)
  # Restored even if the push fails half way.
  trap 'mv "$HOLD"/*.sql supabase/migrations/ 2>/dev/null || true; rmdir "$HOLD" 2>/dev/null || true' EXIT
  mv supabase/migrations/043_*.sql supabase/migrations/044_*.sql "$HOLD"/
  supabase db push --linked --include-all
  ok "applied — now run: $0 verify"
  ;;

verify)
  say "Checking from outside (this writes nothing)"

  applied=$(supabase migration list --linked 2>/dev/null \
    | grep -oE '"remote":"04[2-7]"' | grep -oE '04[2-7]' | sort -u | tr '\n' ' ')
  if [ -n "$applied" ]; then ok "migrations applied: $applied"
  else bad "none of 042-047 applied yet — run: $0 db"; fi

  r=$(curl -s -X POST "$FN/super-service?action=realtime-token" \
        -H 'Content-Type: application/json' -H 'Origin: https://www.bedtimehome.com' -d '{}')
  case "$r" in
    *'"value"'*)          ok "voice: a session key was minted — speech-to-speech is live" ;;
    *not-configured*)     bad "voice: deployed, but OPENAI_API_KEY is not set" ;;
    *'Use ?action='*)     bad "voice: super-service has not been redeployed yet" ;;
    *)                    bad "voice: $(echo "$r" | head -c 120)" ;;
  esac

  # A deliberately wrong PIN: proves the function is reachable, changes nothing.
  r=$(curl -s -X POST "$REST/rpc/admin_save_staff" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
        -H 'Content-Type: application/json' \
        -d '{"p_admin_pin":"0000","p_name":"probe","p_role":"Cashier","p_pin":"1234"}')
  case "$r" in
    *"Admin PIN is incorrect"*) ok "staff: the save function answers correctly" ;;
    *) bad "staff: $(echo "$r" | head -c 140)" ;;
  esac

  say "Now, by hand, on a real device"
  echo "  1. Sign in to the POS. If that works, staff sessions are good."
  echo "  2. Add a staff member (this is what 045 fixes)."
  echo "  3. Only then: $0 sessions"
  ;;

sessions)
  say "Applying 043 + 044 — the portal becomes staff-only"
  echo "  Do this ONLY after signing in successfully on a real device."
  read -r -p "  Have staff signed in successfully since deploying? [yes/N] " a
  [ "$a" = "yes" ] || { bad "stopped"; exit 1; }
  supabase db push --linked --include-all
  ok "applied — check the admin screens now; if they are blank, tell Claude at once"
  ;;

cloudflare)
  say "Cloudflare Pages"
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (Pages: Edit) first}"
  : "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID first}"
  npx -y wrangler@4 pages project create bedtime-admin --production-branch main || true
  npx -y wrangler@4 pages project create bedtime-shop  --production-branch main || true
  npm run build
  (cd storefront && npm run build)
  npx -y wrangler@4 pages deploy dist            --project-name=bedtime-admin --branch=main
  (cd storefront && npx -y wrangler@4 pages deploy dist --project-name=bedtime-shop --branch=main)
  ok "published — check the .pages.dev URLs BEFORE changing any DNS"
  ;;

*)
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
  ;;
esac
