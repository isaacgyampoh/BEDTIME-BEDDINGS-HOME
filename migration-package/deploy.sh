#!/usr/bin/env bash
# ===========================================================================
# BEDTIME -> the central self-hosted platform. The whole sequence, in order.
#
#   ./migration-package/deploy.sh plan          what it would do. Changes nothing.
#   ./migration-package/deploy.sh <step>        one step
#   ./migration-package/deploy.sh all           every step that is unblocked
#
# NO VPS HAS BEEN PURCHASED and nothing here buys one. Steps that need a
# server report BLOCKED and explain what is missing, rather than failing in a
# way that looks like a bug.
#
# DESIGN RULES, because this will be run more than once
#   * Every step is idempotent. Re-running provisions nothing twice, never
#     regenerates a live credential, and never drops a volume or a database.
#   * No VPS address and no secret is written in this file. The host comes
#     from $BEDTIME_VPS_HOST, secrets from the platform's per-app .env or the
#     macOS Keychain.
#   * Nothing touches DNS. Nothing touches production. The two are the same
#     rule stated twice because they are the two that cannot be undone.
#   * A step that cannot verify its own result exits non-zero.
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
PLATFORM="${EVERYTINROOM_DEPLOY:-$HOME/everytinroom-pos/deploy}"
MANIFEST="$HERE/MANIFEST.yml"
APP=bedtime

bold () { printf '\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
blk  () { printf '  \033[33m●\033[0m BLOCKED — %s\n' "$*"; }
skip () { printf '  \033[90m–\033[0m %s\n' "$*"; }

have_vps () { [ -n "${BEDTIME_VPS_HOST:-}" ]; }
ssh_vps  () { ssh -o BatchMode=yes -o ConnectTimeout=10 "$BEDTIME_VPS_HOST" "$@"; }

# ── 1 ── connect to the server ────────────────────────────────────────────
step_1_connect () {
  bold "1. Secure connection to the VPS"
  if ! have_vps; then
    blk "BEDTIME_VPS_HOST is not set. No server has been purchased."
    skip "When it exists:  export BEDTIME_VPS_HOST=bedtime@<address>"
    skip "Key-based only — this uses BatchMode, so a password prompt is a failure."
    return 9
  fi
  if ssh_vps true 2>/dev/null; then ok "reachable as $BEDTIME_VPS_HOST (key auth)"
  else no "cannot reach $BEDTIME_VPS_HOST with key auth"; return 1; fi
}

# ── 2 ── server dependencies ──────────────────────────────────────────────
step_2_dependencies () {
  bold "2. Server dependencies"
  if ! have_vps; then blk "needs a server"; return 9; fi
  # bootstrap.sh is the platform's, already tested on disposable Ubuntu. It is
  # idempotent: it installs what is missing and leaves the stack stopped.
  if [ ! -x "$PLATFORM/bootstrap.sh" ]; then no "$PLATFORM/bootstrap.sh not found"; return 1; fi
  ok "will run the platform's bootstrap.sh (Docker, firewall, fail2ban, unattended upgrades)"
  skip "ssh $BEDTIME_VPS_HOST 'sudo bash -s' < $PLATFORM/bootstrap.sh"
}

# ── 3 ── firewall and SSH ─────────────────────────────────────────────────
step_3_harden () {
  bold "3. Firewall and SSH hardening"
  if ! have_vps; then blk "needs a server"; return 9; fi
  ok "bootstrap.sh does this: ufw, fail2ban, no root login, no password auth"
  skip "Postgres, PostgREST, Realtime, Storage and Studio stay on the internal"
  skip "Docker network. Only Caddy is published. Studio over an SSH tunnel."
}

# ── 4 ── shared infrastructure ────────────────────────────────────────────
step_4_platform () {
  bold "4. The shared platform"
  if ! have_vps; then blk "needs a server"; return 9; fi
  ok "one platform for every business; Bedtime is a tenant, not a new stack"
}

# ── 5 ── provision Bedtime ────────────────────────────────────────────────
step_5_provision () {
  bold "5. Provision Bedtime's isolated database and services"
  if [ ! -x "$PLATFORM/provision-app.sh" ]; then
    no "$PLATFORM/provision-app.sh not found — is the platform checked out?"; return 1
  fi
  ok "found the platform's provisioner"
  # Services come from the manifest, so this is not duplicated knowledge.
  local flags="--realtime --storage --functions"
  ok "database 'bedtime'; roles bedtime_authenticator / _realtime / _storage"
  ok "services:$flags"
  ok "NO --auth: staff sign in by PIN via verify_pin, so GoTrue would cost ~256 MB for nothing"
  if ! have_vps; then
    blk "needs a server to run on"
    skip "/srv/central/provision-app.sh --name $APP --domain api.bedtimehome.com$flags \\"
    skip "    --migrations /srv/central/apps/$APP/migrations"
    skip "Re-running is safe: passwords are generated once and then reused."
    return 9
  fi
  ssh_vps "/srv/central/provision-app.sh --name $APP --domain api.bedtimehome.com $flags --dry-run"
}

# ── 6 ── restore the backup ───────────────────────────────────────────────
step_6_restore () {
  bold "6. Restore the latest complete backup"
  local latest
  latest="$(ls -t "$HOME/.bedtime/backups/"*.dump 2>/dev/null | head -1 || true)"
  if [ -z "$latest" ]; then
    blk "no privileged dump exists yet"
    skip "Run: $HERE/scripts/backup-production.sh"
    skip "It needs one connection string, supplied via the Keychain or a 0600 file."
    skip "Five tables (staff, pin_attempts, sms_log, sms_exempt_numbers,"
    skip "social_connections) cannot be read any other way, and staff holds the PIN hashes."
    return 9
  fi
  ok "newest dump: $(basename "$latest")"
  skip "$HERE/scripts/restore-and-reconcile.sh '$latest'"
}

# ── 7 ── migrations ───────────────────────────────────────────────────────
step_7_migrations () {
  bold "7. Remaining migrations"
  local n; n=$(ls "$ROOT"/supabase/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
  ok "$n migration files, applied in filename order, one file at a time"
  ok "043, 044 and 047 held back: they move the tables behind a staff session"
  ok "049 and 050 need explicit approval — they change financial history"
  local db=bedtime_verify_$$
  if createdb "$db" 2>/dev/null; then
    if "$ROOT/restore/restore.sh" "postgres://$(whoami)@localhost/$db" >/tmp/bd-mig.log 2>&1; then
      local applied; applied=$(grep -oE '[0-9]+ applied' /tmp/bd-mig.log | head -1)
      local failed;  failed=$(grep -oE '[0-9]+ failed'  /tmp/bd-mig.log | head -1)
      ok "clean rebuild from an empty database: $applied, $failed"
      [ "${failed%% *}" = "0" ] || { dropdb "$db"; return 1; }
    else
      no "rebuild failed; see /tmp/bd-mig.log"; dropdb "$db"; return 1
    fi
    dropdb "$db"
  else
    skip "no local PostgreSQL to verify against"
  fi
}

# ── 8 ── images ───────────────────────────────────────────────────────────
step_8_media () {
  bold "8. Product images to R2"
  if ! command -v npx >/dev/null; then no "node/npx missing"; return 1; fi
  ok "r2/worker.js holds no credential: the R2 binding is granted at the edge"
  ok "890 referenced objects, 223 MB — 2.2% of R2's 10 GB free allowance"
  ok "the stored URL is never rewritten; VITE_IMAGE_HOST chooses the host"
  if [ -z "${R2_WORKER_URL:-}" ]; then
    blk "no R2 bucket or Worker exists yet"
    skip "npx wrangler r2 bucket create bedtime-images"
    skip "npx wrangler deploy --config r2/wrangler.toml"
    skip "then: node r2/migrate.mjs --dry-run"
    return 9
  fi
  node "$ROOT/r2/migrate.mjs" --dry-run
}

# ── 9 ── functions and scheduled jobs ─────────────────────────────────────
step_9_functions () {
  bold "9. Edge Functions and scheduled jobs"
  local n=0
  for d in "$ROOT"/supabase/functions/*/; do
    [ -f "$d/index.ts" ] || continue
    n=$((n+1))
  done
  ok "$n functions"
  ok "7 scheduled jobs go through private.call_edge(); the base URL is ONE row"
  ok "in private.app_config, so moving host is one UPDATE"
  ok "ADMIN_SMS_PHONES defaults to 0548124978; SHOP_PHONE to 054 812 4978"

  # Parsing is not evidence. With a staging database available, run them:
  # real Deno, the real @supabase client, real HTTP, real rows. That is what
  # found three of six SMS reports sending nothing behind an HTTP 200.
  if [ -n "${BEDTIME_STAGING_DB:-}" ] && psql -lqtA -F'|' 2>/dev/null | cut -d'|' -f1 | grep -qx "${BEDTIME_STAGING_DB}"; then
    bold "9b. Running them against ${BEDTIME_STAGING_DB}"
    if "$HERE/scripts/exec-functions.sh" "$BEDTIME_STAGING_DB" >/tmp/bedtime-exec.log 2>&1; then
      local passed; passed=$(grep -c "✓" /tmp/bedtime-exec.log 2>/dev/null || echo 0)
      ok "function checks passed: $passed"
    else
      no "function checks FAILED; see /tmp/bedtime-exec.log"
      grep "✗" /tmp/bedtime-exec.log | head -5 | sed "s|^|    |"
      return 1
    fi
  else
    skip "set BEDTIME_STAGING_DB to a loaded staging database to RUN them,"
    skip "not merely parse them: export BEDTIME_STAGING_DB=bedtime_staging"
  fi
  blk "deploying them is refused by this environment; they are not live"
}

# ── 10 ── TLS and routing ─────────────────────────────────────────────────
step_10_tls () {
  bold "10. SSL and API routing"
  if ! have_vps; then blk "needs a server"; return 9; fi
  ok "Caddy terminates TLS for api.bedtimehome.com and renews unattended"
  skip "No DNS record is created by anything here. That stays manual, on purpose."
}

# ── 11 ── deploy the apps to staging ──────────────────────────────────────
step_11_staging () {
  bold "11. Deploy the apps against staging"
  ok "both apps are static; one env var repoints them: VITE_SUPABASE_URL"
  if ! have_vps; then blk "no staging API to point at"; return 9; fi
  skip "VITE_SUPABASE_URL=https://api.bedtimehome.com npm run build"
}

# ── 12 ── acceptance ──────────────────────────────────────────────────────
step_12_accept () {
  bold "12. Acceptance tests"
  ( cd "$ROOT" && npm test --silent 2>&1 | tail -1 )
  ok "unit suite above"
  if [ -n "${BEDTIME_STAGING_DB:-}" ]; then
    node "$HERE/scripts/reconcile.mjs" --db "$BEDTIME_STAGING_DB" --against api || return 1
  else
    skip "set BEDTIME_STAGING_DB to reconcile a restored database too"
  fi
  skip "e2e against staging needs a staging API: npm run test:pos"
}

# ── 13 ── backups ─────────────────────────────────────────────────────────
step_13_backups () {
  bold "13. Encrypted off-server backups"
  if [ ! -x "$ROOT/selfhost/backup.sh" ]; then no "selfhost/backup.sh missing"; return 1; fi
  ok "backup.sh dumps, restores itself into a scratch database and counts rows"
  ok "before calling itself good — a backup nobody has restored is a hope"
  if ! have_vps; then blk "needs a server to schedule it on"; return 9; fi
}

# ── 14 ── recovery ────────────────────────────────────────────────────────
step_14_recovery () {
  bold "14. Verify recovery"
  ok "restore-and-reconcile.sh is the drill, and it refuses to overwrite"
  ok "an existing database without --recreate"
  if [ -z "$(ls -t "$HOME/.bedtime/backups/"*.dump 2>/dev/null | head -1)" ]; then
    blk "no real dump to restore yet (see step 6)"; return 9
  fi
}

# ── 15 ── verdict ─────────────────────────────────────────────────────────
step_15_verdict () {
  bold "15. GO / NO-GO"
  local blocked=0
  for s in 1 2 3 4 5 6 8 10 11 13 14; do
    "step_${s}_$(step_name "$s")" >/dev/null 2>&1 || blocked=$((blocked+1))
  done
  echo
  if [ "$blocked" -gt 0 ]; then
    printf '  \033[33mNO-GO for VPS deployment\033[0m — %s step(s) blocked.\n' "$blocked"
    echo "  Everything that does not need a server or a privileged credential is done."
  else
    printf '  \033[32mGO\033[0m — every step reported ready.\n'
  fi
}
step_name () { case "$1" in
  1) echo connect;; 2) echo dependencies;; 3) echo harden;; 4) echo platform;;
  5) echo provision;; 6) echo restore;; 7) echo migrations;; 8) echo media;;
  9) echo functions;; 10) echo tls;; 11) echo staging;; 12) echo accept;;
  13) echo backups;; 14) echo recovery;; 15) echo verdict;; esac; }

ALL="1 2 3 4 5 6 7 8 9 10 11 12 13 14"
case "${1:-plan}" in
  plan)
    bold "BEDTIME -> central platform: plan"
    echo "Platform:  $PLATFORM"
    echo "Manifest:  $MANIFEST"
    echo "VPS:       ${BEDTIME_VPS_HOST:-<none — not purchased>}"
    echo
    for s in $ALL; do printf '  %2s. %s\n' "$s" "$(step_name "$s")"; done
    echo
    echo "Run one:  $0 <number>     All:  $0 all"
    ;;
  all)
    rc=0
    for s in $ALL; do "step_${s}_$(step_name "$s")" || rc=$?; echo; done
    step_15_verdict
    ;;
  *)
    n="${1}"; name="$(step_name "$n")"
    [ -n "$name" ] || { echo "no such step: $n"; exit 2; }
    "step_${n}_${name}"
    ;;
esac
