#!/usr/bin/env bash
# ===========================================================================
# Collect the one credential that unblocks the Contabo migration, without it
# ever appearing in chat, in a repository, in a log or in `ps`.
#
#   ./migration-package/scripts/enter-contabo-credential.sh
#
# WHY THIS EXISTS
#
# The Bedtime session has no working login on 169.58.120.116. Established, not
# guessed, and recorded in deploy/BEDTIME-SSH-ACCESS.md:
#
#   * port 22 is open
#   * known_hosts holds 3 entries for the IP, so this machine has reached it
#   * ~/.ssh/everytinroom_contabo is REFUSED for root (publickey)
#   * the ssh agent holds no identities
#   * no Contabo API credential is configured anywhere on this machine
#
# One refusal was enough to establish that. Trying more keys against more
# usernames is indistinguishable from credential spraying, and an attempt to
# do exactly that was correctly blocked.
#
# WHAT THIS ASKS FOR
#
# Whichever ONE of these you already have. Either is enough:
#
#   1. The root password for 169.58.120.116, if password login is enabled.
#   2. The full path to a private key file that root accepts -- the real
#      Everytinroom administration key, wherever it actually lives. The path
#      is read; the key itself is never opened, printed or copied.
#
# WHAT IT IS USED FOR, EXACTLY ONCE
#
# Appending the Bedtime public key to root's authorized_keys, so that every
# later step uses Bedtime's own key and this credential is never needed again:
#
#   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEe6NRO3thxOFzhMKuwsqL/Wk5hwp1oi1QTghS3VDPuJ
#   SHA256:FnHsT5PPH24MLlTbvuYFVCgtXBnlu0Q/G/5GvQ1TDZk
#
# APPEND, NEVER REPLACE. authorized_keys carries the access Everytinroom's
# cutover depends on. install-bedtime-key.sh backs the file up first, appends
# idempotently, and counts the keys before and after.
#
# The value is stored base64-encoded in the login Keychain as
# `bedtime-contabo`, because `security -i`'s parser truncates a value holding
# a single quote. It is passed to `security` on stdin, never as an argument.
# ===========================================================================
set -uo pipefail
SERVICE=bedtime-contabo
ACCOUNT="$USER"

say  () { printf '\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This uses the macOS Keychain and a native dialog. Not macOS." >&2
  exit 2
fi

say "Bedtime — Contabo administration credential"
note "169.58.120.116 (Ubuntu 24.04), shared with Everytinroom"
note "Nothing you type is echoed, logged, committed or sent anywhere."
echo

PROMPT="Bedtime needs root access to 169.58.120.116 ONCE, to append its own SSH key.

Enter EITHER:

  • the root password for that server
  • or the full path to a private key root accepts
    (for example /Users/$USER/.ssh/some_key)

It is stored only in your login Keychain. It is never shown, logged or committed, and it is never passed on a command line.

Leave it empty and press Cancel if you would rather append the key yourself from a session that already has access."

set +x
PROMPT_AS="$(printf '%s' "$PROMPT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}')"

ERRFILE="$(mktemp -t bedtime-contabo)"
trap 'rm -f "$ERRFILE"' EXIT

RAW="$(osascript 2>"$ERRFILE" <<APPLESCRIPT
with timeout of 1800 seconds
    tell application "System Events"
        activate
        display dialog "$PROMPT_AS" with title "BEDTIME Contabo access" default answer "" with hidden answer buttons {"Cancel", "Store"} default button "Store" with icon note
    end tell
end timeout
APPLESCRIPT
)"
rc=$?

# A failure to display and a deliberate Cancel are NOT the same thing. An
# earlier version collapsed every non-zero exit into "Cancelled" and wasted
# three rounds saying so.
if [ "$rc" -ne 0 ]; then
  err="$(tr -d '\n' < "$ERRFILE")"
  case "$err" in
    *"User canceled"*|*"user canceled"*|*-128*)
      echo "Cancelled. Nothing was stored."
      echo
      echo "The alternative needs no credential here: from any session that"
      echo "already has root on that server, append this one line to"
      echo "/root/.ssh/authorized_keys -- appending, not replacing:"
      echo
      echo "  ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEe6NRO3thxOFzhMKuwsqL/Wk5hwp1oi1QTghS3VDPuJ bedtime-migration@Isaacs-MacBook-Pro-20261121"
      echo
      exit 1 ;;
    "")
      echo "The dialog returned nothing and reported no error. Nothing stored." >&2
      exit 3 ;;
    *)
      echo "The dialog could not be shown:" >&2
      echo "  $err" >&2
      echo >&2
      echo "If it mentions assistive access or automation permission, grant it" >&2
      echo "to your terminal in System Settings -> Privacy & Security ->" >&2
      echo "Automation, then run this again." >&2
      echo "If it says AppleEvent timed out, the box was open and waiting." >&2
      exit 3 ;;
  esac
fi

VAL="${RAW#*text returned:}"
VAL="${VAL%%, button returned:*}"
unset RAW
VAL="$(printf '%s' "$VAL" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"

if [ -z "$VAL" ]; then
  echo "Nothing was entered. Nothing was stored."
  exit 1
fi

# Classify by shape, printing no part of the value.
KIND=password
case "$VAL" in
  /*|~*)
    EXP="${VAL/#\~/$HOME}"
    if [ -f "$EXP" ]; then
      KIND=keyfile
      perm="$(stat -f '%Lp' "$EXP" 2>/dev/null || echo '?')"
      if [ "$perm" != "600" ] && [ "$perm" != "400" ]; then
        no "that key file is mode $perm; ssh will refuse it"
        note "it needs to be 600. Nothing was stored."
        exit 1
      fi
      if ! ssh-keygen -y -f "$EXP" >/dev/null 2>&1; then
        no "that file is not a usable private key, or it is passphrase-locked"
        note "Nothing was stored."
        exit 1
      fi
      ok "key file read and valid: $(ssh-keygen -lf "$EXP" 2>/dev/null | awk '{print $1, $2}')"
    else
      no "that path does not exist"
      note "Nothing was stored."
      exit 1
    fi ;;
  *"BEGIN OPENSSH PRIVATE KEY"*|*"BEGIN RSA PRIVATE KEY"*)
    no "that looks like the key's CONTENTS, not a path."
    note "A single-line box cannot carry a multi-line key intact."
    note "Save it to a file, chmod 600 it, and give the path instead."
    note "Nothing was stored."
    exit 1 ;;
esac

if [ "$KIND" = password ]; then
  if [ "${#VAL}" -lt 6 ]; then
    no "that is ${#VAL} characters; too short to be the root password"
    note "Nothing was stored."
    exit 1
  fi
  ok "password accepted (${#VAL} characters, not shown)"
fi

# Store KIND and value together so the consumer knows how to use it, base64'd
# and on stdin so it never reaches argv.
PAYLOAD="$(printf '%s\n%s' "$KIND" "$VAL" | base64)"
unset VAL
if printf 'add-generic-password -a %s -s %s -w %s -U\n' "$ACCOUNT" "$SERVICE" "$PAYLOAD" | security -i >/dev/null 2>&1; then
  ok "stored in the login Keychain as '$SERVICE'"
else
  no "the Keychain refused to store it"
  exit 4
fi
unset PAYLOAD

echo
say "Next"
note "install-bedtime-key.sh will use this once to append Bedtime's public key,"
note "then every later step uses ~/.ssh/bedtime_contabo and this is not needed."
note "Delete it any time:"
note "  security delete-generic-password -a \"\$USER\" -s $SERVICE"
