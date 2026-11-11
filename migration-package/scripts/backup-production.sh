#!/usr/bin/env bash
# ===========================================================================
# A COMPLETE, PRIVILEGED BACKUP of Bedtime's production database.
#
# Five tables refuse the public key — staff, pin_attempts, sms_log,
# sms_exempt_numbers, social_connections — which is RLS doing its job. No
# amount of API work gets around that, and it should not: `staff` holds the
# PIN hashes. A complete copy needs a privileged connection, which means
# pg_dump, which means one credential.
#
# WHAT THIS ESTABLISHED
#   The Supabase connection pooler IS reachable from this machine:
#     aws-0-<region>.pooler.supabase.com:5432   TCP open, TLS up, speaks
#     Postgres (it answers "tenant/user not found" for a wrong tenant)
#   and pg_dump 18.6 is installed. So the only thing missing is the
#   connection string.
#
# HOW TO SUPPLY IT WITHOUT PASTING IT ANYWHERE
#   Supabase dashboard -> Project Settings -> Database -> Connection string ->
#   URI. Copy that one line. Then, in Terminal:
#
#     mkdir -p ~/.bedtime && umask 077
#     pbpaste > ~/.bedtime/db.url          # straight from the clipboard
#     chmod 600 ~/.bedtime/db.url
#
#   Nothing is typed, nothing is echoed, and it never enters a chat window or
#   a shell history. Alternatively use the macOS Keychain:
#
#     security add-generic-password -a "$USER" -s bedtime-db -w   # prompts
#
#   This script reads the Keychain first, then the file.
#
# WHY NOT ON THE COMMAND LINE
#   Anything in argv is visible to every other process on the machine via
#   `ps`. The URL is never passed as an argument and never printed; the
#   password is handed to pg_dump through PGPASSWORD in its own environment.
#
# SAFETY
#   Read-only. pg_dump issues no writes. It is safe to run against production
#   while the shop is trading; --no-owner --no-acl keeps the dump restorable
#   as any role.
#
#   Rerunnable: each run writes a new timestamped file and never overwrites.
# ===========================================================================
set -uo pipefail
umask 077

OUT_DIR="${BEDTIME_BACKUP_DIR:-$HOME/.bedtime/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"

say () { printf '\033[1m%s\033[0m\n' "$*"; }
# Every error path goes through this, so a connection string can never reach
# the terminal or a log file even in a failure message.
redact () { sed -E 's#postgres(ql)?://[^[:space:]]*#postgresql://***REDACTED***#g'; }

# ── 1. find the credential ────────────────────────────────────────────────
DB_URL=""
if command -v security >/dev/null 2>&1; then
  # enter-db-credential.sh stores it base64'd, because `security -i`'s parser
  # truncates a value containing a single quote (81 chars became 28 when
  # tested). Decode if it decodes to a URI; otherwise treat it as plain text,
  # for an item somebody stored by hand.
  raw="$(security find-generic-password -a "$USER" -s bedtime-db -w 2>/dev/null || true)"
  if [ -n "$raw" ]; then
    decoded="$(printf '%s' "$raw" | base64 -d 2>/dev/null || true)"
    case "$decoded" in
      postgres://*|postgresql://*) DB_URL="$decoded" ;;
      *)                           DB_URL="$raw" ;;
    esac
    unset raw decoded
    say "Using the connection string from the macOS Keychain (bedtime-db)."
  fi
fi
if [ -z "$DB_URL" ] && [ -f "$HOME/.bedtime/db.url" ]; then
  perm="$(stat -f '%Lp' "$HOME/.bedtime/db.url" 2>/dev/null || stat -c '%a' "$HOME/.bedtime/db.url")"
  if [ "$perm" != "600" ]; then
    echo "REFUSING: ~/.bedtime/db.url is mode $perm. Run: chmod 600 ~/.bedtime/db.url" >&2
    exit 2
  fi
  DB_URL="$(tr -d '\r\n' < "$HOME/.bedtime/db.url")"
  say "Using the connection string from ~/.bedtime/db.url (mode 600)."
fi
if [ -z "$DB_URL" ]; then
  cat >&2 <<'MSG'
No connection string found. Supply it by ONE of these, then run this again:

  Keychain (prompts, nothing echoed):
    security add-generic-password -a "$USER" -s bedtime-db -w

  File (straight from the clipboard, never typed):
    mkdir -p ~/.bedtime && umask 077
    pbpaste > ~/.bedtime/db.url && chmod 600 ~/.bedtime/db.url

Get the URI from: Supabase dashboard -> Project Settings -> Database ->
Connection string -> URI. Do not paste it into a chat.
MSG
  exit 2
fi

case "$DB_URL" in
  postgres://*|postgresql://*) : ;;
  *) echo "REFUSING: that does not look like a postgres:// URI." >&2; exit 2 ;;
esac

# ── 2. prove the connection before spending time on a dump ────────────────
say "Checking the connection (read-only)"
if ! server_version="$(psql "$DB_URL" -At -v ON_ERROR_STOP=1 \
      -c "select current_database()||' on '||split_part(version(),' ',2)" 2>&1)"; then
  echo "Could not connect:" >&2
  printf '%s\n' "$server_version" | redact >&2
  exit 1
fi
echo "  connected: $server_version"
echo "  rows visible to this role:"
psql "$DB_URL" -At -v ON_ERROR_STOP=1 -c "
  select '    '||rpad(relname, 24)||to_char(n_live_tup, '999999')
    from pg_stat_user_tables
   where schemaname='public' and n_live_tup > 0
   order by n_live_tup desc limit 12;" 2>/dev/null || true

# ── 3. the dump ───────────────────────────────────────────────────────────
DUMP="$OUT_DIR/bedtime-$STAMP.dump"
say "Dumping to $DUMP"
# -Fc    custom format: compressed, and restorable selectively
# --no-owner --no-acl   so it restores as whatever role the new server uses
# -N for Supabase-managed schemas we neither own nor need: recreating them on
#    a self-hosted stack is the platform's job, not this dump's.
if ! pg_dump "$DB_URL" -Fc --no-owner --no-acl --quote-all-identifiers \
      -N 'pgbouncer' -N 'graphql*' -N 'pgsodium*' -N 'vault' -N 'supabase_functions' \
      -N '_realtime' -N 'realtime' -N 'net' -N 'cron' \
      -f "$DUMP" 2> >(redact >&2); then
  echo "pg_dump failed. Nothing was written to production." >&2
  rm -f "$DUMP"
  exit 1
fi
chmod 600 "$DUMP"
echo "  wrote $(du -h "$DUMP" | cut -f1)"

# ── 4. what the dump actually contains ────────────────────────────────────
say "What is in it"
pg_restore -l "$DUMP" | awk '
  # TABLE DATA <schema> <name> <owner> — the name is the second-to-last field.
  /TABLE DATA/ { n = split($0, a, " "); print "    " a[n-2] "." a[n-1] }
' | sort | head -30
echo "    ---"
printf '    %s\n' \
  "tables:    $(pg_restore -l "$DUMP" | grep -c 'TABLE DATA' || true)" \
  "functions: $(pg_restore -l "$DUMP" | grep -c 'FUNCTION' || true)" \
  "indexes:   $(pg_restore -l "$DUMP" | grep -c 'INDEX' || true)" \
  "policies:  $(pg_restore -l "$DUMP" | grep -c 'POLICY' || true)" \
  "triggers:  $(pg_restore -l "$DUMP" | grep -c 'TRIGGER' || true)"

# ── 5. the five tables that were the whole point ──────────────────────────
say "The tables the public key could not read"
for t in staff pin_attempts sms_log sms_exempt_numbers social_connections; do
  # `pg_restore -l` writes "TABLE DATA <schema> <name> <owner>", so the table
  # name is NOT at end of line — the owner is. Anchoring on $ reported every
  # protected table as missing from a dump that held all five.
  # A table with no rows has a TABLE entry and no TABLE DATA entry, so accept
  # either: empty is present, not missing.
  if pg_restore -l "$DUMP" | grep -qE "TABLE( DATA)? [A-Za-z_][A-Za-z0-9_]* $t "; then
    rows=$(pg_restore -l "$DUMP" | grep -cE "TABLE DATA [A-Za-z_][A-Za-z0-9_]* $t ")
    if [ "$rows" -gt 0 ]; then echo "    $t: PRESENT with data"
    else echo "    $t: PRESENT (no rows)"; fi
  else
    echo "    $t: MISSING — the dump is not complete"
  fi
done

say "Done"
cat <<MSG
  $DUMP  (mode 600)

Next, and it does not touch production:
  migration-package/scripts/restore-and-reconcile.sh "$DUMP"

Keep this file off shared drives and out of git. It contains every customer
record and the staff PIN hashes. .gitignore already excludes ~/.bedtime.
MSG
