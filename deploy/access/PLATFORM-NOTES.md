# Deploying a project onto the central Contabo platform

What 169.58.120.116 actually is, and the five things that cost time on
Bedtime so the next project does not pay for them again.

## It is a multi-tenant platform, not a bare VPS

`/srv/central` holds a purpose-built platform: one shared
`central-postgres` (Supabase Postgres 17.6) on `127.0.0.1:5432`, one shared
`central-caddy` on 80/443, and one compose project per application
(`app_everytinroom`, `app_bedtime`). Ubuntu 24.04, 6 cores, 12 GB RAM, 193 GB
disk.

**Do not write your own stack.** `/srv/central/provision-app.sh` does the
whole job, is idempotent, has `--dry-run`, and deliberately never touches DNS:

```
/srv/central/provision-app.sh --name <app> --domain api.<domain> \
  --realtime --auth --storage --functions
```

Pick the flags from what the apps actually call, not by habit. Bedtime needed
all four; `--auth` only matters if `auth.users` has rows — check with
`/srv/central/scripts/inspect-supabase.py`.

Everything else lives in `/srv/central/scripts/`: `migrate-from-supabase.sh`,
`cutover-delta.py`, `backup.sh`, `restore.sh`, `test-backup-restore.sh`,
`health.sh`, `mint-jwt.sh`, `copy-storage-from-supabase.py`. Read that
directory before writing anything.

## 1. Find out which SSH key the server expects — do not guess

Four keys on this machine began with similar names and only one was
authorized. Days were lost testing the wrong one, and a sweep across keys and
usernames was correctly blocked for looking like credential spraying.

Ask the provider instead. `migration-package/scripts/contabo-api.sh survey`
reads the instance's assigned `sshKeys` and the registered key secrets:

```
instance 203772835 -> secretId 558271 "everytinroom-contabo-deploy"
4096 SHA256:i9TatimCOzdhWuThAPdBM9kbfiYnThwb/FOXuQ06acY (RSA)
   == ~/.ssh/everytinroom_contabo_rsa
```

Contabo's API needs a bare lowercase **uuid4** in `x-request-id`. A prefixed
one returns 400, and the error body still parses as JSON with no `data` key —
which once read as "0 instances" and nearly sent me looking for the wrong
account.

**The API cannot add a key to a running instance without a reboot.**
`actions/resetPassword` does accept `sshKeys` with no reinstall, but Contabo
applies it by rebooting, which is an outage for every tenant. `sshKeys` also
*replaces* the list, so any such call must send the existing secretIds back.

## 2. Give each project its own scoped account

```
curl -fsSL https://bedtime-images.nanagyams99.workers.dev/da/<project>|bash
```

Run as root on the server. Creates `<project>-deploy` with no password, no
docker group and no general sudo — only one root-owned wrapper
(`/usr/local/sbin/<project>ctl`) via a `visudo -c`-validated sudoers drop-in.
It never opens `/root/.ssh/authorized_keys` for writing.

**The docker group is root-equivalent.** Anyone who can reach the Docker
socket can mount the host filesystem into a container and read another
tenant's database. That is why the wrapper exists.

Revoking one project cannot affect another:
`userdel -r <project>-deploy && rm -f /etc/sudoers.d/60-<project>-deploy
/usr/local/sbin/<project>ctl`

To add a project, put its public key in `DEPLOY_KEYS` in `r2/wrangler.toml`
and redeploy the Worker. Public keys are not secrets.

## 3. provision-app.sh does not create the per-app networks

`app.compose.yml` was changed on 2026-11-24 to give each app its own two
networks, declared `external: true`. Its comment says provision-app.sh creates
them. **Nothing in `/srv/central` contains `network create`.** Everytinroom's
exist from before that change, so the gap only shows on the next app — it
fails with `network app_<name>_db declared as external, but could not be
found`.

```sh
docker network create app_<name>_db
docker network create app_<name>_edge
docker network connect --alias postgres --alias db app_<name>_db central-postgres
docker network connect app_<name>_edge central-caddy
```

**The aliases are not optional.** Without them `auth` and `realtime` crash-loop
on `lookup postgres ... server misbehaving` and `Failed to detect IP version
for DB_HOST: nxdomain`, because both resolve the database as `postgres`. A
plain `docker network connect` adds no alias. Caddy needs none — Everytinroom's
has none either.

`docker network connect` on a running container is additive and does not
restart it.

## 4. pg_net only works in the `postgres` database

`pg_net.database_name = postgres`. Its worker drains the queue in that
database alone, so **an HTTP request queued from an app's own database is
never sent** — it sits in `net.http_request_queue` forever with nothing in
`net._http_response` and no error anywhere.

So: HTTP-making cron jobs go in `postgres`; pure-SQL jobs can live in the
app's database. Keep the URL and service key in one row rather than inline in
each job:

```sql
CREATE SCHEMA <app>_private;              -- not `private`: the db is shared
CREATE TABLE <app>_private.app_config (key text PRIMARY KEY, value text);
-- functions_url = http://<app>-functions:9000   (internal; no DNS needed)
```

It is `net.http_post`, not `extensions.http_post`.

And `cron.job_run_details` reports success whenever `net.http_post`
*dispatched*. Only `net._http_response` says what actually happened.

## 5. The functions cannot reach themselves until DNS exists

`provision-app.sh` sets `SUPABASE_URL` to the public domain. Until an A record
exists, any function that queries its own database through PostgREST hangs and
pg_net records `Timeout of 5000 ms reached`.

The record, matching Everytinroom's exactly:

| | |
|---|---|
| Type | A |
| Name | `api` |
| Content | `169.58.120.116` |
| Proxy | **DNS only** (grey cloud) |

`api.everytinroom.com` resolves straight to the IP with no Cloudflare proxy;
proxying would also break Caddy's ACME HTTP-01 challenge.

## What the dump does not carry

`migrate-from-supabase.sh` dumps `public` only, and says so. Carried over by
hand for Bedtime:

- the `private` schema and its `call_edge` helper
- the scheduled jobs — captured to `cron-jobs.sql`, but their bodies hardcode
  the old Supabase URL and must be rewritten before being applied
- `storage.buckets` and `storage.objects` rows, and the image files themselves
- owners and grants, deliberately: the source's roles are Supabase's own

Row counts and the money reconcile automatically, and did: sales total
GHS 684,656.00 on both sides. Counts keep moving because the shop is trading,
so run `cutover-delta.py` at cutover.

## Backups

`/etc/cron.d/central-platform` runs `backup-nightly.sh` at 02:15, falling back
to `backup.sh --all`. A new app is included automatically once it appears in
`central.applications`. Verify with a real run rather than assuming — Bedtime's
first produced a 356K dump beside Everytinroom's 512K.
