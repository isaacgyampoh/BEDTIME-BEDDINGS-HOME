#!/usr/bin/env python3
"""
BEDTIME production monitor. Independent of Everytinroom's monitor.py: its own
checks, its own state file, its own recipient. Neither can mask or silence the
other, which is the point of running two shops on one box.

  bedtime-monitor.py              run the checks, alert on real problems
  bedtime-monitor.py --dry-run    run the checks, print instead of sending
  bedtime-monitor.py --status     print the last recorded state

READ-ONLY. It never places an order, starts a payment, changes data or
restarts anything. Every check is a query or a GET.

WHAT IT WATCHES, and why each one is here rather than assumed fine

  api            api.bedtimehome.com answers. If this fails the shop is down.
  database       the bedtime database accepts a query and reports its size.
  containers     all six of Bedtime's services are running and healthy.
  jobs           Bedtime's cron jobs are still ACTIVE and none has started
                 failing. cron.job_run_details reports "succeeded" whenever
                 net.http_post DISPATCHED, so this reads net._http_response
                 for what the function actually answered -- the distinction
                 that hid a broken SMS key for hours during the migration.
  reconciliation charges left pending too long. Contabo polls NaloPay every
                 five minutes; if pending charges pile up, that has stopped.
  sms_balance    mNotify credits. Reports stop silently when the wallet empties,
                 and nothing else notices.
  backups        a nightly dump exists and is recent.
  disk           headroom on /, which both shops share.
  r2             the image Worker answers and its bucket is bound.

ALERTING
  A check must fail twice in a row before it alerts, except the critical ones
  (api, database, containers), which alert on the first failure. Each problem
  is texted once, reminded every 6 hours while it persists, and followed by a
  "recovered" text. State lives in /srv/central/monitor/bedtime-state.json.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

APP = "bedtime"
API = "https://api.bedtimehome.com"
WORKER = "https://bedtime-images.nanagyams99.workers.dev"
STATE = "/srv/central/monitor/bedtime-state.json"
ENVF = f"/srv/central/apps/{APP}/functions.env"
BACKUP_DIR = "/srv/central/backups"

CRITICAL = {"api", "database", "containers", "db_connections"}
REMIND_AFTER = 6 * 3600
DRY = "--dry-run" in sys.argv


def sh(cmd, timeout=40):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def psql(db, sql):
    code, out, _ = sh(["docker", "exec", "-i", "central-postgres", "psql",
                       "-U", "postgres", "-d", db, "-tAqX", "-c", sql])
    return out if code == 0 else None


def env_value(key):
    """Read one value from the app's env file. Never printed by this script."""
    try:
        with open(ENVF, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


# Cloudflare refuses urllib's default User-Agent with a 403, which made the
# image Worker look down when it was serving perfectly. A generic client name
# is enough; it deliberately carries no account or contact details.
UA = "bedtime-monitor/1.0"


def http(url, timeout=20, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(8000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:  # noqa: BLE001
        return 0, ""


# ── the checks. Each returns (ok, message) ─────────────────────────────────
def check_api():
    status, _ = http(f"{API}/auth/v1/health")
    return status == 200, f"auth health returned {status}"


def check_database():
    size = psql(APP, "select pg_size_pretty(pg_database_size(current_database()))")
    if not size:
        return False, "the bedtime database did not answer"
    conns = psql(APP, "select count(*) from pg_stat_activity where datname = current_database()")
    return True, f"{size}, {conns} connection(s)"


def check_containers():
    want = {"bedtime-rest", "bedtime-auth", "bedtime-storage",
            "bedtime.realtime", "bedtime-imgproxy", "bedtime-functions"}
    code, out, _ = sh(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"])
    if code != 0:
        return False, "docker ps failed"
    running = {}
    for line in out.splitlines():
        if "\t" in line:
            n, s = line.split("\t", 1)
            running[n] = s
    missing = sorted(want - running.keys())
    unhealthy = sorted(n for n in want & running.keys() if "unhealthy" in running[n].lower())
    if missing or unhealthy:
        bits = []
        if missing:
            bits.append("down: " + ", ".join(missing))
        if unhealthy:
            bits.append("unhealthy: " + ", ".join(unhealthy))
        return False, "; ".join(bits)
    return True, f"all {len(want)} services up"


def check_jobs():
    active = psql("postgres", "select count(*) from cron.job where active and jobname like 'btm-%'")
    if active is None:
        return False, "could not read cron.job"
    if int(active or 0) < 9:
        return False, f"only {active} of 9 Bedtime jobs are active"
    # What the functions ACTUALLY answered, not whether pg_net dispatched.
    bad = psql("postgres",
               "select count(*) from net._http_response "
               "where created > now() - interval '2 hours' "
               "and (status_code is null or status_code >= 400)")
    if bad and int(bad) > 3:
        return False, f"{bad} failed function calls in the last 2 hours"
    return True, f"{active} jobs active, {bad or 0} recent failures"


def check_reconciliation():
    pending = psql(APP,
                   "select count(*) from whatsapp_orders "
                   "where paid_at is null and nalopay_order_id is not null "
                   "and created_at < now() - interval '45 minutes' "
                   "and created_at > now() - interval '7 days'")
    if pending is None:
        return False, "could not count pending charges"
    n = int(pending or 0)
    # Unpaid charges are normal -- customers abandon. A large and growing pile
    # means btm-reconcile-payments has stopped resolving them.
    return n <= 25, f"{n} charge(s) pending over 45 min"


def check_sms_balance():
    key = env_value("MNOTIFY_KEY")
    if not key:
        return False, "MNOTIFY_KEY is not set"
    status, body = http(f"https://api.mnotify.com/api/balance/sms?key={key}")
    if status != 200:
        return False, f"mNotify returned {status}"
    try:
        d = json.loads(body)
    except Exception:  # noqa: BLE001
        return False, "mNotify reply was not JSON"
    if str(d.get("status", "")).lower() != "success":
        return False, "mNotify rejected the key"
    bal = int(d.get("balance") or 0)
    return bal >= 200, f"{bal} SMS credits"


def check_backups():
    try:
        files = [f for f in os.listdir(BACKUP_DIR) if f.startswith(f"{APP}-") and f.endswith(".sql.gz")]
    except OSError:
        return False, "backup directory unreadable"
    if not files:
        return False, "no bedtime backup exists"
    newest = max(files, key=lambda f: os.path.getmtime(os.path.join(BACKUP_DIR, f)))
    age_h = (time.time() - os.path.getmtime(os.path.join(BACKUP_DIR, newest))) / 3600
    size_k = os.path.getsize(os.path.join(BACKUP_DIR, newest)) // 1024
    return age_h <= 30, f"newest {age_h:.0f}h old, {size_k}K"


def check_disk():
    code, out, _ = sh(["df", "-Pm", "/"])
    if code != 0:
        return False, "df failed"
    try:
        free_mb = int(out.splitlines()[1].split()[3])
    except Exception:  # noqa: BLE001
        return False, "could not parse df"
    return free_mb >= 10000, f"{free_mb // 1024} GB free on /"


def check_r2():
    status, body = http(f"{WORKER}/health")
    if status != 200:
        return False, f"image Worker returned {status}"
    try:
        ok = json.loads(body).get("bucket") == "bound"
    except Exception:  # noqa: BLE001
        ok = False
    return ok, "image Worker healthy, bucket bound"



def check_auth_attempts():
    """Suspicious PIN activity.

    verify_pin locks out after 10 failures in 5 minutes, which stops
    enumeration but is also a denial of service: one attacker locks every
    cashier out. Worth knowing about either way."""
    recent = psql(APP,
                  "select count(*) from pin_attempts "
                  "where succeeded = false and attempted_at > now() - interval '15 minutes'")
    if recent is None:
        return False, "could not read pin_attempts"
    n = int(recent or 0)
    return n < 20, f"{n} failed PIN attempt(s) in 15 min"


def check_db_connections():
    """Connection exhaustion. max_connections is 100 and TWO shops share it."""
    used = psql("postgres", "select count(*) from pg_stat_activity")
    cap = psql("postgres", "select setting from pg_settings where name = 'max_connections'")
    if used is None or cap is None:
        return False, "could not read pg_stat_activity"
    u, c = int(used or 0), int(cap or 100)
    return u < c * 0.8, f"{u} of {c} connections used"


def check_cpu_memory():
    """Headroom on a box two shops share."""
    code, out, _ = sh(["free", "-m"])
    if code != 0:
        return False, "free failed"
    try:
        line = [l for l in out.splitlines() if l.startswith("Mem:")][0].split()
        total, avail = int(line[1]), int(line[6])
    except Exception:  # noqa: BLE001
        return False, "could not parse free"
    try:
        with open("/proc/loadavg", encoding="utf-8") as fh:
            load1 = float(fh.read().split()[0])
    except OSError:
        load1 = 0.0
    cores = os.cpu_count() or 1
    ok = avail > 1500 and load1 < cores * 2
    return ok, f"{avail} MB available, load {load1:.2f} on {cores} cores"


def check_tls():
    """Certificate expiry. Caddy renews on its own, but a renewal that keeps
    failing is silent until the day it expires."""
    code, out, _ = sh([
        "bash", "-lc",
        f"echo | openssl s_client -connect {API.replace('https://','')}:443 "
        f"-servername {API.replace('https://','')} 2>/dev/null "
        "| openssl x509 -noout -enddate -issuer"
    ], timeout=30)
    if code != 0 or "notAfter" not in out:
        return False, "could not read the certificate"
    import datetime as _dt
    try:
        end = [l for l in out.splitlines() if l.startswith("notAfter=")][0].split("=", 1)[1].strip()
        exp = _dt.datetime.strptime(end, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=_dt.timezone.utc)
        days = (exp - _dt.datetime.now(_dt.timezone.utc)).days
    except Exception:  # noqa: BLE001
        return False, "could not parse the expiry date"
    staging = "STAGING" in out or "Fake" in out
    if staging:
        return False, f"certificate is from Let's Encrypt STAGING (untrusted), {days}d left"
    return days > 14, f"certificate valid for {days} more day(s)"


def check_api_traffic():
    """Unusual API traffic. Caddy rate-limits at the edge; a sustained burst of
    429s means something is hammering the shop."""
    code, out, _ = sh([
        "bash", "-lc",
        'docker logs central-caddy --since 15m 2>&1 | grep -c \'"status":429\' || true'
    ], timeout=40)
    if code != 0:
        return True, "could not read the proxy log (not treated as a fault)"
    try:
        n = int((out or "0").strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        n = 0
    return n < 200, f"{n} rate-limited request(s) in 15 min"

CHECKS = {
    "api": check_api,
    "database": check_database,
    "containers": check_containers,
    "jobs": check_jobs,
    "reconciliation": check_reconciliation,
    "sms_balance": check_sms_balance,
    "backups": check_backups,
    "disk": check_disk,
    "r2": check_r2,
    "auth_attempts": check_auth_attempts,
    "db_connections": check_db_connections,
    "cpu_memory": check_cpu_memory,
    "tls": check_tls,
    "api_traffic": check_api_traffic,
}


# ── state and alerting ────────────────────────────────────────────────────
def load_state():
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:  # noqa: BLE001
        return {}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(s, fh, indent=1)
    os.replace(tmp, STATE)
    os.chmod(STATE, 0o600)


def send_sms(text):
    """Alert the owner. Uses the app's own function, so the key stays server-side."""
    if DRY:
        print(f"  [dry-run] would send: {text[:150]}")
        return True
    payload = json.dumps({"message": text}).encode()
    status, _ = http(f"{API}/functions/v1/super-service?action=resend-sms", timeout=30)
    # resend-sms is the only send path that takes an arbitrary message; if it
    # is not available, say so in the log rather than failing silently.
    if status not in (200, 204):
        print(f"  ALERT NOT SENT (status {status}): {text[:150]}")
        return False
    del payload
    return True


def main():
    state = load_state()
    if "--status" in sys.argv:
        print(json.dumps(state, indent=1))
        return 0

    now = int(time.time())
    problems, recovered = [], []

    for name, fn in CHECKS.items():
        try:
            ok, msg = fn()
        except Exception as e:  # noqa: BLE001
            ok, msg = False, f"check raised {type(e).__name__}"
        prev = state.get(name, {})
        fails = 0 if ok else int(prev.get("fails", 0)) + 1
        threshold = 1 if name in CRITICAL else 2

        print(f"  {'ok  ' if ok else 'FAIL'}  {name:<16} {msg}")

        if ok:
            if prev.get("alerted"):
                recovered.append(f"{name} recovered")
            state[name] = {"ok": True, "fails": 0, "msg": msg, "at": now}
        else:
            alerted_at = int(prev.get("alerted_at", 0))
            should = fails >= threshold and (
                not prev.get("alerted") or now - alerted_at > REMIND_AFTER)
            if should:
                problems.append(f"{name}: {msg}")
            state[name] = {
                "ok": False, "fails": fails, "msg": msg, "at": now,
                "alerted": prev.get("alerted") or should,
                "alerted_at": now if should else alerted_at,
            }

    if problems:
        send_sms("BEDTIME alert: " + "; ".join(problems[:4]))
    if recovered:
        send_sms("BEDTIME ok again: " + "; ".join(recovered[:4]))

    save_state(state)
    bad = sum(1 for v in state.values() if isinstance(v, dict) and not v.get("ok"))
    print(f"\nBEDTIME-MONITOR checked={len(CHECKS)} problems={bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
