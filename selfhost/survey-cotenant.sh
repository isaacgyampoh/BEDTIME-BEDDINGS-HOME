#!/usr/bin/env bash
# ===========================================================================
# Read the Contabo server and report what Bedtime may and may not do on it.
#
#   ./selfhost/survey-cotenant.sh              from this machine, over ssh
#   bash survey-cotenant.sh --local            on the server itself
#
# THIS SCRIPT ONLY READS. It starts nothing, stops nothing, installs nothing,
# writes no file and changes no configuration. Every command is a query.
#
# WHY IT EXISTS
#
# 169.58.120.116 already runs Everytinroom, and the instruction is that
# Everytinroom must remain completely unaffected. The decisions that depend on
# what is actually there, and which cannot be guessed from here:
#
#   * which reverse proxy holds 80/443, and how a vhost is added to it
#     (Bedtime CANNOT run its own Caddy on those ports -- they are taken)
#   * whether Postgres is one shared container or one per application, and
#     therefore whether Bedtime gets its own container or its own database,
#     role and schema inside the existing one
#   * which ports on 127.0.0.1 are already claimed, so Bedtime picks free ones
#   * how much disk is free, against a 319 MB image corpus and a 23 MB dump
#   * whether a backup mechanism already exists that Bedtime should join
#     rather than duplicate
#
# Output is a plan, printed. Nothing acts on it without being read first.
# ===========================================================================
set -uo pipefail
HOST=169.58.120.116
# Reconnaissance runs as root with the instance's assigned key, because the
# whole point of bedtime-deploy is that it CANNOT inspect the host: it has no
# docker group, no general sudo, and no read access to /root. Everything this
# probe does is a query -- it starts, stops, installs and writes nothing --
# and all of Bedtime's actual work afterwards runs as bedtime-deploy.
KEY="${SURVEY_KEY:-$HOME/.ssh/everytinroom_contabo_rsa}"
SURVEY_USER="${SURVEY_USER:-root}"
LOCAL=0
[ "${1:-}" = "--local" ] && LOCAL=1

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# The whole survey is one script so it crosses the wire once.
read -r -d '' PROBE <<'REMOTE'
echo "### host"
. /etc/os-release 2>/dev/null; echo "os: ${PRETTY_NAME:-unknown}"
echo "kernel: $(uname -r)"
echo "cores: $(nproc 2>/dev/null)"
echo "mem_total_mb: $(free -m 2>/dev/null | awk '/^Mem:/{print $2}')"
echo "mem_avail_mb: $(free -m 2>/dev/null | awk '/^Mem:/{print $7}')"
echo "uptime: $(uptime -p 2>/dev/null)"

echo "### disk"
df -h / /var /srv /opt 2>/dev/null | awk 'NR==1 || /\//'

echo "### docker"
if command -v docker >/dev/null 2>&1; then
  docker --version
  docker compose version 2>/dev/null | head -1
  echo "-- containers --"
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null
  echo "-- compose projects --"
  docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null | sort -u | sed '/^$/d'
  echo "-- volumes --"
  docker volume ls --format '{{.Name}}' 2>/dev/null
  echo "-- networks --"
  docker network ls --format '{{.Name}}\t{{.Driver}}' 2>/dev/null
else
  echo "docker: NOT INSTALLED"
fi

echo "### listening sockets"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | sed 's/users:.*pid=/pid=/'

echo "### who holds 80/443"
(ss -ltnp 2>/dev/null | grep -E ':(80|443)\s') || echo "nothing bound"
for p in nginx caddy traefik haproxy apache2; do
  command -v $p >/dev/null 2>&1 && echo "binary present: $p ($($p -v 2>&1 | head -1))"
done

echo "### application directories"
for d in /srv /opt /srv/central /srv/central/apps /opt/supabase /root; do
  [ -d "$d" ] && { echo "-- $d --"; ls -la "$d" 2>/dev/null | head -20; }
done

echo "### postgres reachable on loopback?"
for port in 5432 5433 6543 54322; do
  (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null && echo "127.0.0.1:$port OPEN" && exec 3>&- || echo "127.0.0.1:$port closed"
done
command -v psql >/dev/null 2>&1 && echo "psql: $(psql --version)" || echo "psql: not installed"

echo "### existing databases, if a container exposes them"
if command -v docker >/dev/null 2>&1; then
  for c in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'db|postgres|supabase' ); do
    echo "-- $c --"
    docker exec "$c" psql -U postgres -Atc "select datname||' | '||pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by 1;" 2>/dev/null || echo "   (could not query)"
  done
fi

echo "### firewall"
command -v ufw >/dev/null 2>&1 && ufw status verbose 2>/dev/null | head -25 || echo "ufw: not installed"

echo "### backups already in place"
ls -la /srv/backups /opt/backups /root/backups 2>/dev/null | head -20
for u in $(systemctl list-timers --all --no-legend 2>/dev/null | awk '{print $NF}' | head -20); do echo "timer: $u"; done
crontab -l 2>/dev/null | sed 's/^/crontab: /' | head -20

echo "### systemd units that are not stock"
systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | grep -vE '^(systemd|dbus|cron|ssh|rsyslog|polkit|networkd|resolved|udev|getty|user@|accounts-daemon|unattended|snapd|multipathd|irqbalance|chrony|atd)' | head -25

echo "### authorized_keys (fingerprints only, never the keys)"
ssh-keygen -lf /root/.ssh/authorized_keys 2>/dev/null | awk '{print $2, $4}' || echo "none readable"

echo "### END"
REMOTE

if [ "$LOCAL" -eq 1 ]; then
  say "Surveying this host locally"
  OUT="$(bash -c "$PROBE" 2>&1)"
  rc=$?
else
  [ -f "$KEY" ] || { no "no $KEY"; exit 2; }
  say "Surveying $HOST over ssh as $SURVEY_USER (read-only)"
  OUT="$(ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
           -o ConnectTimeout=15 -o LogLevel=ERROR "$SURVEY_USER@$HOST" "bash -s" <<<"$PROBE" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    no "could not survey the server"
    printf '%s\n' "$OUT" | sed 's/^/      /'
    note "If this is 'Permission denied (publickey)', re-check which key the"
    note "instance has assigned: ./migration-package/scripts/contabo-api.sh survey"
    note "NOT retrying with other keys or users."
    exit 3
  fi
fi

printf '%s\n' "$OUT"

# ── turn the findings into the decisions that matter ──────────────────────
say "What this means for Bedtime"

if printf '%s' "$OUT" | grep -qE ':(80|443)\s'; then
  no "ports 80/443 are ALREADY BOUND"
  note "Bedtime must NOT run selfhost/docker-compose.override.yml as written:"
  note "its caddy service binds 80:80 and 443:443 and would fail to start, or"
  note "worse, take them from whatever is serving Everytinroom."
  note "Bedtime adds a vhost to the EXISTING proxy and binds kong only on"
  note "127.0.0.1 at a free port."
else
  note "80/443 appear free -- unexpected on this server. Re-read the output"
  note "above before believing it."
fi

if printf '%s' "$OUT" | grep -q "docker: NOT INSTALLED"; then
  note "Docker is absent, so nothing is co-tenanted yet and the layout is open."
else
  C="$(printf '%s' "$OUT" | sed -n '/-- containers --/,/-- compose projects --/p' | grep -cE '^[a-zA-Z0-9]')"
  note "$C container line(s) already running -- treat every one as Everytinroom's"
  note "until proven otherwise. Bedtime creates its OWN compose project, its own"
  note "network and its own volumes, and touches no existing one."
fi

say "Ports Bedtime should claim, all on 127.0.0.1 only"
for p in 5433 8001 3001 4001; do
  if printf '%s' "$OUT" | grep -qE "127\.0\.0\.1:$p|0\.0\.0\.0:$p|:::$p"; then
    no "$p is taken -- pick another"
  else
    note "$p looks free"
  fi
done

say "Next"
note "Read the output above, then provision with the co-tenant path only."
note "Nothing in this survey changed anything on the server."
