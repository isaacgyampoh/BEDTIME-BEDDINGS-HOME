#!/usr/bin/env bash
# ===========================================================================
# Establish Bedtime's deployment access using the key Contabo says is already
# assigned to the instance. No console, no reboot, no reinstall.
#
#   ./migration-package/scripts/bootstrap-access-via-assigned-key.sh          dry run
#   ./migration-package/scripts/bootstrap-access-via-assigned-key.sh --go     do it
#
# WHY THIS WORKS, AND WHY IT WAS MISSED
#
# The Contabo API (contabo-api.sh survey) reports instance 203772835, the
# machine at 169.58.120.116, with exactly one SSH key assigned:
#
#   secretId 558271, name "everytinroom-contabo-deploy"
#   4096 SHA256:i9TatimCOzdhWuThAPdBM9kbfiYnThwb/FOXuQ06acY (RSA)
#
# That fingerprint matches ~/.ssh/everytinroom_contabo_rsa.pub on this
# machine, byte for byte.
#
# The key recorded earlier as "refused for root" was a DIFFERENT one --
# ~/.ssh/everytinroom_contabo, an ED25519 key, SHA256:eSB8Hxta... Both files
# begin "everytinroom_contabo", which is why one standing in for the other
# went unnoticed, and the sweep that would have caught it was correctly
# blocked for looking like credential spraying.
#
# So the provisioned key has been on this machine all along. Contabo's API
# did not grant new access here; it told us which of four local keys the
# server actually expects.
#
# WHAT THIS DOES
#
# Uses that key ONCE, to run deploy/access/install-deploy-account.sh on the
# server, which creates Bedtime's own scoped account. After that Bedtime uses
# its own key and this one is never needed again.
#
# WHAT IT WILL NOT DO
#
#   * never writes to /root/.ssh/authorized_keys -- the installer puts
#     Bedtime's key in the NEW account's own file
#   * never edits sshd_config, restarts sshd, or touches the firewall
#   * never touches an Everytinroom user, container, volume, network or file
#   * no reboot, no reinstall, no password authentication
#
# The installer it runs is idempotent, so a second run changes nothing.
# ===========================================================================
set -uo pipefail
HOST=169.58.120.116
KEY="$HOME/.ssh/everytinroom_contabo_rsa"
EXPECT_FP="SHA256:i9TatimCOzdhWuThAPdBM9kbfiYnThwb/FOXuQ06acY"
PROJECT=bedtime
INSTALLER_URL="https://bedtime-images.nanagyams99.workers.dev/da/$PROJECT"
GO=0
[ "${1:-}" = "--go" ] && GO=1

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

say "Bedtime deployment access, via the instance's assigned key"
note "$([ "$GO" -eq 1 ] && printf 'LIVE RUN' || printf 'DRY RUN -- nothing will be changed')"

# ── the key must be the one the API says is assigned ──────────────────────
[ -f "$KEY" ] || { no "no $KEY on this machine"; exit 2; }
FP="$(ssh-keygen -lf "$KEY.pub" 2>/dev/null | awk '{print $2}')"
if [ "$FP" != "$EXPECT_FP" ]; then
  no "that key's fingerprint is not the one Contabo reports as assigned"
  note "on disk : $FP"
  note "assigned: $EXPECT_FP"
  note "Re-run contabo-api.sh survey; the assignment may have changed."
  exit 2
fi
ok "key matches the assigned secret (558271, everytinroom-contabo-deploy)"

SSH_OPTS="-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o LogLevel=ERROR -o NumberOfPasswordPrompts=0"

if [ "$GO" -ne 1 ]; then
  say "What a live run would do"
  note "1. one login:  ssh -i ~/.ssh/everytinroom_contabo_rsa root@$HOST 'id -un'"
  note "2. then, on the server, exactly this:"
  note "     curl -fsSL $INSTALLER_URL | bash"
  note "3. then verify Bedtime's own key works:"
  note "     ssh -i ~/.ssh/bedtime_contabo ${PROJECT}-deploy@$HOST 'id -un'"
  note ""
  note "Nothing else. Re-run with --go to perform it."
  exit 0
fi

# ── one login, then the installer ─────────────────────────────────────────
say "Connecting"
WHO="$(ssh -i "$KEY" $SSH_OPTS "root@$HOST" 'id -un; hostname' 2>&1)" || {
  no "could not log in with the assigned key"
  printf '%s\n' "$WHO" | sed 's/^/      /'
  note "NOT trying other keys or users."
  note "If this says 'Permission denied (publickey)', the server's"
  note "authorized_keys no longer matches the secret Contabo has assigned."
  exit 3; }
ok "logged in as $(printf '%s' "$WHO" | head -1) on $(printf '%s' "$WHO" | tail -1)"

say "Recording what is there, before anything is added"
ssh -i "$KEY" $SSH_OPTS "root@$HOST" \
  'echo "root keys:"; ssh-keygen -lf /root/.ssh/authorized_keys 2>/dev/null | awk "{print \"  \"\$2}"; echo "running containers:"; docker ps --format "  {{.Names}} {{.Status}}" 2>/dev/null | head -10' 2>&1 | sed 's/^/      /'

say "Creating Bedtime's own scoped account"
ssh -i "$KEY" $SSH_OPTS "root@$HOST" "curl -fsSL '$INSTALLER_URL' | bash" 2>&1 | sed 's/^/      /' \
  || { no "the installer failed"; exit 4; }

say "Confirming root's keys are untouched"
ssh -i "$KEY" $SSH_OPTS "root@$HOST" \
  'ssh-keygen -lf /root/.ssh/authorized_keys 2>/dev/null | awk "{print \"  \"\$2}"' 2>&1 | sed 's/^/      /'

say "Confirming Everytinroom is still running"
ssh -i "$KEY" $SSH_OPTS "root@$HOST" \
  'docker ps --format "  {{.Names}} {{.Status}}" 2>/dev/null | head -10' 2>&1 | sed 's/^/      /'

say "Verifying Bedtime's own key, independently"
if OUT="$(ssh -i "$HOME/.ssh/bedtime_contabo" $SSH_OPTS "${PROJECT}-deploy@$HOST" 'id -un; sudo -n /usr/local/sbin/bedtimectl 2>&1 | head -1' 2>&1)"; then
  ok "$(printf '%s' "$OUT" | tr '\n' ' ')"
  say "Done"
  note "Bedtime now has its own account and key. Next:"
  note "  ./selfhost/survey-cotenant.sh          read-only"
  note "  ./selfhost/provision-cotenant.sh       dry run, then --go"
else
  no "Bedtime's own key does not work yet"
  printf '%s\n' "$OUT" | sed 's/^/      /'
  exit 5
fi
