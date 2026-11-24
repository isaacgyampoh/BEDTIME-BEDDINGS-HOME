#!/usr/bin/env bash
# ===========================================================================
# Put Bedtime's payment and SMS provider credentials onto the Contabo server.
#
#   ./migration-package/scripts/enter-provider-secrets.sh
#
# WHY THIS IS NEEDED, AND WHY I CANNOT DO IT WITHOUT YOU
#
# Supabase's Management API returns only a SHA-256 digest of each secret, not
# its value -- every one came back as exactly 64 characters. So the live
# values cannot be copied across; they have to be entered once.
#
# Until they are, cutover would break two things that matter:
#   NaloPay    no USSD or mobile-money charge can be created
#   mNotify    no SMS is sent, so the owner's reports go nowhere
# Everything else on Contabo already works without them.
#
# WHERE THE VALUES GO
#
# Straight into /srv/central/apps/bedtime/functions.env on the server, over
# ssh on stdin. They are NOT stored on this machine, not in the Keychain, not
# in a file, not in the shell history, and never on a command line where `ps`
# would show them. Nothing is echoed as you type. The file is mode 600 and is
# backed up before each change.
#
# WHAT EACH ONE IS FOR
#
#   NALOPAY_API_KEY       creating a USSD / mobile-money charge
#   NALOPAY_AUTH_HEADER   the Authorization value NaloPay expects
#   NALOPAY_MERCHANT_ID   which merchant the charge belongs to
#   MNOTIFY_KEY           sending the SMS reports to 0548124978
#
# Optional, and skippable with an empty box:
#   TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET   the tiktok-status job. Without
#                       them that job simply does nothing.
#
# Deliberately NOT asked for:
#   PAYSTACK_SECRET_KEY  absent on Supabase too. No Bedtime order has ever
#                        carried a Paystack reference, and its absence makes
#                        ?action=webhook fail closed, which is correct.
#   MOOLRE_*             not configured for Bedtime on Supabase either.
#
# NO PAYMENT IS TESTED BY THIS SCRIPT. It writes configuration and restarts
# the functions container. Verification afterwards is passive only.
# ===========================================================================
set -uo pipefail
HOST=169.58.120.116
KEY="$HOME/.ssh/everytinroom_contabo_rsa"
ENVF=/srv/central/apps/bedtime/functions.env

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

[ "$(uname -s)" = Darwin ] || { echo "macOS only (native dialog)." >&2; exit 2; }
[ -f "$KEY" ] || { no "no $KEY"; exit 2; }

ask () {   # ask <label> <hint> ; prints the value, or __CANCELLED__/__ERROR__
  local label="$1" hint="$2" prompt as ef raw rc err
  prompt="$label

$hint

Nothing you type is shown, logged, committed, or stored on this computer.
It is written only to the server's functions.env (mode 600).

Leave it empty and press Skip if you do not want to set this one."
  as="$(printf '%s' "$prompt" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}')"
  ef="$(mktemp -t bedtime-prov)"
  raw="$(osascript 2>"$ef" <<APPLESCRIPT
with timeout of 1800 seconds
    tell application "System Events"
        activate
        display dialog "$as" with title "Bedtime provider secret — $label" default answer "" with hidden answer buttons {"Cancel", "Skip", "Store"} default button "Store" with icon note
    end tell
end timeout
APPLESCRIPT
)"
  rc=$?; err="$(tr -d '\n' < "$ef")"; rm -f "$ef"
  if [ "$rc" -ne 0 ]; then
    case "$err" in
      *"User canceled"*|*"user canceled"*|*-128*) printf '__CANCELLED__' ;;
      *) printf '__ERROR__%s' "$err" ;;
    esac
    return
  fi
  case "$raw" in *"button returned:Skip"*) printf '__SKIP__'; return ;; esac
  raw="${raw#*text returned:}"; raw="${raw%%, button returned:*}"
  printf '%s' "$raw" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

NAMES=(NALOPAY_API_KEY NALOPAY_AUTH_HEADER NALOPAY_MERCHANT_ID MNOTIFY_KEY TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET)
HINTS=(
  "NaloPay API key, for creating USSD and mobile-money charges."
  "The full Authorization header value NaloPay expects."
  "Your NaloPay merchant id."
  "mNotify API key. Without it no SMS report is ever sent."
  "Optional. TikTok client key for the tiktok-status job."
  "Optional. TikTok client secret. Skip if you skipped the key."
)

say "Bedtime provider secrets"
note "They go straight to the server and are never stored on this computer."
note "Press Skip on any you do not want to set."

PAYLOAD=""
SET_COUNT=0
for i in 0 1 2 3 4 5; do
  v="$(ask "${NAMES[$i]}" "${HINTS[$i]}")"
  case "$v" in
    __CANCELLED__) echo; no "cancelled. Nothing was sent."; exit 1 ;;
    __ERROR__*)
      no "the dialog could not be shown:"; printf '      %s\n' "${v#__ERROR__}" >&2
      note "If it mentions automation permission, grant it to your terminal in"
      note "System Settings -> Privacy & Security -> Automation, then re-run."
      exit 3 ;;
    __SKIP__|'') note "${NAMES[$i]} skipped"; continue ;;
  esac
  case "$v" in *$'\n'*|*$'\r'*) no "${NAMES[$i]} contains a newline; skipped"; continue ;; esac
  PAYLOAD="${PAYLOAD}${NAMES[$i]}=${v}"$'\n'
  SET_COUNT=$((SET_COUNT+1))
  ok "${NAMES[$i]} accepted (${#v} characters, not shown)"
  unset v
done

if [ "$SET_COUNT" -eq 0 ]; then
  note "nothing to set. No change was made."
  exit 0
fi

say "Writing them to the server"
# The payload arrives on stdin. Each line is applied with sed/append, so no
# value is ever an argument to anything.
printf '%s' "$PAYLOAD" | ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=25 -o LogLevel=ERROR "root@$HOST" "
set -uo pipefail
F=$ENVF
cp -a \"\$F\" \"\$F.bak-\$(date -u +%Y%m%dT%H%M%SZ)\"
n=0
while IFS= read -r line; do
  [ -z \"\$line\" ] && continue
  k=\${line%%=*}
  if grep -q \"^\$k=\" \"\$F\" 2>/dev/null; then
    # Replace in place without the value touching a command line: python reads
    # the key and value from the environment, not from argv.
    K=\"\$k\" V=\"\${line#*=}\" python3 -I -c '
import io,os,sys
p=os.environ[\"F\"]; k=os.environ[\"K\"]; v=os.environ[\"V\"]
out=[]
for l in io.open(p,encoding=\"utf-8\"):
    out.append(f\"{k}={v}\n\" if l.startswith(k+\"=\") else l)
io.open(p,\"w\",encoding=\"utf-8\").writelines(out)
' F=\"\$F\" 2>/dev/null || { printf '%s\n' \"\$line\" >> \"\$F\"; }
  else
    printf '%s\n' \"\$line\" >> \"\$F\"
  fi
  n=\$((n+1))
done
chmod 600 \"\$F\"
echo \"  wrote \$n key(s); file is mode \$(stat -c %a \"\$F\")\"
echo '  keys now present (values never printed):'
grep -oE '^[A-Z_]+=' \"\$F\" | tr -d '=' | sed 's/^/    /'
" 2>&1 | tail -24
unset PAYLOAD

say "Restarting the functions container"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=25 -o LogLevel=ERROR "root@$HOST" \
  'cd /srv/central/apps/bedtime && ./compose.sh up -d functions 2>&1 | tail -2; sleep 6; docker ps --filter name=bedtime-functions --format "  {{.Names}} {{.Status}}"' 2>&1 | tail -4

say "Confirming the functions can see them (names only)"
ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=25 -o LogLevel=ERROR "root@$HOST" \
  'docker exec bedtime-functions env 2>/dev/null | grep -oE "^(NALOPAY|MNOTIFY|TIKTOK)[A-Z_]*=" | tr -d "=" | sort | sed "s/^/  /"' 2>&1 | head -8

say "Done"
note "No payment was created and no SMS was sent by this script."
