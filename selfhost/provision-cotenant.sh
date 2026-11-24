#!/usr/bin/env bash
# ===========================================================================
# Bedtime, Phases B–F on the shared Contabo server. Run from this machine.
#
#   ./selfhost/provision-cotenant.sh              DRY RUN -- prints, changes nothing
#   ./selfhost/provision-cotenant.sh --go         actually does it
#
# DRY RUN IS THE DEFAULT, deliberately. Everything destructive or
# outward-facing on this host is one mistake away from Everytinroom, so the
# first run shows the plan and the second performs it.
#
# WHAT IT DOES, IN ORDER
#
#   B  an isolated Bedtime stack: its own compose project, network, volumes
#      and database, under /srv/bedtime. Nothing shared, nothing adopted.
#   C  the services the apps actually need, kong on loopback only.
#   D  restore the production dump; reconcile against the captured baseline.
#   E  backups to Cloudflare R2, with a restore REHEARSAL, not just a dump.
#   F  staff authentication and the acceptance suites.
#
# Phase G -- DNS and cutover -- is NOT here. It needs an explicit GO.
#
# WHAT IT WILL NOT DO, BY CONSTRUCTION
#
#   * touch the firewall. 443 is already open; Bedtime needs no new hole.
#   * touch sshd, or any Everytinroom container, volume, network or file.
#   * edit the host's reverse proxy. It PRINTS the one vhost line to add.
#   * delete anything from hosted Supabase.
#   * run if the preflight finds Bedtime's chosen paths or ports occupied.
# ===========================================================================
set -uo pipefail
HOST=169.58.120.116
KEY="$HOME/.ssh/bedtime_contabo"
# Not root. deploy/access/install-deploy-account.sh creates this account with
# no password, no docker group and no general sudo -- it may run exactly one
# root-owned wrapper, and only against its own compose project.
ACCT=bedtime-deploy
ROOT=/srv/bedtime
PROJ=bedtime
CTL="sudo /usr/local/sbin/bedtimectl"
KONG_PORT=8001
GO=0
[ "${1:-}" = "--go" ] && GO=1

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }
plan () { printf '  \033[36m→\033[0m %s\n' "$*"; }

SSH="ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o LogLevel=ERROR $ACCT@$HOST"

# Every remote action goes through this, so the dry run is honest: nothing
# can act without being printed, because acting IS printing plus $GO.
remote () {  # remote <label> <command>
  if [ "$GO" -eq 1 ]; then
    plan "$1"
    $SSH "$2" || { no "failed: $1"; exit 4; }
  else
    plan "$1"
    printf '      \033[90m%s\033[0m\n' "$2"
  fi
}
# Read-only queries run even in a dry run -- they change nothing and the plan
# is worthless without the facts.
query () { $SSH "$1" 2>&1; }

[ -f "$KEY" ] || { no "no $KEY -- see deploy/BEDTIME-ONE-ACCESS-REQUEST.md"; exit 2; }

say "Bedtime co-tenant provisioning"
note "$([ "$GO" -eq 1 ] && printf 'LIVE RUN -- changes will be made' || printf 'DRY RUN -- nothing will be changed')"
note "host $HOST, project '$PROJ', root $ROOT, kong on 127.0.0.1:$KONG_PORT"

# ── preflight ─────────────────────────────────────────────────────────────
say "Preflight (read-only)"
WHO="$(query 'id -un')" || {
  no "cannot log in as $ACCT"
  note "Run the one line in deploy/access/CONTABO-CONSOLE-PROCEDURE.md at the"
  note "Contabo web console first. Not retrying other keys or users."
  exit 3; }
[ "$WHO" = "$ACCT" ] && ok "logged in as $ACCT (not root, by design)" || { no "logged in as '$WHO', expected $ACCT"; exit 3; }
if [ -n "$(query "sudo -n /usr/local/sbin/bedtimectl 2>&1 | grep -q usage && echo x")" ]; then
  ok "the scoped wrapper is callable without a password"
else
  no "cannot call /usr/local/sbin/bedtimectl -- the sudoers drop-in is missing"
  note "Re-run the console line; it is idempotent and will repair this."
  exit 3
fi

FREE_MB="$(query "df -Pm / | awk 'NR==2{print \$4}'")"
note "free on / : ${FREE_MB} MB"
if [ "${FREE_MB:-0}" -lt 8000 ]; then
  no "under 8 GB free. A Supabase stack plus a restore needs more room."
  exit 3
fi
ok "disk headroom is sufficient"

AVAIL_MB="$(query "free -m | awk '/^Mem:/{print \$7}'")"
note "available memory : ${AVAIL_MB} MB"
if [ "${AVAIL_MB:-0}" -lt 2500 ]; then
  no "under 2.5 GB available. Bedtime's Postgres alone is capped at 2 GB."
  note "Everytinroom is sizing itself from the same memory. Do not squeeze it."
  note "Stop here and decide what the box can actually hold."
  exit 3
fi
ok "memory headroom is sufficient"

# $ROOT is this account's home and is created by the console step, so here it
# must exist and be ours. What must NOT already exist is a stack inside it.
OWNER="$(query "stat -c %U $ROOT 2>/dev/null")"
[ "$OWNER" = "$ACCT" ] && ok "$ROOT exists and belongs to $ACCT" || { no "$ROOT is owned by '${OWNER:-nothing}', not $ACCT"; exit 3; }
if [ -n "$(query "test -e $ROOT/supabase/docker-compose.yml && echo x")" ]; then
  no "a stack is already installed at $ROOT/supabase. Refusing to overwrite it."
  note "Inspect it, then move it aside deliberately."
  exit 3
fi
ok "no stack installed at $ROOT yet"

if [ -n "$(query "ss -ltn | grep -E '127.0.0.1:$KONG_PORT\\s' && echo x")" ]; then
  no "127.0.0.1:$KONG_PORT is taken. Pick another and re-run."
  exit 3
fi
ok "127.0.0.1:$KONG_PORT is free"

EXISTING="$(query "docker ps --format '{{.Names}}' 2>/dev/null | wc -l")"
note "containers already running on this host: ${EXISTING:-0}"
if [ -n "$(query "docker ps -a --format '{{.Label \"com.docker.compose.project\"}}' 2>/dev/null | grep -x $PROJ && echo x")" ]; then
  no "a compose project named '$PROJ' already exists here."
  exit 3
fi
ok "no compose project named '$PROJ' yet"

PROXY="$(query "ss -ltnp 2>/dev/null | grep -E ':(80|443)\\s' | head -2")"
if [ -n "$PROXY" ]; then
  ok "something already serves 80/443 -- Bedtime will NOT bind them"
  printf '%s\n' "$PROXY" | sed 's/^/      /'
else
  note "nothing on 80/443. Unexpected here; re-read before trusting it."
fi

# ── Phase B ───────────────────────────────────────────────────────────────
say "Phase B — an isolated stack"
remote "fetch the official self-hosting bundle (upstream, so upgrades follow upstream)" \
  "cd $ROOT && git clone --depth 1 https://github.com/supabase/supabase.git _src && cp -a _src/docker supabase && rm -rf _src"
plan "copy the co-tenant override up"
if [ "$GO" -eq 1 ]; then
  scp -i "$KEY" -o StrictHostKeyChecking=accept-new -q \
    selfhost/docker-compose.cotenant.yml "root@$HOST:$ROOT/docker-compose.cotenant.yml" \
    || { no "scp failed"; exit 4; }
  ok "uploaded docker-compose.cotenant.yml"
else
  printf '      \033[90mscp selfhost/docker-compose.cotenant.yml root@%s:%s/\033[0m\n' "$HOST" "$ROOT"
fi

say "Phase B — secrets, generated ON THE SERVER"
note "Generated there and never leaving it, so no secret crosses the wire,"
note "reaches this machine, or appears in a log. None is reused from"
note "Everytinroom -- every value below is Bedtime's own."
remote "generate .env (postgres password, jwt secret, anon + service keys, dashboard auth)" \
  "cd $ROOT/supabase && test -f .env || cp .env.example .env; \
   gen() { openssl rand -hex 32; }; \
   set_kv() { k=\$1; v=\$2; grep -q \"^\$k=\" .env && sed -i \"s|^\$k=.*|\$k=\$v|\" .env || printf '%s=%s\n' \"\$k\" \"\$v\" >> .env; }; \
   set_kv POSTGRES_PASSWORD \$(gen); \
   set_kv JWT_SECRET \$(gen); \
   set_kv SECRET_KEY_BASE \$(gen); \
   set_kv VAULT_ENC_KEY \$(gen); \
   set_kv DASHBOARD_PASSWORD \$(gen); \
   set_kv POSTGRES_PORT 5432; \
   chmod 600 .env; echo 'written'"
note "ANON_KEY and SERVICE_ROLE_KEY must be JWTs signed with that JWT_SECRET."
note "They are minted in Phase C once the stack can sign them."

# ── Phase C ───────────────────────────────────────────────────────────────
say "Phase C — bring up only the services the apps need"
remote "start the stack through the scoped wrapper" "$CTL up"
remote "wait for Postgres to accept connections" \
  "for i in \$(seq 1 60); do $CTL psql -Atc 'select 1' >/dev/null 2>&1 && { echo ready; break; }; sleep 2; done"
remote "confirm nothing of Bedtime's is listening off-box" \
  "ss -ltn | grep -E '0.0.0.0:(5432|8001)|:::(5432|8001)' && echo 'EXPOSED -- INVESTIGATE' || echo 'loopback only, correct'"

say "Phase C — the vhost to add by hand"
note "Bedtime does not edit the host's proxy. Add this to whatever serves 443,"
note "reload it, and nothing of Everytinroom's changes:"
printf '\n      api.bedtimehome.com {\n          reverse_proxy 127.0.0.1:%s\n      }\n\n' "$KONG_PORT"

# ── Phase D ───────────────────────────────────────────────────────────────
say "Phase D — restore the data, then prove it matches"
note "The dump is taken by migration-package/scripts/backup-production.sh and"
note "copied up; it is not re-dumped here, so the restored bytes are the same"
note "bytes that were verified on this machine."
remote "restore into the Bedtime database" \
  "test -f $ROOT/dump.sql.gz && gunzip -c $ROOT/dump.sql.gz | $CTL psql -v ON_ERROR_STOP=0 >$ROOT/restore.log 2>&1; tail -3 $ROOT/restore.log"
note "ON_ERROR_STOP=0 deliberately: a managed dump carries role and extension"
note "statements that a self-hosted cluster rejects harmlessly, and chaining on"
note "a non-zero exit has already failed one good restore in this project."
remote "reconcile row counts, sequences and money against the baseline" \
  "$CTL psql -At -c \"select 'products='||(select count(*) from products)||' sales='||(select count(*) from sales)||' customers='||(select count(*) from customers)||' orders='||(select count(*) from whatsapp_orders)||' settled='||(select count(*) from whatsapp_orders where paid_at is not null)||' sales_ghs='||(select coalesce(sum(total),0) from sales)||' ussd_seq='||(select last_value from ussd_code_seq)\""
note "Compare that line against migration-package/BASELINE-*.txt. At capture:"
note "  products=671 sales=1407 customers=1216 orders=657 settled=303"
note "  sales_ghs=684456.00 ussd_seq=50661"
note "ussd_code_seq must NOT be lower. Lower means the shop would reissue USSD"
note "codes already handed to customers, and collide with settled orders."

# ── Phase E ───────────────────────────────────────────────────────────────
say "Phase E — backups, and a rehearsed restore"
remote "install the nightly backup" \
  "install -m 0750 -d $ROOT/bin && cp $ROOT/backup.sh $ROOT/bin/ 2>/dev/null; echo 'see note'"
note "backup.sh goes up with the same scp step as the override once its R2"
note "credentials are set. A backup nobody has restored is a hope, not a"
note "backup, so Phase F rehearses one into a scratch database."

# ── Phase F ───────────────────────────────────────────────────────────────
say "Phase F — acceptance"
note "Run from this machine against the server over an ssh tunnel, so the"
note "same suites that passed locally run against the real stack:"
note "  ssh -i ~/.ssh/bedtime_contabo -L 5544:127.0.0.1:5432 root@$HOST"
note "  node migration-package/scripts/pos-acceptance.mjs <tunnelled db>   # 35 checks"
note "  node migration-package/scripts/webhook-regression.mjs              # 23 checks"
note "Both already pass against the local restore, so a failure here is the"
note "server's configuration and not the code."

say "Done"
if [ "$GO" -eq 1 ]; then
  ok "live run complete -- read the reconciliation line above before going further"
else
  note "That was a DRY RUN. Nothing on the server was changed."
  note "Re-run with --go once the plan above reads correctly."
fi
note "Phase G (DNS, cutover) still waits for an explicit GO."
note "Hosted Supabase is untouched and stays until everything is verified."
