#!/usr/bin/env python3
"""
Fix two faults in /srv/central/scripts/health.sh.

1. The PostgREST probe joins central_edge and resolves "<dns>-rest". Since
   applications moved to their own per-app networks (2026-11-24), a new
   application's rest container is NOT on central_edge, so the probe cannot
   resolve it and reports a failure for a service that is serving perfectly.
   Everytinroom is still attached to central_edge as well, which is why only
   the newer application fails -- the same invisible gap as the missing
   `docker network create`.

2. `... || echo 000` concatenates with curl's own "000" on failure, so the
   message read "PostgREST returned HTTP 000000".

Idempotent: re-running makes no further change.
"""
import io
import sys

P = "/srv/central/scripts/health.sh"
s = io.open(P, encoding="utf-8").read()

if "app_${dns}_edge" in s:
    print("  already patched; nothing to do")
    sys.exit(0)

OLD = '''  # PostgREST, from inside the network, so this works before DNS exists.
  code="$(docker run --rm --network central_edge curlimages/curl:8.11.1 \\
    -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${dns}-rest:3000/" 2>/dev/null || echo 000)"'''

NEW = '''  # PostgREST, from inside the network, so this works before DNS exists.
  #
  # Which network, though. Applications used to share central_edge; since
  # 2026-11-24 each has its own app_<dns>_edge, and a newer application's rest
  # container is NOT on central_edge at all. Probing the shared network
  # therefore reported a perfectly healthy PostgREST as unreachable, because
  # the name could not be resolved rather than because nothing answered.
  # Everytinroom is attached to both, which is why only the newer application
  # failed.
  probe_net="central_edge"
  if docker network inspect "app_${dns}_edge" >/dev/null 2>&1; then
    probe_net="app_${dns}_edge"
  fi
  # No `|| echo 000` here: curl already prints 000 when it cannot connect, and
  # the fallback concatenated with it to produce "HTTP 000000".
  code="$(docker run --rm --network "$probe_net" curlimages/curl:8.11.1 \\
    -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${dns}-rest:3000/" 2>/dev/null)"
  code="${code:-000}"'''

if s.count(OLD) != 1:
    print(f"  REFUSING: the probe block appears {s.count(OLD)} times, not once")
    sys.exit(2)

s = s.replace(OLD, NEW)
io.open(P, "w", encoding="utf-8").write(s)
print("  health.sh patched: probes the app's own edge network; 000000 fixed")
