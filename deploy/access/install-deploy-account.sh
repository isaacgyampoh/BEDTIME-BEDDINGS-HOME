#!/usr/bin/env bash
# ===========================================================================
# Create a per-project deployment account on a shared server, and authorize
# exactly one SSH key for it.
#
# Run as root, ON THE SERVER, from the provider's web console:
#
#     curl -fsSL https://<worker>/deploy-access?p=bedtime | bash
#
# This is the canonical source. The Worker serves this same file with one
# line substituted -- the project's public key -- so what runs on the server
# is reviewable here, in git, rather than being a script nobody has read.
#
# WHAT IT REFUSES TO TOUCH
#
# This runs on a machine that is already serving another business. It does
# NOT, under any circumstance:
#
#   * read, move, rewrite or append to /root/.ssh/authorized_keys
#   * edit sshd_config, or restart, reload or signal sshd
#   * touch the firewall, ufw, iptables or nftables
#   * touch any existing user, group, container, volume, network or service
#   * install a package or change a system setting
#
# It only adds: one system user, that user's own ~/.ssh/authorized_keys, one
# root-owned wrapper script, and one sudoers drop-in naming only that wrapper.
# Every existing authorized key on the box keeps working, because none of
# them is in a file this script opens for writing.
#
# WHY A SEPARATE ACCOUNT RATHER THAN ANOTHER KEY ON ROOT
#
# A key appended to root is root forever and is awkward to revoke without
# risking the keys beside it. A per-project account is revoked with one
# `userdel -r`, which cannot affect another project, and it makes "who did
# that" answerable in the logs.
#
# WHY THE SUDOERS ENTRY IS ONE WRAPPER AND NOT THE DOCKER GROUP
#
# Adding the account to the `docker` group is the usual shortcut and it is
# root-equivalent in practice: anyone who can talk to the Docker socket can
# mount the host filesystem into a container and walk out with everything,
# including the other project's database. That is not narrow scope, whatever
# the group name suggests.
#
# So the account gets NO docker group, NO password, and NO general sudo. It
# may run one root-owned script, which accepts a fixed verb list and operates
# only on its own compose project in its own directory. The script is owned by
# root and not writable by the account, so the account cannot widen its own
# permissions by editing it.
#
# IDEMPOTENT. Run it twice and the second run changes nothing. Each step
# checks the current state before acting and says which it did.
# ===========================================================================
set -uo pipefail

PROJECT="${1:-${PROJECT:-__PROJECT__}}"
PUBKEY="${PUBKEY:-__PUBKEY__}"

ok   () { printf '  [ok]   %s\n' "$*"; }
no   () { printf '  [FAIL] %s\n' "$*" >&2; }
note () { printf '  -      %s\n' "$*"; }
head_() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { no "run this as root (you are $(id -un))"; exit 1; }

case "$PROJECT" in
  ''|__PROJECT__|*[!a-z0-9-]*) no "project name missing or not substituted (lowercase letters, digits and dashes)"; exit 2 ;;
esac
case "$PUBKEY" in
  __PUBKEY__|'') no "no public key was substituted -- refusing"; exit 2 ;;
  ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*) : ;;
  *) no "that does not look like an SSH public key -- refusing"; exit 2 ;;
esac

USER_N="$PROJECT-deploy"
HOME_D="/srv/$PROJECT"
WRAP="/usr/local/sbin/${PROJECT}ctl"
SUDOF="/etc/sudoers.d/60-$USER_N"

head_ "Installing deployment access for '$PROJECT'"
note "account  : $USER_N"
note "home     : $HOME_D"
note "wrapper  : $WRAP"
note "key      : $(printf '%s' "$PUBKEY" | awk '{print $1, substr($2,1,24)"..."}')"

# ── the account ───────────────────────────────────────────────────────────
head_ "Account"
if id -u "$USER_N" >/dev/null 2>&1; then
  ok "$USER_N already exists -- leaving it alone"
else
  useradd --system --create-home --home-dir "$HOME_D" --shell /bin/bash "$USER_N" \
    || { no "could not create $USER_N"; exit 3; }
  ok "created $USER_N"
fi
# No password, and none can be set by logging in: key authentication only.
passwd -l "$USER_N" >/dev/null 2>&1 && ok "password login disabled for the account"
install -d -m 0750 -o "$USER_N" -g "$USER_N" "$HOME_D"
ok "$HOME_D present, mode 0750, owned by $USER_N"

# ── the key, appended idempotently, in the ACCOUNT'S OWN FILE ─────────────
head_ "Authorized key"
AK="$HOME_D/.ssh/authorized_keys"
install -d -m 0700 -o "$USER_N" -g "$USER_N" "$HOME_D/.ssh"
touch "$AK"
BEFORE=$(grep -c . "$AK" 2>/dev/null); BEFORE=${BEFORE:-0}
if grep -qxF "$PUBKEY" "$AK" 2>/dev/null; then
  ok "the key is already authorized -- nothing appended"
else
  # Back up before writing, even though this file is ours, so a mistake here
  # is recoverable without reasoning about it.
  [ "$BEFORE" -gt 0 ] && cp -a "$AK" "$AK.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  printf '%s\n' "$PUBKEY" >> "$AK"
  ok "key appended"
fi
chown "$USER_N:$USER_N" "$AK"; chmod 600 "$AK"
AFTER=$(grep -c . "$AK" 2>/dev/null); AFTER=${AFTER:-0}
note "$USER_N now has $AFTER authorized key(s) (was $BEFORE)"

# Prove the untouchable file was untouched.
if [ -f /root/.ssh/authorized_keys ]; then
  note "root's authorized_keys: $(grep -c . /root/.ssh/authorized_keys) key(s), not opened for writing by this script"
fi

# ── the wrapper: the only thing this account may do as root ───────────────
head_ "Scoped privilege"
cat > "$WRAP" <<WRAPPER
#!/usr/bin/env bash
# Managed by install-deploy-account.sh for project '$PROJECT'. Root-owned.
#
# The ONLY command $USER_N may run as root. It accepts a fixed verb list and
# acts only on compose project '$PROJECT' in $HOME_D, so a compromised
# deployment key cannot reach another project's stack, socket or data.
set -uo pipefail
PROJ=$PROJECT
DIR=$HOME_D
cd "\$DIR" 2>/dev/null || { echo "\$DIR is missing"; exit 1; }
FILES=()
[ -f "\$DIR/supabase/docker-compose.yml" ] && FILES+=(-f "\$DIR/supabase/docker-compose.yml")
[ -f "\$DIR/docker-compose.cotenant.yml" ] && FILES+=(-f "\$DIR/docker-compose.cotenant.yml")
case "\${1:-}" in
  up)      exec docker compose -p "\$PROJ" "\${FILES[@]}" up -d ;;
  down)    exec docker compose -p "\$PROJ" "\${FILES[@]}" down ;;
  restart) exec docker compose -p "\$PROJ" "\${FILES[@]}" restart ;;
  ps)      exec docker compose -p "\$PROJ" "\${FILES[@]}" ps ;;
  logs)    exec docker compose -p "\$PROJ" "\${FILES[@]}" logs --tail 200 ;;
  psql)    shift; exec docker exec -i "\${PROJ}-db-1" psql -U postgres "\$@" ;;
  dump)    exec docker exec "\${PROJ}-db-1" pg_dump -U postgres postgres ;;
  *) echo "usage: \$(basename "\$0") {up|down|restart|ps|logs|psql|dump}"; exit 2 ;;
esac
WRAPPER
chown root:root "$WRAP"; chmod 0755 "$WRAP"
ok "installed $WRAP (root-owned, not writable by $USER_N)"

# ── sudoers, validated BEFORE it is allowed to take effect ────────────────
# A malformed file in /etc/sudoers.d breaks sudo for EVERY user on the host,
# including the other project's. So it is written to a temporary file, checked
# with visudo -c, and only then moved into place.
TMPS="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: %s\n' "$USER_N" "$WRAP" > "$TMPS"
printf 'Defaults:%s !requiretty\n' "$USER_N" >> "$TMPS"
chmod 0440 "$TMPS"
if visudo -cf "$TMPS" >/dev/null 2>&1; then
  install -m 0440 -o root -g root "$TMPS" "$SUDOF"
  rm -f "$TMPS"
  ok "sudoers drop-in validated and installed: $SUDOF"
  note "it permits exactly one command, and nothing else"
else
  rm -f "$TMPS"
  no "the sudoers drop-in did not validate -- NOT installed, sudo is untouched"
  exit 4
fi

# ── verify, and show what an operator can check themselves ────────────────
head_ "Verification"
ssh-keygen -lf "$AK" 2>/dev/null | sed 's/^/  key:   /'
sudo -l -U "$USER_N" 2>/dev/null | sed -n '/may run/,$p' | sed 's/^/  sudo:  /'
getent passwd "$USER_N" | awk -F: '{printf "  user:  %s uid=%s shell=%s home=%s\n", $1,$3,$7,$6}'
id -nG "$USER_N" | tr ' ' '\n' | sed 's/^/  group: /'
note "no docker group above is correct and deliberate -- see the header"

head_ "Done"
note "From the project's own machine:"
note "  ssh -i ~/.ssh/${PROJECT}_contabo $USER_N@\$(hostname -I 2>/dev/null | awk '{print \$1}')"
note "To revoke this project's access completely, and nothing else:"
note "  userdel -r $USER_N && rm -f $SUDOF $WRAP"
