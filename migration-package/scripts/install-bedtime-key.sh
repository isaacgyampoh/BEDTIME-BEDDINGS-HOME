#!/usr/bin/env bash
# ===========================================================================
# Append Bedtime's public key to root's authorized_keys on the Contabo VPS,
# using the credential collected by enter-contabo-credential.sh, exactly once.
#
#   ./migration-package/scripts/install-bedtime-key.sh
#
# THE ONE RULE: APPEND, NEVER REPLACE.
#
# authorized_keys on that server carries the access Everytinroom's cutover
# depends on. A `>` where a `>>` belongs would end it. So:
#
#   1. the file is copied to authorized_keys.bak-<UTC timestamp> first
#   2. the keys are counted and fingerprinted BEFORE
#   3. the append is idempotent -- running twice does not add it twice
#   4. the keys are counted and fingerprinted AFTER
#   5. the run FAILS if any pre-existing fingerprint is missing afterwards
#
# Nothing here restarts sshd, edits sshd_config, touches
# PasswordAuthentication, or goes near an Everytinroom service, file or
# container. Appending a line takes effect on the next connection.
#
# No private key is ever printed, copied into the repository, or sent
# anywhere. The credential is read from the Keychain into a variable that is
# unset before the script exits.
# ===========================================================================
set -uo pipefail
HOST=169.58.120.116
USER_R=root
SERVICE=bedtime-contabo
PUB="$HOME/.ssh/bedtime_contabo.pub"

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

[ -f "$PUB" ] || { no "no $PUB -- the Bedtime key pair is missing"; exit 2; }
KEY="$(tr -d '\r\n' < "$PUB")"
FP="$(ssh-keygen -lf "$PUB" | awk '{print $2}')"

say "Bedtime key to install"
note "$FP"
note "$(printf '%s' "$KEY" | cut -c1-40)…"

# ── the credential ────────────────────────────────────────────────────────
RAWK="$(security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null || true)"
if [ -z "$RAWK" ]; then
  no "no credential stored"
  note "Run migration-package/scripts/enter-contabo-credential.sh first."
  exit 2
fi
DEC="$(printf '%s' "$RAWK" | base64 -d 2>/dev/null || true)"
unset RAWK
KIND="$(printf '%s' "$DEC" | head -1)"
VAL="$(printf '%s' "$DEC" | tail -n +2)"
unset DEC
case "$KIND" in
  password|keyfile) ok "credential present (kind: $KIND)" ;;
  *) no "the stored credential is malformed"; exit 2 ;;
esac

# ── how we will connect ───────────────────────────────────────────────────
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o LogLevel=ERROR"

# Password login with no third-party helper. OpenSSH >= 8.4 calls SSH_ASKPASS
# even when a terminal is available if SSH_ASKPASS_REQUIRE=force (this machine
# runs 10.5), so the password reaches ssh through a helper script rather than
# through argv, where `ps` would expose it. The helper lives mode 700 in a
# mkdtemp directory, reads the value from its own environment, and the
# directory is removed on exit.
ASKDIR=""
cleanup_ask () { [ -n "$ASKDIR" ] && rm -rf "$ASKDIR"; }
trap cleanup_ask EXIT

make_askpass () {
  ASKDIR="$(mktemp -d -t bedtime-ask)"
  chmod 700 "$ASKDIR"
  printf '#!/bin/sh\nprintf %%s "$BEDTIME_PW"\n' > "$ASKDIR/ask"
  chmod 700 "$ASKDIR/ask"
}

ssh_pw () {   # ssh_pw <ssh args...>; stdin passes through
  # shellcheck disable=SC2086
  BEDTIME_PW="$VAL" SSH_ASKPASS="$ASKDIR/ask" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
    ssh -o NumberOfPasswordPrompts=1 \
        -o PreferredAuthentications=password,keyboard-interactive \
        $SSH_OPTS "$@"
}

run_remote () {   # run_remote <command>
  if [ "$KIND" = keyfile ]; then
    # shellcheck disable=SC2086
    ssh -i "$VAL" -o BatchMode=yes $SSH_OPTS "$USER_R@$HOST" "$1"
  else
    [ -n "$ASKDIR" ] || make_askpass
    ssh_pw "$USER_R@$HOST" "$1"
  fi
}

say "Connecting"
WHO="$(run_remote 'id -un; hostname' 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  no "could not log in"
  printf '%s\n' "$WHO" | sed 's/^/      /'
  note "NOT retrying with other users or keys: that is credential spraying."
  note "If the credential is wrong, re-run enter-contabo-credential.sh."
  unset VAL
  exit 3
fi
ok "logged in as $(printf '%s' "$WHO" | head -1) on $(printf '%s' "$WHO" | tail -1)"

# ── before ────────────────────────────────────────────────────────────────
say "authorized_keys before"
BEFORE="$(run_remote 'test -f ~/.ssh/authorized_keys && ssh-keygen -lf ~/.ssh/authorized_keys 2>/dev/null | awk "{print \$2}" || true')"
BCOUNT="$(printf '%s\n' "$BEFORE" | grep -c 'SHA256:' || true)"
note "$BCOUNT key(s) authorized"
printf '%s\n' "$BEFORE" | grep 'SHA256:' | sed 's/^/      /'

if printf '%s\n' "$BEFORE" | grep -qF "$FP"; then
  ok "the Bedtime key is ALREADY authorized -- nothing to do"
  unset VAL
  exit 0
fi

# ── backup, then append ───────────────────────────────────────────────────
say "Backing up, then appending"
BK="$(run_remote 'set -e; mkdir -p ~/.ssh; chmod 700 ~/.ssh; touch ~/.ssh/authorized_keys; B=~/.ssh/authorized_keys.bak-$(date -u +%Y%m%dT%H%M%SZ); cp -a ~/.ssh/authorized_keys "$B"; echo "$B"' 2>&1)" || {
  no "could not take a backup -- refusing to append"; unset VAL; exit 4; }
ok "backup: $BK"

# The key goes over stdin, not inside the remote command string, so no
# quoting accident can turn an append into something else.
if [ "$KIND" = keyfile ]; then
  printf '%s\n' "$KEY" | ssh -i "$VAL" -o BatchMode=yes $SSH_OPTS "$USER_R@$HOST" \
    'K=$(cat); grep -qF "$K" ~/.ssh/authorized_keys || printf "%s\n" "$K" >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys'
else
  printf '%s\n' "$KEY" | ssh_pw "$USER_R@$HOST" \
    'K=$(cat); grep -qF "$K" ~/.ssh/authorized_keys || printf "%s\n" "$K" >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys'
fi || { no "the append failed"; note "restore with: cp -a $BK ~/.ssh/authorized_keys"; unset VAL; exit 4; }
ok "appended"

# ── after ─────────────────────────────────────────────────────────────────
say "authorized_keys after"
AFTER="$(run_remote 'ssh-keygen -lf ~/.ssh/authorized_keys 2>/dev/null | awk "{print \$2}"')"
ACOUNT="$(printf '%s\n' "$AFTER" | grep -c 'SHA256:' || true)"
note "$ACOUNT key(s) authorized"
printf '%s\n' "$AFTER" | grep 'SHA256:' | sed 's/^/      /'
unset VAL

LOST=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  printf '%s\n' "$AFTER" | grep -qF "$f" || { no "LOST a pre-existing key: $f"; LOST=1; }
done <<EOF
$(printf '%s\n' "$BEFORE" | grep 'SHA256:')
EOF

if [ "$LOST" -ne 0 ]; then
  no "a key that was there before is gone. Restore immediately:"
  note "  cp -a $BK ~/.ssh/authorized_keys"
  exit 5
fi
ok "every pre-existing key is still authorized"

printf '%s\n' "$AFTER" | grep -qF "$FP" && ok "the Bedtime key is authorized" || { no "the Bedtime key is NOT there"; exit 5; }

# ── prove the Bedtime key works on its own ────────────────────────────────
say "Connecting with Bedtime's own key"
if OUT="$(ssh -i "$HOME/.ssh/bedtime_contabo" -o BatchMode=yes $SSH_OPTS "$USER_R@$HOST" 'echo OK; id -un' 2>&1)"; then
  ok "$(printf '%s' "$OUT" | tr '\n' ' ')"
  echo
  say "Done"
  note "The administration credential is no longer needed. Remove it with:"
  note "  security delete-generic-password -a \"\$USER\" -s $SERVICE"
else
  no "the Bedtime key still cannot log in"
  printf '%s\n' "$OUT" | sed 's/^/      /'
  exit 5
fi
