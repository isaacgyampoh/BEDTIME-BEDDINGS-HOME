# Running Supabase ourselves, on our own server

**Status: nothing is deployed. No server exists yet.** Everything here is
prepared and ready to run; none of it has been run, because there is nothing to
run it on. This file says exactly what is needed to change that.

---

## First, two corrections to the plan

### 1. The database is not lost. It came back.

The brief says the old project's hostname "reportedly stopped resolving, and an
earlier investigation did not find a usable backup". Both were true on 26
October. They are not true now — the project was restored, and it is live:

| | |
|---|---|
| products | 680 |
| sales | 910 |
| customers | 773 |
| web orders | 173 |
| expenses / promos / bundles | 5 / 4 / 4 |
| product photos | serving from Storage |
| both websites and the POS | answering |

Checked again at the start of this work with `scripts/healthcheck.sh`:
*"680 products on sale. The shop is open."*

This changes the migration completely, and for the better. We are no longer
reconstructing a schema and hoping; we can take a real `pg_dump` of a live
database with every row in it and restore that. **No business data needs to be
reconstructed, and none should be.**

### 2. This probably costs more, not less

The goal given was to "reduce recurring hosting expenses". Verified prices:

| | Monthly |
|---|---|
| Contabo Cloud VPS 4 — 4 vCPU, 8 GB RAM, 100 GB SSD | **€4.40** at 24 months, €5.50 otherwise |
| Off-server backups (Cloudflare R2, under 10 GB) | €0 |
| Supabase self-hosted software | €0 |
| **Our cost after moving** | **≈ €4.40–5.50** |

Supabase's free tier is €0. **So if this project is on the free plan, moving to
Contabo does not save money — it adds about €5 a month**, plus a server to
patch, a Docker stack to upgrade, certificates to keep valid, and backups that
only work if someone checks them. If the project is on Pro at $25/month, the
move saves roughly $19/month.

**I cannot see which plan the project is on** — that is in the Supabase billing
dashboard. It is the single fact that decides whether this is worth doing, and
it takes you ten seconds to check.

There is also a reliability cost worth saying plainly. Two weeks ago this shop
was down and nobody noticed for days. On managed Supabase, keeping Postgres
alive is somebody else's job. Self-hosted, every outage is ours, at whatever
hour it happens. The watchdog added in `scripts/healthcheck.sh` helps either
way, but it reports problems — it does not fix them.

Contabo VPS 4 does meet Supabase's documented recommended spec (8 GB RAM,
4 cores, 80 GB+ SSD), so the plan is technically sound. It is the economics and
the operational load that deserve a decision before we spend the effort.

---

## What the audit found

There is no backend server in this repository. Supabase *is* the backend, and
these are the parts in use:

| Service | What depends on it |
|---|---|
| PostgreSQL | 22 tables, 46 migrations |
| PostgREST | **the entire API** — 68 table calls, 11 stored procedures |
| Storage | every product photo, bucket `product-images` |
| Edge Functions | 6 functions, 2,341 lines: payments, SMS, WhatsApp, USSD, voice |
| pg_cron + pg_net | 17 scheduled jobs |
| Realtime | 4 subscriptions |
| Auth | **not used** — staff sign in with a PIN checked in the database |

Auth being unused is good news: there are no auth users to migrate, which is
usually the hardest part of leaving a managed Supabase.

### Two things that will break silently if missed

Both are handled by `migrate-from-managed.sh`, and both were found by reading
the repository rather than by running anything:

1. **14 scheduled jobs call the Edge Functions by absolute URL.** They contain
   `https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/...` in the job
   command itself. Move the database without rewriting them and the daily SMS
   report and the mobile-money reconciler keep calling the *old* project — from
   the new server, quietly, forever.

2. **Every product photo is an absolute URL in `products.image`.** All 680 rows
   point at the old project's Storage. Copying the files across is not enough;
   the rows have to be repointed, and the script refuses to continue if even
   one reference is left behind.

---

## What is in this folder

| File | Does |
|---|---|
| `bootstrap.sh` | Prepares a fresh Ubuntu server: Docker, firewall, fail2ban, automatic security updates, a non-root user, SSH hardening, and fetches the **official** Supabase bundle. Leaves it stopped, because starting it would come up with the example secrets. |
| `docker-compose.override.yml` | Our changes, kept apart from upstream so `git pull` stays the upgrade path: `pg_cron` and `pg_net` preloaded, `wal_level=logical` for Realtime, Postgres never published to the host, named volumes so a container rebuild does not take the books with it, restart policies so a reboot brings the shop back. |
| `Caddyfile` | TLS on `api.bedtimehome.com`, certificates issued and renewed unattended. The only thing on the public interface. |
| `migrate-from-managed.sh` | Dumps the live project, rewrites the two classes of baked-in URL, restores, then **compares row counts table by table and exits non-zero if any differ**. |
| `backup.sh` | Nightly dump that **restores itself into a scratch database and counts the rows before calling itself good**, then sends it off the server. A backup nobody has restored is a hope. |

Deliberately not published: Postgres (5432), Studio, PostgREST, Realtime and
Storage all stay on the internal Docker network. Studio is reached over an SSH
tunnel — putting a Postgres console on the internet behind basic auth is not
something to do to a shop's books.

---

## Running it, when there is a server

```bash
# 1. On a fresh Ubuntu LTS server, as root
bash bootstrap.sh bedtime

# 2. As the bedtime user: secrets. Never the example values.
cd /opt/supabase && cp .env.example .env && chmod 600 .env
openssl rand -hex 32        # POSTGRES_PASSWORD
openssl rand -hex 32        # JWT_SECRET  (then mint ANON_KEY and
                            # SERVICE_ROLE_KEY from it — supabase.com/docs/
                            # guides/self-hosting#api-keys)
openssl rand -hex 32        # SECRET_KEY_BASE, VAULT_ENC_KEY, DASHBOARD_PASSWORD

# 3. Our overrides, then start
cp /path/to/repo/selfhost/docker-compose.override.yml /opt/supabase/
cp /path/to/repo/selfhost/Caddyfile /opt/supabase/
docker compose up -d && docker compose ps

# 4. The schema, then the data
/path/to/repo/restore/restore.sh "postgres://postgres:<pw>@127.0.0.1:5432/postgres"
export SOURCE_DB_URL=...   # managed project, Settings > Database
export TARGET_DB_URL=...   # over an SSH tunnel
/path/to/repo/selfhost/migrate-from-managed.sh

# 5. Backups, nightly, verified
sudo cp /path/to/repo/selfhost/backup.sh /opt/supabase/
rclone config              # a remote named `offsite`
sudo crontab -e            # 0 2 * * * /opt/supabase/backup.sh >> /var/log/bedtime-backup.log 2>&1
```

### Moving the photos

`migrate-from-managed.sh` repoints the rows; the files still have to be copied.
From a machine with both keys:

```bash
# managed -> local -> self-hosted, bucket product-images
# (rclone with two S3 remotes, or the Supabase CLI's storage commands)
```

Until this is done the shop will show broken images, which is why it must
happen **before** cutover, not after.

### Cutover

The two front ends already read `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY`, so switching is configuration, not code:

1. Set both in Cloudflare Pages for `bedtime-shop` and `bedtime-admin`.
2. `npm run deploy` — the gates run first.
3. `./scripts/healthcheck.sh` must say the shop is open, with 680 products.
4. Sign in on the POS, ring up a test sale, void it.
5. Watch for 48 hours before cancelling anything.

### Rolling back

Remove the two environment variables in Cloudflare Pages and redeploy. Both
apps fall back to the managed project, which is still running and still holds
the data, because nothing in this process writes to it. That is the whole
rollback — which is why the managed project must not be cancelled until the new
one has carried real trade for a while.

---

## What is needed from you

1. **Which Supabase plan is the project on?** Free, or Pro at $25? This decides
   whether the migration saves money or costs it. Nothing else here is worth
   doing until that is answered.
2. **A server.** No Contabo VPS exists that I can see — no credentials, no SSH
   host entries, no mention anywhere in the repository. If one has been bought,
   I need its address and a key to reach it. If not, Cloud VPS 4 is the one
   that fits.
3. **Database access for the dump.** `migrate-from-managed.sh` needs the
   managed project's connection string. I am currently blocked from reaching
   your production database from this session at all — the sandbox refuses it —
   so either that permission changes, or you run the script.

Nothing in this folder runs by itself, nothing has been deployed, and the live
shop has not been touched.
