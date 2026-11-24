#!/usr/bin/env python3
"""
Wire the three fixes into /srv/central/provision-app.sh.

Idempotent: it checks for its own markers and does nothing on a second run.
Run as root on the central server. The original is backed up by the caller.
"""
import io
import sys

P = "/srv/central/provision-app.sh"
s = io.open(P, encoding="utf-8").read()

if "ensure-app-networks.sh" in s:
    print("  already patched; nothing to do")
    sys.exit(0)

A1 = (
    "# ---------------------------------------------------------------------------\n"
    'step "Configuring application-specific services"\n'
    "# ---------------------------------------------------------------------------"
)
A2 = (
    "# ---------------------------------------------------------------------------\n"
    'step "Configuring the domain and HTTPS"\n'
    "# ---------------------------------------------------------------------------"
)
for name, a in (("services", A1), ("domain", A2)):
    if s.count(a) != 1:
        print(f"  REFUSING: the {name} anchor appears {s.count(a)} times, not once")
        sys.exit(2)

NET = '''# ---------------------------------------------------------------------------
step "Ensuring the application networks exist"
# ---------------------------------------------------------------------------
# app.compose.yml declares app_<dns>_db and app_<dns>_edge as EXTERNAL, and a
# comment there said this script created them. It did not: nothing under
# /srv/central ran `docker network create`. Everytinroom's predate the move
# off the shared central_db/central_edge, so the gap stayed invisible until
# the next application was provisioned -- Bedtime, which failed with
#
#   network app_bedtime_db declared as external, but could not be found
#
# and then auth and realtime crash-looped, because a plain `network connect`
# gives central-postgres none of the aliases those two images resolve
# ("postgres"). ensure-app-networks.sh creates both networks, attaches the
# shared Postgres with aliases postgres,db and the shared Caddy to the edge.
# It is idempotent, and attaching a running container does not restart it, so
# no other tenant is interrupted.
if [ "$DRY" = "1" ]; then
  dim "[dry-run] $HERE/scripts/ensure-app-networks.sh $NAME"
else
  "$HERE/scripts/ensure-app-networks.sh" "$NAME" \\
    || die "Could not prepare the application networks." \\
           "Run $HERE/scripts/ensure-app-networks.sh $NAME by hand to see why."
fi

'''

EDGE = '''# ---------------------------------------------------------------------------
step "Preparing scheduled-job support"
# ---------------------------------------------------------------------------
# pg_net's worker runs against ONE database (pg_net.database_name), so an HTTP
# request queued from an application's own database is NEVER SENT: nothing
# lands in net._http_response, no error is raised, and cron.job_run_details
# still reports "succeeded" because the dispatch did not fail. Any scheduled
# job that calls an edge function therefore has to live in that database.
#
# ensure-app-edge-caller.sh creates <app>_private.call_edge() there, pointing
# at the INTERNAL function address so jobs work before any DNS record exists
# and keep working after cutover, with the service key in one config row
# instead of inline in every job body -- where it would also be readable by
# anyone who can select from cron.job.
if [ "$WANT_FN" = "0" ]; then
  dim "no edge functions requested; nothing to call"
elif [ "$DRY" = "1" ]; then
  dim "[dry-run] $HERE/scripts/ensure-app-edge-caller.sh $NAME"
else
  "$HERE/scripts/ensure-app-edge-caller.sh" "$NAME" \\
    || warn "Could not create the edge caller. Scheduled jobs need it; run
         $HERE/scripts/ensure-app-edge-caller.sh $NAME once the stack is up."
fi

'''

s = s.replace(A1, NET + A1)
s = s.replace(A2, EDGE + A2)

# The closing summary already lists what is left to do by hand; add the DNS
# check so provisioning ends by saying whether HTTPS can work yet.
TAIL_ANCHOR = "    - create the DNS record"
if TAIL_ANCHOR in s:
    s = s.replace(
        TAIL_ANCHOR,
        "    - create the DNS record   (A, DNS-only/grey cloud -- a proxied\n"
        "                               record breaks the ACME challenge)",
        1,
    )

DNSCHK = '''
# A provisioning run that ends without saying whether the domain resolves
# leaves the next person to discover it as a 5-second function timeout.
if [ "$DRY" = "0" ] && [ -n "$DOMAIN" ]; then
  printf '\\n'
  "$HERE/scripts/check-app-dns.sh" "$DOMAIN" || true
fi
'''
if not s.rstrip().endswith("fi"):
    s = s.rstrip("\n") + "\n" + DNSCHK
else:
    s = s.rstrip("\n") + "\n" + DNSCHK

s = s.replace("STEP_TOTAL=11", "STEP_TOTAL=13", 1)

io.open(P, "w", encoding="utf-8").write(s)
print("  patched: 2 new steps + a closing DNS check, STEP_TOTAL 11 -> 13")
