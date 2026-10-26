#!/usr/bin/env bash
# Prepare a fresh Contabo (or any Ubuntu LTS) server to run Supabase.
#
# Run once, as root, on a NEW server. It is safe to re-run: every step checks
# before it acts. It installs nothing from this repository into the stack
# itself — the Supabase services come from the official self-hosting bundle,
# fetched here, so upgrades follow upstream rather than a copy that rots.
#
#   ssh root@<server>
#   bash bootstrap.sh bedtime
#
# Afterwards the stack is on disk but NOT started and NOT configured: secrets
# have to be generated into .env first. See selfhost/README.md.
set -euo pipefail

APP_USER="${1:-bedtime}"
STACK_DIR="/opt/supabase"

say () { printf '\n\033[1m== %s\033[0m\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "run this as root"; exit 1; }
. /etc/os-release
echo "Host: $PRETTY_NAME, $(nproc) cores, $(free -g | awk '/^Mem:/{print $2}') GB RAM, $(df -h / | awk 'NR==2{print $4}') free on /"

say "System packages and automatic security updates"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw fail2ban unattended-upgrades postgresql-client jq
dpkg-reconfigure -f noninteractive unattended-upgrades

say "A non-root user to own the stack"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
  # Copy the key you already used to get in, so you never need the root login again.
  install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
  [ -f /root/.ssh/authorized_keys ] && install -m 600 -o "$APP_USER" -g "$APP_USER" \
      /root/.ssh/authorized_keys "/home/$APP_USER/.ssh/authorized_keys"
fi

say "Docker Engine, from Docker's own repository"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$APP_USER"
systemctl enable --now docker
docker --version && docker compose version

say "Firewall"
# Postgres (5432), PostgREST, Studio and every other internal port stay closed.
# Only SSH and the two web ports are open; everything reaches the stack through
# the reverse proxy on 443.
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    comment 'ssh'
ufw allow 80/tcp    comment 'http, for certificate issuance and redirect'
ufw allow 443/tcp   comment 'https'
ufw --force enable
ufw status verbose | sed 's/^/  /'

say "SSH hardening"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd
systemctl enable --now fail2ban

say "The official Supabase self-hosting bundle"
# Taken from upstream rather than written out here, so `git pull` is the upgrade
# path and the service definitions are always the ones Supabase supports.
if [ ! -d "$STACK_DIR/.git" ]; then
  git clone --depth 1 https://github.com/supabase/supabase "$STACK_DIR/src"
  mkdir -p "$STACK_DIR"
  cp -r "$STACK_DIR/src/docker/." "$STACK_DIR/"
  rm -rf "$STACK_DIR/src"
fi
chown -R "$APP_USER:$APP_USER" "$STACK_DIR"
ls "$STACK_DIR" | sed 's/^/  /'

say "Done — and deliberately not started"
cat <<NEXT
  The stack is at $STACK_DIR and owned by $APP_USER. Nothing is running,
  because it would come up with the example secrets if it did.

  Next, as $APP_USER:
    1. cp $STACK_DIR/.env.example $STACK_DIR/.env && chmod 600 $STACK_DIR/.env
    2. generate every secret — selfhost/README.md lists them and how
    3. copy selfhost/docker-compose.override.yml into $STACK_DIR/
    4. docker compose up -d
NEXT
