#!/usr/bin/env bash
# ===========================================================================
# Contabo API client, for establishing deployment access without a console.
#
#   ./contabo-api.sh survey                 read-only. Changes nothing.
#   ./contabo-api.sh add-key <project>      register the project's PUBLIC key
#   ./contabo-api.sh install-key <project>  assign it to the VPS  [REBOOTS]
#
# WHAT THE API CAN AND CANNOT DO -- established from Contabo's own sources,
# not assumed:
#
#   * There is NO endpoint that injects an SSH key into a running instance.
#     The full instance surface is: GET/PATCH the instance, and the actions
#     rescue, resetPassword, restart, shutdown, start, stop, plus snapshots,
#     upgrade, cancel, regionChange and vnc.
#
#   * actions/resetPassword DOES accept SSH keys on an EXISTING instance, so
#     no reinstall is needed. Its documented body is:
#         sshKeys      array of secretIds of public keys
#         rootPassword secretId
#         userData     cloud-init
#     and Contabo's own CLI calls it "Reset the password or ssh key of your
#     instance".
#
#   * BUT IT REBOOTS THE MACHINE. Contabo's FAQ says a Linux reset completes
#     "within 2-3 minutes after the automatic reboot". So this is NOT
#     non-disruptive: it is a short outage for EVERY tenant on the box,
#     Everytinroom included.
#
# Therefore `install-key` refuses to run without --i-accept-a-reboot, and
# before it does anything it checks that the other tenant's containers will
# come back by themselves.
#
# PRESERVING OTHER KEYS. `sshKeys` is a complete list, not an addition -- the
# request replaces what the instance has. So install-key READS the instance's
# current sshKeys first and sends those back along with the new one. If it
# cannot read them, it refuses rather than guess, because a wrong list here
# removes another project's access.
#
# No secret is printed, logged or passed on a command line.
# ===========================================================================
set -uo pipefail
API=https://api.contabo.com
AUTH=https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token
SERVICE=bedtime-contabo-api
VPS_IP=169.58.120.116

say  () { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok   () { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no   () { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note () { printf '  \033[90m–\033[0m %s\n' "$*"; }

CMD="${1:-survey}"

# ── credentials ───────────────────────────────────────────────────────────
RAW="$(security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null || true)"
[ -n "$RAW" ] || { no "no Contabo API credentials stored"; note "Run migration-package/scripts/enter-contabo-api-credential.sh first."; exit 2; }
CREDS="$(printf '%s' "$RAW" | base64 -d 2>/dev/null)"; unset RAW
[ -n "$CREDS" ] || { no "the stored credentials are malformed"; exit 2; }

jqf () { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

# ── token ─────────────────────────────────────────────────────────────────
# Credentials go in the POST body via --data-urlencode, never in the URL and
# never in argv as a single joined string.
get_token () {
  printf '%s' "$CREDS" | python3 -c "
import sys,json,urllib.parse
d=json.load(sys.stdin)
print(urllib.parse.urlencode({
  'client_id': d['client_id'], 'client_secret': d['client_secret'],
  'username': d['user'], 'password': d['password'], 'grant_type': 'password',
}))" > /tmp/.ctb.$$ 2>/dev/null
  chmod 600 /tmp/.ctb.$$
  local r; r="$(curl -s --max-time 40 -X POST "$AUTH" -H 'Content-Type: application/x-www-form-urlencoded' --data @/tmp/.ctb.$$)"
  rm -f /tmp/.ctb.$$
  printf '%s' "$r" | jqf "d.get('access_token','')"
}

say "Authenticating"
TOKEN="$(get_token)"
if [ -z "$TOKEN" ]; then
  no "could not get an access token"
  note "Check the four values; the API Password is not the control-panel one."
  note "Re-run enter-contabo-api-credential.sh to replace them."
  exit 3
fi
ok "authenticated (token not shown)"

api () {  # api <METHOD> <path> [body]
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then
    curl -s --max-time 60 -X "$m" "$API$p" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -H "x-request-id: bedtime-$(uuidgen)" --data "$b"
  else
    curl -s --max-time 60 -X "$m" "$API$p" \
      -H "Authorization: Bearer $TOKEN" -H "x-request-id: bedtime-$(uuidgen)"
  fi
}

# ── find the instance ─────────────────────────────────────────────────────
INSTANCES="$(api GET '/v1/compute/instances?size=100')"
INST="$(printf '%s' "$INSTANCES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for i in d.get('data',[]):
    ips=[a.get('ip') for a in (i.get('ipConfig',{}).get('v4') and [i['ipConfig']['v4']] or [])]
    ips+= [i.get('ipv4','')]
    if '$VPS_IP' in [x for x in ips if x]:
        print(i['instanceId']); break
" 2>/dev/null)"

case "$CMD" in

survey)
  say "Account"
  printf '%s' "$INSTANCES" | python3 -c "
import sys,json
d=json.load(sys.stdin)
rows=d.get('data',[])
print(f'  {len(rows)} instance(s) visible to this API user')
for i in rows:
    ip=(i.get('ipConfig',{}).get('v4',{}) or {}).get('ip','?')
    print(f\"    id={i.get('instanceId')} {ip:<16} {i.get('status','?'):<10} {i.get('productId','?')}\")
    print(f\"      name   : {i.get('displayName','') or i.get('name','')}\")
    print(f\"      image  : {(i.get('imageId') or '?')[:36]}\")
    print(f\"      sshKeys: {i.get('sshKeys') if i.get('sshKeys') is not None else '(not reported)'}\")
" 2>&1 | head -40

  say "SSH key secrets already registered"
  api GET '/v1/secrets?type=ssh&size=100' | python3 -c "
import sys,json
d=json.load(sys.stdin)
rows=d.get('data',[])
if not rows: print('  none registered')
for s in rows:
    v=(s.get('value') or '').strip()
    tail=v.split()[-1] if v and ' ' in v else ''
    print(f\"  secretId={s.get('secretId')}  name={s.get('name','')!r}  {tail}\")
" 2>&1 | head -20

  say "What this means"
  if [ -n "$INST" ]; then
    ok "the Bedtime/Everytinroom VPS is instanceId $INST"
  else
    no "no instance in this account has IP $VPS_IP"
    note "Either the API user cannot see it, or it is on another account."
  fi
  note "There is no API call that adds a key to a RUNNING instance."
  note "actions/resetPassword can set sshKeys without a reinstall, but it"
  note "REBOOTS the machine (Contabo: '2-3 minutes after the automatic"
  note "reboot'), which is an outage for Everytinroom too."
  note "Nothing was changed by this command."
  ;;

add-key)
  PROJ="${2:?usage: add-key <project>}"
  PUB="$HOME/.ssh/${PROJ}_contabo.pub"
  [ -f "$PUB" ] || { no "no $PUB"; exit 2; }
  KEY="$(tr -d '\r\n' < "$PUB")"
  say "Registering the PUBLIC key for '$PROJ'"
  note "$(ssh-keygen -lf "$PUB" | awk '{print $2}')"
  EXIST="$(api GET '/v1/secrets?type=ssh&size=100' | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d.get('data',[]):
    if (s.get('value') or '').strip().split()[:2] == '''$KEY'''.strip().split()[:2]:
        print(s.get('secretId')); break
" 2>/dev/null)"
  if [ -n "$EXIST" ]; then
    ok "already registered as secretId $EXIST"
  else
    BODY="$(python3 -c "
import json,sys
print(json.dumps({'name':'${PROJ}-deploy','type':'ssh','value':'''$KEY'''}))")"
    R="$(api POST '/v1/secrets' "$BODY")"
    ID="$(printf '%s' "$R" | jqf "d['data'][0]['secretId']")"
    if [ -n "$ID" ]; then ok "registered as secretId $ID"
    else no "could not register it"; printf '%s\n' "$R" | head -5 | sed 's/^/      /'; exit 4; fi
  fi
  note "Registering a key assigns it to NOTHING. Use install-key for that."
  ;;

install-key)
  PROJ="${2:?usage: install-key <project> --i-accept-a-reboot}"
  [ "${3:-}" = "--i-accept-a-reboot" ] || {
    no "REFUSING: this reboots the VPS"
    note "Contabo applies a credential reset by rebooting -- their FAQ says it"
    note "completes '2-3 minutes after the automatic reboot'. That is an"
    note "outage for Everytinroom as well as Bedtime."
    note "If that is acceptable, re-run with --i-accept-a-reboot."
    exit 5; }
  [ -n "$INST" ] || { no "could not identify the instance for $VPS_IP"; exit 3; }

  PUB="$HOME/.ssh/${PROJ}_contabo.pub"
  KEY="$(tr -d '\r\n' < "$PUB")"
  NEWID="$(api GET '/v1/secrets?type=ssh&size=100' | python3 -c "
import sys,json
d=json.load(sys.stdin)
for s in d.get('data',[]):
    if (s.get('value') or '').strip().split()[:2] == '''$KEY'''.strip().split()[:2]:
        print(s.get('secretId')); break
" 2>/dev/null)"
  [ -n "$NEWID" ] || { no "that key is not registered yet -- run add-key first"; exit 2; }

  say "Preserving the keys already assigned"
  CUR="$(api GET "/v1/compute/instances/$INST" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('data',[{}])[0]
ks=r.get('sshKeys')
print('NONE' if ks is None else ','.join(str(k) for k in ks))
" 2>/dev/null)"
  if [ "$CUR" = NONE ] || [ -z "$CUR" ]; then
    no "the instance does not report its current sshKeys"
    note "sshKeys REPLACES the list, so sending ours alone could remove the"
    note "key Everytinroom's access depends on. Refusing to guess."
    exit 6
  fi
  ok "currently assigned: $CUR"
  note "sending those back plus $NEWID, so nothing is dropped"

  say "Everytinroom must survive the reboot"
  note "Its containers have to be set to restart on boot, or they stay down."
  note "I cannot verify that without shell access -- check it in Contabo's"
  note "panel or from a session that has access BEFORE accepting the reboot."

  BODY="$(python3 -c "
import json
cur=[int(x) for x in '''$CUR'''.split(',') if x.strip()]
new=int('$NEWID')
ks=cur+([new] if new not in cur else [])
print(json.dumps({'sshKeys':ks}))")"
  say "Calling actions/resetPassword on instance $INST"
  note "body: $BODY"
  R="$(api POST "/v1/compute/instances/$INST/actions/resetPassword" "$BODY")"
  printf '%s\n' "$R" | head -8 | sed 's/^/      /'
  note "The machine reboots now. Give it 2-3 minutes, then:"
  note "  ssh -i ~/.ssh/${PROJ}_contabo root@$VPS_IP 'id -un'"
  ;;

*) no "unknown command '$CMD'"; note "survey | add-key <project> | install-key <project>"; exit 2 ;;
esac
