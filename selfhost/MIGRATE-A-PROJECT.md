# Migrating a project onto the central Contabo platform

One procedure, distilled from Everytinroom and Bedtime. Every step is a script
that exists and has been run; the commentary is there because each line of it
was something that went wrong once.

Server: `169.58.120.116`, Ubuntu 24.04, 6 vCPU, 12 GB RAM, 193 GB disk.
Platform root: `/srv/central`. One shared `central-postgres` and one shared
`central-caddy`; one compose project per application.

---

## 0. Access — the step that cost the most time

**Ask the provider which key the server expects. Do not guess.**

```sh
migration-package/scripts/enter-contabo-api-credential.sh   # 4 OAuth2 values, hidden dialogs
migration-package/scripts/contabo-api.sh survey             # read-only
```

Bedtime lost days to four local keys with near-identical names, of which one
was authorized. The survey reads the instance's assigned `sshKeys` and ends
the question in seconds. Two things it taught:

- `x-request-id` must be a **bare lowercase uuid4**. A prefixed one returns
  400, and the error body still parses as JSON with no `data` key — which once
  read as "0 instances" and nearly sent the search to the wrong account.
- **The API cannot add a key to a running instance without a reboot.**
  `actions/resetPassword` does accept `sshKeys` with no reinstall, but Contabo
  applies it by rebooting, which is an outage for every tenant. `sshKeys` also
  *replaces* the list, so any such call must send the existing secretIds back.

Then give the project its own scoped account. One line, typed at the provider's
web console if no key works (a console login goes through PAM, not sshd, so the
root password still works there while SSH stays publickey-only):

```sh
curl -fsSL https://bedtime-images.nanagyams99.workers.dev/da/<project>|bash
```

Register the project's public key in `DEPLOY_KEYS` in `r2/wrangler.toml` first
and redeploy the Worker. The installer creates `<project>-deploy` with **no
password, no docker group and no general sudo** — only one root-owned wrapper
via a `visudo -c`-validated sudoers drop-in. It never opens root's
`authorized_keys`. The docker group is root-equivalent, whatever the name
suggests: anyone who can reach the socket can mount the host filesystem and
read another tenant's database.

Revoking one project cannot affect another:
`userdel -r <project>-deploy && rm -f /etc/sudoers.d/60-<project>-deploy /usr/local/sbin/<project>ctl`

## 1. Provision

```sh
/srv/central/provision-app.sh --name <app> --domain api.<domain> \
  --realtime --auth --storage --functions --dry-run   # then without --dry-run
```

Pick the flags from what the apps actually call, not by habit:
`--auth` only if `auth.users` has rows (`scripts/inspect-supabase.py` counts
them). It is idempotent and never touches DNS, which is what makes it safe to
run while the old backend still serves.

It now runs `ensure-app-networks.sh` and `ensure-app-edge-caller.sh` itself
(steps 8 and 11 of 13), and ends with `check-app-dns.sh`. Before those were
added, provisioning the second application failed with
`network app_<x>_db declared as external, but could not be found`, and then
auth and realtime crash-looped because a plain `docker network connect` gives
`central-postgres` none of the aliases those images resolve (`postgres`, `db`).

## 2. DNS and TLS

```sh
migration-package/scripts/cloudflare-dns.sh token    # hidden dialog, token verified before storing
migration-package/scripts/cloudflare-dns.sh list     # read-only
migration-package/scripts/cloudflare-dns.sh create
```

`create` issues only `POST /dns_records` — there is no PUT, PATCH or DELETE in
that file — refuses if anything already answers for the name, and prints the
whole zone before and after.

**Proxy must be OFF (grey cloud).** Cloudflare's proxy serves its own
certificate and breaks Caddy's ACME challenge, so no certificate ever issues.

Caddy falls back to Let's Encrypt **staging** after repeated NXDOMAIN
failures, and a staging certificate is untrusted. It returns to production on
its own retry, which can be up to 30 minutes. Do not force it: the admin API
is deliberately off and the documented reload is
`docker compose restart caddy`, which blips **every** tenant.

### The gateway must answer CORS preflights for `/auth/v1/*`

```sh
python3 -I selfhost/central-fixes/patch-caddy-auth-cors.py   # then re-render + restart
```

**Hosted Supabase puts Kong in front of GoTrue, and Kong answers preflights.**
Replace Kong with Caddy and nothing does, so browser sign-in breaks — but only
after cutover, and never in a way that looks like auth.

GoTrue (v2.197.0) answers a preflight naming **any** request header —
`authorization`, `apikey`, even `content-type` — with a bare 204 and no
`Access-Control-*` headers. A preflight naming no headers is answered
correctly, which is why probing it casually suggests CORS is fine.

Two things in supabase-js then fail silently:

1. `setSession()` must `GET /auth/v1/user` to finish storing a session. Blocked,
   it returns an error and the session is **discarded**, so a login that
   succeeded server-side leaves the browser on the public anon key.
2. A refresh `POST`s `/auth/v1/token`. Blocked, **no session can ever renew**.

Bedtime ran eleven hours like this. The shop looked empty, not broken: reports
at GHS 0.00, no receipts, 487 denials on `whatsapp_orders`, and a cashier
entering a PIN 44 times. The database said it outright — 11 sessions, 11 refresh
tokens, **none ever used** — which is the check worth running after any cutover:

```sql
SELECT count(*) FILTER (WHERE revoked) AS refreshes_that_worked,
       count(*) AS tokens_issued FROM auth.refresh_tokens;
```

`refreshes_that_worked = 0` after a day of trading means sessions are not
renewing, whatever the login screen says. And verify the preflight itself, with
a header named, because without one it passes:

```sh
curl -sD- -o/dev/null -X OPTIONS "$API/auth/v1/user" \
  -H 'Origin: https://admin.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization,apikey' | grep -i access-control
```

No `access-control-allow-origin` in the reply is the fault.

## 3. Data

```sh
SUPABASE_DB_URL='postgresql://…' /srv/central/scripts/app-full-resync.sh <app> --go
```

**Never use a bare re-run of `migrate-from-supabase.sh` to sync.** Into a
populated database every `CREATE` collides and new rows are silently skipped;
it reports `MISMATCH` rather than lying, which is the only reason it gets
noticed. `app-full-resync.sh` drops and recreates `public` and then restores
the three things that drop destroys — each of which breaks the shop silently:

1. **`pgcrypto` and `uuid-ossp`.** `pg_net` is installed into `public` on
   Supabase, so the cascade removes them, and the dump carries no
   `CREATE EXTENSION`. `verify_pin()` compares with `crypt()`, so **every
   staff login fails** with nothing in the data to hint at why.
2. **The RLS tightening** (043/044/047). Without it the public anon key —
   which ships in every browser bundle — reads sales, customers and expenses.
3. **The retired agent tables**, which return with every dump until
   `pending/053` is applied at the source.

It refuses to finish if `ussd_code_seq` goes backwards, because that reissues
USSD codes already given to customers.

Carried by hand, because the dump covers `public` only: the `private` schema,
the scheduled jobs (captured to `cron-jobs.sql`, whose bodies hardcode the old
project URL), `storage.buckets`/`storage.objects` rows, and the image files.

## 4. Scheduled jobs

**pg_net's worker runs against one database** (`pg_net.database_name`). A
request queued from the app's own database is never sent: nothing in
`net._http_response`, no error, and `cron.job_run_details` still says
"succeeded" because the dispatch did not fail. So HTTP jobs live in that
database, prefixed, calling `<app>_private.call_edge()`:

```sql
SELECT cron.schedule('btm-sms-morning','0 8 * * 1-6',
  $$SELECT bedtime_private.call_edge('/sms-reports?type=morning')$$);
```

It is `net.http_post`, not `extensions.http_post`. Read
`net._http_response`, never `cron.job_run_details`, to learn what happened.

Deduplicate while migrating: Bedtime's 16 jobs were three stacked generations,
four of them calling a function that was not deployed — which is why those
four had sent nothing for months. Nine remain.

## 5. Images

```sh
wrangler r2 bucket create <app>-images
openssl rand -hex 32 | wrangler secret put UPLOAD_SECRET --config r2/wrangler.toml
wrangler deploy --config r2/wrangler.toml
SUPABASE_URL=… SUPABASE_ANON_KEY=… R2_WORKER_URL=… R2_UPLOAD_SECRET=… node r2/migrate.mjs
node r2/migrate.mjs --verify     # second, independent pass
```

The Worker reads through to the old origin on a miss and copies the file into
R2 in the background, so the migration cannot leave a hole and new uploads
keep working before the app is switched over. Browsers upload with the staff
member's own session, verified against the project's **published** ES256
JWKS — no secret in the browser and none in the Worker.

Store the old-shaped URL in the database and rewrite at render time
(`imageHost.js`). One shape everywhere, historical receipts keep working, and
rollback is a redeploy.

## 6. Cut over

```sh
# 1. stop the old backend writing -- both schedulers live at once IS split-brain
#    (a direct UPDATE on cron.job is refused; use alter_job, which keeps definitions)
#    SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE active;
# 2. final resync (step 3 above)
# 3. refresh the rollback baseline
#    pg_dump <app> | psql -d <app>_t0      # TEMPLATE refuses while services are connected
# 4. verify staff login AFTER the resync, not before
# 5. publish
VITE_SUPABASE_URL=https://api.<domain> VITE_SUPABASE_ANON_KEY=… \
VITE_IMAGE_HOST=https://<app>-images.<subdomain>.workers.dev ./scripts/deploy.sh both
```

Then make the old project **a forwarder**, not a corpse. Callbacks baked into
pre-cutover charges, and any provider endpoint you cannot reconfigure, still
arrive there — and the old function still works, which is the danger: it would
settle in a database nothing reads.
`release/paste-ready/super-service-FORWARDER.ts` passes everything to the new
API and returns the reply verbatim, so there is one source of truth and the
provider cannot tell. It needs no secret, because the callback already carries
`?s=` and that value is identical on both backends.

Also revoke the old project's public write access (`pending/054`): a customer
on a cached bundle could otherwise create orders and move stock there.

## 7. Prove the isolation

```sh
/srv/central/scripts/check-tenant-isolation.sh      # exit status = problem count
```

Nine-way checks across every application pair: database CONNECT privileges,
`<app>_private.call_edge` not PUBLIC-executable, the config table holding the
service key unreadable by other tenants, container-to-container unreachability
**with a positive control** so an "unreachable" result cannot be meaningless,
secret file modes, and whether anything is still on the shared networks.

## 8. Monitor

`scripts/<app>-monitor.py`, modelled on `bedtime-monitor.py`: its own checks,
its own state file, its own recipient, so two shops cannot mask each other.
Nine checks — api, database, containers, jobs, reconciliation, SMS balance,
backups, disk, R2 — alerting after two consecutive failures (one for api,
database and containers), deduplicated, reminded every six hours, with a
recovery message.

Schedule it **offset** from the other monitors so they never contend:

```
7-59/15 * * * * root /usr/bin/python3 /srv/central/scripts/<app>-monitor.py
```

Cloudflare answers urllib's default User-Agent with 403, which made the image
Worker look down when it was serving perfectly. Send a generic one.

## 9. Backups, and proving them

`/etc/cron.d/central-platform` runs `backup-nightly.sh` at 02:15; a new
application is included automatically once it appears in
`central.applications`. **Restore one before believing it:**

```sh
/srv/central/scripts/restore.sh --app <app> --file <dump> --into <app>_restore_check
```

The default is a rehearsal, not an overwrite. Compare row counts, the money,
and the sequences — a restore that loses `ussd_code_seq` reissues payment
codes.

## 10. Retire the old project last

Two weeks of normal trading, a restored backup, a real settled payment, and
every external callback migrated. Disable before deleting; pause before
destroying. Keep a final dump off the server.

## 11. Inherit the audit's protections

Every new project gets these from the start, not after a breach:

```sh
/srv/central/scripts/check-tenant-isolation.sh <app>   # exit status = problems
```

**Audit RLS against the live API, not against policy names.** The worst finding
of the Bedtime audit was a policy called `anon_read_own_orders` whose predicate
was `USING (true)` — it exposed every customer order, and it survived an
earlier tightening pass because the name sounded right. Enumerate every table
with the anon key and see what actually comes back:

```sh
for t in $(psql -tAqX -c "select table_name from information_schema.tables \
  where table_schema='public' and table_type='BASE TABLE'"); do
  curl -s "$API/rest/v1/$t?select=*&limit=1" -H "apikey: $ANON" ...
done
```

Anything that returns rows to anon and is not a catalogue is a finding.

**Do not let a loader swallow an auth error.** Returning `[]` on failure turns
an expired session into an empty shop with nothing said. Copy
`src/lib/authFailure.js` and surface it.

**Ship these headers.** `/*`, not `/index.html`: HSTS, `frame-ancestors 'none'`,
`X-Frame-Options`, nosniff, Referrer-Policy, Permissions-Policy. Keep the full
CSP report-only until it has been exercised in a real browser.

**Make money constraints schema-level.** A partial unique index on the payment
reference, excluding the empty string that walk-ins carry.

**Rotate the platform logs** (`/etc/logrotate.d/central-platform`) and cap
Docker's (`max-size`, `max-file`). Two shops share one disk.

**Monitor independently.** Copy `bedtime-monitor.py`, give it its own state
file and recipient, and offset its cron so monitors never contend.
