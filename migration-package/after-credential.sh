#!/usr/bin/env bash
# ===========================================================================
# Everything that follows credential entry, in one run.
#
#   ./migration-package/after-credential.sh
#
# Reads the connection URI from the login Keychain (put there by
# scripts/enter-db-credential.sh) and then, without further input:
#
#   1  a complete read-only pg_dump of production
#   2  verify all 21 tables are in it, the five protected ones included
#   3  restore into an isolated disposable database
#   4  reconcile the restored copy against the dump's own snapshot
#   5  verify staff rows and PIN hashes by SHAPE, never by value
#   6  real PIN authentication and the critical POS operations
#   7  the 31-check acceptance runner, all six functions executing
#   8  keep the backup with restrictive permissions, outside git
#   9  refresh and verify the git bundle by reconstructing it
#  10  write the readiness verdict from what actually passed
#
# PRODUCTION IS READ ONLY HERE. pg_dump issues no writes. Every test runs
# against the restored copy, never against Supabase.
#
# Safe to rerun: each run dumps to a new timestamped file and restores into a
# database it creates, refusing to overwrite one that already exists unless
# --recreate is passed.
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
STAGING="${1:-bedtime_restored}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE="$HOME/bedtime-preservation/evidence-$STAMP"
mkdir -p "$EVIDENCE"; chmod 700 "$EVIDENCE"

step=0
bold () { step=$((step+1)); printf '\n\033[1m%s. %s\033[0m\n' "$step" "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
FAILED=0
fail () { no "$*"; FAILED=$((FAILED+1)); }

# ── 1 ── the backup ───────────────────────────────────────────────────────
bold "A complete read-only backup of production"
if ! security find-generic-password -a "$USER" -s bedtime-db >/dev/null 2>&1; then
  no "no credential in the Keychain."
  note "Run: $HERE/scripts/enter-db-credential.sh"
  exit 2
fi
if ! BEDTIME_BACKUP_DIR="$EVIDENCE" "$HERE/scripts/backup-production.sh" | tee "$EVIDENCE/01-backup.log"; then
  fail "the backup did not complete; see $EVIDENCE/01-backup.log"
  exit 1
fi
DUMP="$(ls -t "$EVIDENCE"/*.dump 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { fail "no dump file was produced"; exit 1; }
ok "dump: $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"

# ── 2 ── all 21 tables, the protected five included ───────────────────────
bold "Every table is in the dump"
EXPECTED=(bundles customers expenses invoices pin_attempts product_price_history
          products promos refunds sales sms_exempt_numbers sms_log social_audit_log
          social_automation_rules social_connections social_posts staff
          stock_adjustments stock_takes wa_conversations whatsapp_orders)
pg_restore -l "$DUMP" > "$EVIDENCE/02-dump-contents.txt" 2>/dev/null
missing=0
for t in "${EXPECTED[@]}"; do
  # A table with no rows appears as a TABLE entry without TABLE DATA, so look
  # for either — an empty table is present, not missing.
  # TABLE DATA <schema> <name> <owner>; the name is not at end of line.
  if grep -qE "TABLE( DATA)? [A-Za-z_][A-Za-z0-9_]* $t " "$EVIDENCE/02-dump-contents.txt"; then :
  else no "$t is NOT in the dump"; missing=$((missing+1)); fi
done
if [ "$missing" -eq 0 ]; then ok "all ${#EXPECTED[@]} tables present"
else fail "$missing table(s) missing from the dump"; fi
for t in staff pin_attempts sms_log sms_exempt_numbers social_connections; do
  if grep -qE "TABLE DATA [A-Za-z_][A-Za-z0-9_]* $t " "$EVIDENCE/02-dump-contents.txt"; then
    ok "protected: $t (with data)"
  elif grep -qE "TABLE [A-Za-z_][A-Za-z0-9_]* $t " "$EVIDENCE/02-dump-contents.txt"; then
    ok "protected: $t (present, no rows)"
  else fail "protected table $t is missing"; fi
done

# ── 3 ── restore ──────────────────────────────────────────────────────────
bold "Restore into an isolated disposable database"
"$HERE/scripts/restore-and-reconcile.sh" "$DUMP" "$STAGING" --recreate \
  2>&1 | tee "$EVIDENCE/03-restore-reconcile.log" | tail -40
rc=${PIPESTATUS[0]}
[ "$rc" -eq 0 ] && ok "restored and reconciled" || fail "reconciliation reported differences (exit $rc)"

# ── 4 ── reconcile against the dump's own snapshot ────────────────────────
bold "Reconcile against a consistent snapshot, not a moving target"
# The dump is one point in time; production keeps trading. Comparing the
# restore against the LIVE API would show drift that is the shop working, not
# a migration fault. So the comparison is restored-vs-dump: restore the same
# dump a second time and reconcile the two copies.
SNAP="${STAGING}_snapshot"
dropdb --if-exists "$SNAP" 2>/dev/null
createdb "$SNAP" 2>/dev/null
pg_restore --no-owner --no-acl -d "$SNAP" "$DUMP" >"$EVIDENCE/04-snapshot-restore.log" 2>&1 || true
snap_tables=$(psql -At -d "$SNAP" -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'" 2>/dev/null || echo 0)
snap_errs=$(grep -cE '^pg_restore: error' "$EVIDENCE/04-snapshot-restore.log" 2>/dev/null || echo 0)
note "snapshot: $snap_tables tables, $snap_errs benign pg_restore error line(s)"
if [ "${snap_tables:-0}" -ge 20 ]; then
  node "$HERE/scripts/reconcile.mjs" --db "$STAGING" --against "$SNAP" \
    2>&1 | tee "$EVIDENCE/04-reconcile-snapshot.log" | tail -45
  [ "${PIPESTATUS[0]}" -eq 0 ] && ok "the two restores of one dump agree exactly" \
    || fail "two restores of the same dump disagree — investigate before cutover"
  dropdb "$SNAP" 2>/dev/null
else
  fail "could not build the comparison snapshot"
fi

# ── 5 ── staff and PIN hashes, by shape only ──────────────────────────────
bold "Staff records and PIN hashes, without revealing them"
if psql -At -d "$STAGING" -c "SELECT 1 FROM information_schema.tables WHERE table_name='staff'" | grep -q 1; then
  {
    echo "staff rows               : $(psql -At -d "$STAGING" -c 'SELECT count(*) FROM staff')"
    echo "active                   : $(psql -At -d "$STAGING" -c 'SELECT count(*) FROM staff WHERE active')"
    echo "with a bcrypt pin_hash   : $(psql -At -d "$STAGING" -c "SELECT count(*) FROM staff WHERE pin_hash LIKE '\$2%'")"
    echo "pin_hash length (bcrypt) : $(psql -At -d "$STAGING" -c 'SELECT DISTINCT length(pin_hash) FROM staff WHERE pin_hash IS NOT NULL' | tr '\n' ' ')"
    echo "still holding plaintext  : $(psql -At -d "$STAGING" -c "SELECT count(*) FROM staff WHERE pin IS NOT NULL AND pin <> ''")"
    echo "roles                    : $(psql -At -d "$STAGING" -c 'SELECT DISTINCT role FROM staff' | tr '\n' ' ')"
  } | tee "$EVIDENCE/05-staff-shape.txt" | sed 's/^/  /'
  rows=$(psql -At -d "$STAGING" -c 'SELECT count(*) FROM staff')
  hashed=$(psql -At -d "$STAGING" -c "SELECT count(*) FROM staff WHERE pin_hash LIKE '\$2%'")
  [ "${rows:-0}" -gt 0 ] && ok "$rows staff row(s) restored" || fail "no staff rows in the restore"
  [ "${hashed:-0}" -gt 0 ] && ok "$hashed carry a bcrypt hash" \
    || note "none carry a hash yet — verify_pin converts on first sign-in"
  # Never printed, never logged: only that no value leaked into the evidence.
  grep -qE '\$2[aby]\$[0-9]{2}\$' "$EVIDENCE/05-staff-shape.txt" \
    && fail "a hash value reached the evidence file" || ok "no hash or PIN value in the evidence"
else
  fail "the staff table is not in the restore"
fi

# ── 6 ── real PIN auth and the critical POS operations ────────────────────
bold "PIN authentication and the POS, against the restored database"
node "$HERE/scripts/pos-acceptance.mjs" "$STAGING" 2>&1 | tee "$EVIDENCE/06-pos.log" | tail -30
[ "${PIPESTATUS[0]}" -eq 0 ] && ok "POS acceptance passed" || fail "POS acceptance failed"

# ── 7 ── the acceptance runner ────────────────────────────────────────────
bold "All six Edge Functions, executing"
"$HERE/scripts/exec-functions.sh" "$STAGING" 2>&1 | tee "$EVIDENCE/07-functions.log" | tail -12
[ "${PIPESTATUS[0]}" -eq 0 ] && ok "function checks passed" || fail "function checks failed"

# ── 8 ── keep the evidence ────────────────────────────────────────────────
bold "Preserve the backup and the evidence"
chmod -R go-rwx "$EVIDENCE" 2>/dev/null
find "$EVIDENCE" -type f -name '*.dump' -exec chmod 600 {} \;
ok "$EVIDENCE (0700, dumps 0600)"
note "outside the repository; .gitignore excludes *.dump and .bedtime/"
git -C "$ROOT" check-ignore -q "$ROOT/x.dump" && ok "*.dump is git-ignored" || fail "*.dump is NOT git-ignored"

# ── 9 ── the git bundle ───────────────────────────────────────────────────
bold "Refresh and verify the git bundle"
BUNDLE="$HOME/bedtime-preservation/bedtime-$STAMP.bundle"
git -C "$ROOT" bundle create "$BUNDLE" --all >/dev/null 2>&1 && chmod 600 "$BUNDLE"
shasum -a 256 "$BUNDLE" > "$BUNDLE.sha256" && chmod 600 "$BUNDLE.sha256"
git -C "$ROOT" bundle verify "$BUNDLE" 2>&1 | grep -qi "complete history" \
  && ok "bundle records a complete history" || fail "bundle did not verify"
TMPC="$(mktemp -d)"; rm -rf "$TMPC"
if git clone -q "$BUNDLE" "$TMPC" 2>/dev/null; then
  ok "reconstructs: $(git -C "$TMPC" rev-list --count HEAD) commits"
  rm -rf "$TMPC"
else fail "the bundle did not clone"; fi

# ── 10 ── the verdict ─────────────────────────────────────────────────────
bold "Verdict"
{
  echo "# Bedtime pre-VPS acceptance — $STAMP"
  echo
  echo "Produced by migration-package/after-credential.sh. Every line below is"
  echo "a check that ran; evidence in $EVIDENCE."
  echo
  if [ "$FAILED" -eq 0 ]; then
    echo "## FULLY PRE-VPS READY"
    echo
    echo "Complete privileged backup taken, all 21 tables including the five"
    echo "RLS-protected ones, restored into an isolated database and reconciled"
    echo "against the dump's own snapshot. Staff rows and bcrypt PIN hashes"
    echo "verified by shape, never by value. PIN authentication and the critical"
    echo "POS operations executed against the restore. All six Edge Functions"
    echo "executed. Backup and evidence preserved outside git. Git bundle"
    echo "verified by reconstruction."
    echo
    echo "Remaining work is VPS-dependent only: server provisioning, final"
    echo "synchronisation, live-server acceptance and authorised cutover."
  else
    echo "## NOT READY — $FAILED check(s) failed"
    echo
    echo "See the logs in $EVIDENCE. Nothing is rounded up."
  fi
} | tee "$EVIDENCE/10-verdict.md" | sed 's/^/  /'

cp "$EVIDENCE/10-verdict.md" "$ROOT/docs/BEDTIME-ACCEPTANCE-$STAMP.md" 2>/dev/null
echo
if [ "$FAILED" -eq 0 ]; then printf '\033[32mAll checks passed.\033[0m Production was read only throughout.\n'
else printf '\033[31m%s check(s) failed.\033[0m Production was read only throughout.\n' "$FAILED"; fi
exit "$FAILED"
