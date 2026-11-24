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

ALL_NAMES=(NALOPAY_API_KEY NALOPAY_AUTH_HEADER NALOPAY_MERCHANT_ID MNOTIFY_KEY TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET)
ALL_HINTS=(
  "NaloPay API key, for creating USSD and mobile-money charges."
  "The full Authorization header value NaloPay expects."
  "Your NaloPay merchant id."
  "mNotify API key, for sending the SMS reports to 0548124978.

WHAT IS STORED NOW IS WRONG: it is byte-for-byte your NaloPay MERCHANT ID (same SHA-256), and mNotify answers \"invalid api key\" to it. The wrong value was almost certainly pasted into this box.

Get the right one from mnotify.com -> your account -> API Key / Developer, and paste the whole string."
  "Optional. TikTok client key for the tiktok-status job."
  "Optional. TikTok client secret. Skip if you skipped the key."
)

# Ask only for the keys named on the command line, so a single wrong value
# does not mean retyping the ones that are already verified correct.
#   enter-provider-secrets.sh MNOTIFY_KEY
NAMES=(); HINTS=()
if [ "$#" -gt 0 ]; then
  for req in "$@"; do
    hit=0
    for i in 0 1 2 3 4 5; do
      if [ "${ALL_NAMES[$i]}" = "$req" ]; then NAMES+=("$req"); HINTS+=("${ALL_HINTS[$i]}"); hit=1; break; fi
    done
    [ "$hit" = 1 ] || { no "unknown key '$req'"; note "one of: ${ALL_NAMES[*]}"; exit 2; }
  done
else
  NAMES=("${ALL_NAMES[@]}"); HINTS=("${ALL_HINTS[@]}")
fi

say "Bedtime provider secrets"
note "They go straight to the server and are never stored on this computer."
note "Press Skip on any you do not want to set."

PAYLOAD=""
SET_COUNT=0
for i in "${!NAMES[@]}"; do
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
# The whole payload goes to one python run, which rewrites the file in place:
# every key is replaced where it already appears and appended only if absent,
# and any DUPLICATE assignment of the same key is collapsed to one.
#
# An earlier version ran python per line and passed F as an ARGUMENT rather
# than in the environment, so python raised KeyError('F'), the shell fallback
# appended instead of replacing, and MNOTIFY_KEY ended up in the file twice.
PAYLOAD=\"\$(cat)\" F=\"\$F\" python3 -I -c '
import io, os
p = os.environ[\"F\"]
new = {}
order = []
for line in os.environ[\"PAYLOAD\"].splitlines():
    if not line or \"=\" not in line:
        continue
    k, _, v = line.partition(\"=\")
    if k not in new:
        order.append(k)
    new[k] = v
out = []
seen = set()
for line in io.open(p, encoding=\"utf-8\"):
    k = line.split(\"=\", 1)[0] if \"=\" in line else None
    if k in new:
        if k in seen:
            continue            # drop a duplicate of a key we already wrote
        out.append(k + \"=\" + new[k] + \"\\n\")
        seen.add(k)
    else:
        out.append(line)
for k in order:
    if k not in seen:
        out.append(k + \"=\" + new[k] + \"\\n\")
        seen.add(k)
io.open(p, \"w\", encoding=\"utf-8\").writelines(out)
print(\"  wrote \" + str(len(new)) + \" key(s), duplicates collapsed\")
'
chmod 600 \"\$F\"
echo \"  file is mode \$(stat -c %a \"\$F\")\"
echo '  keys now present (values never printed):'
grep -oE '^[A-Z_]+=' \"\$F\" | tr -d '=' | sort | uniq -c | sed 's/^/    /'
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
