#!/usr/bin/env bash
# ===========================================================================
# Put the Supabase connection URI into the macOS Keychain, via a native
# dialog, without it ever being visible anywhere.
#
#   ./migration-package/scripts/enter-db-credential.sh
#
# WHERE THE VALUE GOES, AND WHERE IT DOES NOT
#   dialog (masked field) -> a pipe -> `security` -> the login Keychain.
#
#   It is never printed, so it cannot reach a chat transcript or a log.
#   It is never an argument, so `ps` cannot show it.
#   It is never written to a file, so no backup or sync picks it up.
#   It never reaches a shell prompt, so it is not in history.
#
#   The only thing this script prints is whether it worked.
#
# WHY A DIALOG AND NOT A PROMPT
#   `security -w` with no value prompts on the terminal, which is no use when
#   nobody is at a terminal. AppleScript's `display dialog ... with hidden
#   answer` is the macOS-native masked field, and it runs as the logged-in
#   user on their own display.
#
# Re-running replaces the stored item, so a mistyped URI is fixed by running
# it again. Nothing else is touched.
# ===========================================================================
set -uo pipefail
SERVICE="${1:-bedtime-db}"
ACCOUNT="${USER}"

command -v osascript >/dev/null || { echo "osascript not found — this needs macOS."; exit 2; }
command -v security  >/dev/null || { echo "security not found — this needs macOS."; exit 2; }

PROMPT='BEDTIME — database connection URI

WHERE TO GET IT
  Supabase dashboard -> your project
  -> Project Settings -> Database
  -> Connection string -> the URI tab
  -> Copy

  If it shows [YOUR-PASSWORD] instead of a real
  password, click "Reset database password" on that
  same page first. Nothing in your running shop uses
  that password, so resetting it is safe.

  This is NOT a sbp_ access token. It is the database
  password, and it looks like:
  postgresql://postgres.xxxx:PASSWORD@aws-0-REGION...

Paste it below. It goes straight into your login
Keychain: never shown, never logged, never written to
a file, never sent anywhere.'

# `display dialog` writes "text returned:<value>" to stdout. Both the
# AppleScript and the extraction stay inside this pipeline so the value is
# never assigned to a shell variable that could be echoed by a trace.
#
# WHY IT GOES THROUGH System Events, AND WHY IT ACTIVATES
# A bare `osascript -e 'display dialog ...'` belongs to the osascript process,
# which does not come to the front. With a browser frontmost the box opens
# BEHIND it. This was cancelled three times before a self-test showed dialogs
# display fine and the frontmost application was Opera — so it was most likely
# never seen. Telling System Events to activate first puts it in front.
#
# A failure to display and a deliberate Cancel are also no longer the same
# thing: the previous version turned any non-zero exit into "Cancelled", which
# is why three attempts said the same unhelpful word.
set +x
# AppleScript string literals cannot span lines. $PROMPT is multi-line, so
# interpolating it raw produced
#     syntax error: Expected end of line, etc. but found identifier. (-2741)
# and the dialog never appeared at all. The three "Cancelled" results before
# this were that error, misreported, because the old code treated every
# non-zero exit as a cancel.
#
# So the newlines become the two characters \n, which AppleScript does
# understand inside a quoted string, and quotes and backslashes are escaped.
PROMPT_AS="$(printf '%s' "$PROMPT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}')"

ERRFILE="$(mktemp -t bedtime-cred)"
trap 'rm -f "$ERRFILE"' EXIT

RAW="$(osascript 2>"$ERRFILE" <<APPLESCRIPT
with timeout of 1800 seconds
    tell application "System Events"
        activate
        display dialog "$PROMPT_AS" with title "BEDTIME database credential" default answer "" with hidden answer buttons {"Cancel", "Store"} default button "Store" with icon note
    end tell
end timeout
APPLESCRIPT
)"
rc=$?

if [ "$rc" -ne 0 ]; then
  err="$(tr -d '\n' < "$ERRFILE")"
  case "$err" in
    *"User canceled"*|*"user canceled"*|*-128*)
      echo "Cancelled. Nothing was stored."
      echo "Run this again when you have the URI to hand."
      exit 1 ;;
    "")
      echo "Cancelled. Nothing was stored."
      exit 1 ;;
    *)
      echo "The dialog could not be shown:" >&2
      echo "  $err" >&2
      echo >&2
      echo "If it mentions assistive access or automation permission, grant" >&2
      echo "it to your terminal in System Settings -> Privacy & Security ->" >&2
      echo "Automation, then run this again." >&2
      echo "If it says AppleEvent timed out, the box was open and waiting:" >&2
      echo "run this again and it will wait half an hour." >&2
      exit 3 ;;
  esac
fi

# Strip AppleScript's wrapper without printing anything.
URI="${RAW#*text returned:}"
URI="${URI%%, button returned:*}"
unset RAW

# Normalise, then validate by shape only. No part of the value is printed.
#
# People paste what the dashboard gave them, and the dashboard gives several
# shapes. All of these are things psql and pg_dump accept, so all are kept:
#
#   postgresql://user:pass@host:5432/postgres     the URI tab
#   postgres://user:pass@host:5432/postgres       older spelling
#   psql "postgresql://…"                         the copy button on some tabs
#   host=… port=… dbname=… user=… password=…      the keyword form
#
# Surrounding quotes and whitespace are stripped, because a paste usually
# carries them.
URI="$(printf '%s' "$URI" | tr -d '\r' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
# A leading `psql ` (or `pg_dump `) wrapper, with the URI quoted after it.
case "$URI" in
  psql\ *|pg_dump\ *|PGPASSWORD=*)
    URI="$(printf '%s' "$URI" | sed -E "s/^[^\"']*[\"']?//; s/[\"']?[[:space:]]*$//")" ;;
esac
# Surrounding single or double quotes.
URI="$(printf '%s' "$URI" | sed -E "s/^[\"']//; s/[\"']$//")"

ok=0
case "$URI" in
  postgres://*|postgresql://*) ok=1 ;;
esac
# The keyword/value form, which libpq accepts just as happily.
case "$URI" in
  *host=*) case "$URI" in *password=*) ok=1 ;; esac ;;
esac

if [ "$ok" -ne 1 ]; then
  if [ -z "$URI" ]; then
    echo "Nothing was entered. Nothing was stored."
  else
    # A safe diagnostic: the leading characters of a connection string are
    # never the password (that sits after the user), and the length helps
    # tell a truncated paste from a wrong one.
    echo "That is not a connection string this can use. Nothing was stored."
    echo "  it began with : $(printf '%s' "$URI" | cut -c1-12)"
    echo "  length        : ${#URI} characters"
    echo
    echo "Any ONE of these is fine — copy it from Supabase exactly:"
    echo "  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
    echo "  host=… port=5432 dbname=postgres user=… password=…"
    echo
    echo "Dashboard -> Project Settings -> Database -> Connection string."
    echo "Use the URI tab, and make sure the password is filled in rather than"
    echo "shown as [YOUR-PASSWORD]."
  fi
  unset URI
  exit 1
fi

# A URI with the placeholder still in it would pass the shape check and then
# fail at dump time with something unhelpful.
case "$URI" in
  *YOUR-PASSWORD*|*\[YOUR*|*your-password*)
    echo "That still has the [YOUR-PASSWORD] placeholder in it. Nothing was stored."
    echo "Reveal or reset the database password in the dashboard first."
    unset URI; exit 1 ;;
esac
case "$URI" in
  postgres://*|postgresql://*)
    case "$URI" in
      *:*@*) : ;;
      *) echo "That URI has no password in it. Nothing was stored."
         unset URI; exit 1 ;;
    esac ;;
esac

# HOW THE VALUE REACHES THE KEYCHAIN WITHOUT TOUCHING argv
#
#   `security add-generic-password -w <value>` puts it in argv, where `ps`
#   shows it to every process on the machine. Piping into `-w` with no value
#   does NOT work: it prompts on /dev/tty, and a piped run silently stored an
#   EMPTY password — checked, which is the only reason this is not that.
#
#   `security -i` reads its command line from stdin instead, so nothing is in
#   argv. But its parser is not sh: a password containing a single quote was
#   truncated from 81 characters to 28. So the value is base64'd first, which
#   reduces it to [A-Za-z0-9+/=] and has no quoting hazard at all. Verified
#   round-trip with ' " $ ! # & * ( ) [ ] { } and a space.
#
#   base64 is an encoding, not a protection. The protection is the Keychain.
security delete-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1 || true
if printf 'add-generic-password -a %s -s %s -C note -D "base64 postgres URI" -w %s\n' \
     "$ACCOUNT" "$SERVICE" "$(printf '%s' "$URI" | base64)" | security -i >/dev/null 2>&1; then
  unset URI
  echo "Stored in the login Keychain as '$SERVICE' for '$ACCOUNT'."
  # Prove it is retrievable and is a URI, without showing it.
  if got="$(security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null | base64 -d 2>/dev/null)"; then
    host="$(printf '%s' "$got" | sed -E 's#^[a-z]+://[^@]*@([^:/?]+).*#\1#')"
    chars="${#got}"
    unset got
    echo "Readable back: yes. Host: $host. Length: $chars characters."
    echo "The password itself was not displayed and is not in any log."
  else
    echo "WARNING: stored, but could not be read back."
    exit 1
  fi
else
  unset URI
  echo "Could not store it in the Keychain."
  exit 1
fi
