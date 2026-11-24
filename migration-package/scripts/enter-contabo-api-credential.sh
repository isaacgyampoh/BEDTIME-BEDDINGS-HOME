#!/usr/bin/env bash
# ===========================================================================
# Collect the four Contabo API credentials, privately, into the Keychain.
#
#   ./migration-package/scripts/enter-contabo-api-credential.sh
#
# Contabo's API is OAuth2. Getting a token needs FOUR values, all from the
# Customer Control Panel, and none of them is your control-panel login:
#
#   1. Client Id       e.g. INT-12345678
#   2. Client Secret   a long random string
#   3. API User        an e-mail address
#   4. API Password    the API password you set, NOT the panel password
#
# Where to find them: my.contabo.com -> (your name, top right) -> Account ->
# API. If no API user exists yet, that page creates one and is where you set
# the API password.
#
# Each value is asked for in its own hidden dialog. Nothing is echoed to the
# terminal, written to a file, committed, or passed on a command line where
# another user could read it out of `ps`. All four are stored together as one
# base64'd JSON object in the login Keychain under `bedtime-contabo-api`, fed
# to `security` on stdin.
#
# Remove them whenever you like:
#   security delete-generic-password -a "$USER" -s bedtime-contabo-api
# ===========================================================================
set -uo pipefail
SERVICE=bedtime-contabo-api
ACCOUNT="$USER"

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

[ "$(uname -s)" = Darwin ] || { echo "macOS only (Keychain + native dialog)." >&2; exit 2; }

say "Contabo API credentials"
note "my.contabo.com -> your name (top right) -> Account -> API"
note "Four values. Each in its own hidden box. Nothing is echoed or logged."

ask () {   # ask <label> <hint>  -> prints the value on stdout
  local label="$1" hint="$2" prompt raw rc err
  prompt="$label

$hint

Nothing you type is shown, logged or committed."
  local as
  as="$(printf '%s' "$prompt" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}')"
  local ef; ef="$(mktemp -t contabo-api)"
  raw="$(osascript 2>"$ef" <<APPLESCRIPT
with timeout of 1800 seconds
    tell application "System Events"
        activate
        display dialog "$as" with title "Contabo API — $label" default answer "" with hidden answer buttons {"Cancel", "Next"} default button "Next" with icon note
    end tell
end timeout
APPLESCRIPT
)"
  rc=$?
  err="$(tr -d '\n' < "$ef")"; rm -f "$ef"
  if [ "$rc" -ne 0 ]; then
    case "$err" in
      *"User canceled"*|*"user canceled"*|*-128*) printf '__CANCELLED__' ;;
      *) printf '__ERROR__%s' "$err" ;;
    esac
    return
  fi
  raw="${raw#*text returned:}"; raw="${raw%%, button returned:*}"
  printf '%s' "$raw" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'
}

declare -a VALUES=()
LABELS=("Client Id" "Client Secret" "API User" "API Password")
HINTS=(
  "Looks like INT-12345678 or similar."
  "A long random string shown beside the Client Id."
  "The API user's e-mail address — not your login e-mail unless they match."
  "The API password you set on that page. NOT your control-panel password."
)

# Each field is validated as it is entered and retried in place, so one
# mistyped or double-pasted value does not throw away the other three. A
# duplicate paste is the likely slip here: the Client Secret and the API User
# sit next to each other on Contabo's page.
validate () {   # validate <index> <value> -> prints a complaint, or nothing
  case "$1" in
    0) case "$2" in *[!A-Za-z0-9_-]*) echo "that contains characters a Client Id does not have" ;; esac
       [ "${#2}" -lt 6 ] && echo "that is only ${#2} characters; a Client Id is longer" ;;
    1) [ "${#2}" -lt 20 ] && echo "that is only ${#2} characters; a Client Secret is much longer" ;;
    2) case "$2" in
         *@*.*) : ;;
         *) echo "an API User is an e-mail address, and that has no @ in it${EXTRA:-}" ;;
       esac ;;
    3) [ "${#2}" -lt 6 ] && echo "that is only ${#2} characters; too short for the API password" ;;
  esac
}

for i in 0 1 2 3; do
  attempt=0
  while : ; do
    attempt=$((attempt+1))
    v="$(ask "${LABELS[$i]}" "${HINTS[$i]}")"
    case "$v" in
      __CANCELLED__) echo; echo "Cancelled. Nothing was stored."; exit 1 ;;
      __ERROR__*)
        no "the dialog could not be shown:"
        printf '      %s\n' "${v#__ERROR__}" >&2
        note "If it mentions automation permission, grant it to your terminal in"
        note "System Settings -> Privacy & Security -> Automation, then re-run."
        exit 3 ;;
      '') complaint="nothing was entered" ;;
      *)
        EXTRA=""
        # Name the most likely cause rather than just rejecting it.
        if [ "$i" = 2 ] && [ "${#VALUES[1]}" -gt 0 ] && [ "$v" = "${VALUES[1]}" ]; then
          EXTRA=" -- that is the same value as the Client Secret, so the paste probably repeated"
        fi
        complaint="$(validate "$i" "$v")" ;;
    esac
    if [ -z "$complaint" ]; then
      VALUES+=("$v")
      ok "${LABELS[$i]} accepted (${#v} characters, not shown)"
      break
    fi
    no "${LABELS[$i]}: $complaint"
    if [ "$attempt" -ge 3 ]; then
      no "three attempts at ${LABELS[$i]}. Nothing was stored."
      exit 1
    fi
    note "asking again -- the other values you have entered are kept"
  done
done

PAYLOAD="$(python3 - "${VALUES[0]}" "${VALUES[1]}" "${VALUES[2]}" "${VALUES[3]}" <<'PY'
import json,sys,base64
d={"client_id":sys.argv[1],"client_secret":sys.argv[2],"user":sys.argv[3],"password":sys.argv[4]}
sys.stdout.write(base64.b64encode(json.dumps(d).encode()).decode())
PY
)"
unset VALUES

if printf 'add-generic-password -a %s -s %s -w %s -U\n' "$ACCOUNT" "$SERVICE" "$PAYLOAD" | security -i >/dev/null 2>&1; then
  ok "all four stored in the login Keychain as '$SERVICE'"
else
  no "the Keychain refused to store them"; exit 4
fi
unset PAYLOAD

say "Next"
note "contabo-api.sh survey   — read-only: account, instances, SSH key secrets"
note "Nothing is changed on any server by that command."
