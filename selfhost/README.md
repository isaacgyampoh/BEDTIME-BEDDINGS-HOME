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

Re-counted directly against production on 5 November 2026, which is also why
these differ from the figures written here on 26 October — the shop has been
trading:

| | 26 Oct | 5 Nov |
|---|---|---|
| products | 680 | **625** |
| sales | 910 | **1,137** |
| customers | 773 | **982** |
| web orders | 173 | **532** |
| expenses / promos / bundles | 5 / 4 / 4 | 5 / 1 / 4 |
| product photos | serving | **1,076 objects, 300.1 MB** |
| both websites and the POS | answering | answering |

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
| Storage | 1,076 objects, 300.1 MB, bucket `product-images` — **movable to R2 instead**, see below |
| Edge Functions | 6 functions, 2,341 lines: payments, SMS, WhatsApp, USSD, voice |
| pg_cron + pg_net | **7** scheduled jobs (migration 018 consolidated them) |
| Realtime | 4 subscriptions |
| Auth | **not used** — staff sign in with a PIN checked in the database |

Auth being unused is good news: there are no auth users to migrate, which is
usually the hardest part of leaving a managed Supabase.

### Two things that would have broken silently — and where they now stand

Both were found by reading the repository. Re-checking them against production
today, one has already been fixed and the other no longer needs fixing at all.

1. **The scheduled jobs no longer carry an absolute URL.** They did, and moving
   the database without rewriting them would have left the new server calling
   the *old* project forever. Migration 018 replaced that: all seven jobs are
   now `SELECT private.call_edge('/sms-reports?type=morning')` and the base URL
   comes from one row in `private.app_config`. So the cutover is **one UPDATE**,
   not fourteen job commands rewritten.

   The seven, as scheduled:

   | job | when | calls |
   |---|---|---|
   | `sms-morning` | 07:00 daily | `/sms-reports?type=morning` |
   | `sms-midday` | 13:00 daily | `/sms-reports?type=midday` |
   | `sms-evening` | 20:00 daily | `/sms-reports?type=evening` |
   | `sms-lowstock` | 09:00 daily | `/sms-reports?type=lowstock` |
   | `sms-weekly` | 20:00 Saturdays | `/sms-reports?type=weekly` |
   | `sms-monthly` | 20:00 on the 28th | `/sms-reports?type=monthly` |
   | `payment-reminder` | every hour at :15 | `/super-service?action=remind` |

   They reach the Edge Functions over `pg_net`, so the server needs **outbound**
   HTTPS. Nothing needs to reach the database from outside for them to run.

2. **The product photos no longer need to move to the server.** Every photo is
   an absolute Supabase URL, and not only on `products.image`: 879 storage
   paths are referenced, of which **277 are on the item snapshots kept with
   past receipts, orders and bundles**. Repointing rows would mean rewriting
   historical records, and rolling back would mean rewriting them again.

   `src/lib/imageHost.js` solves this without touching a single row — the host
   is chosen on the way to the `<img>` tag. Which means the photos can go to
   **Cloudflare R2** (see `r2/`, 220 MB of 10 GB free, no egress charge)
   instead of onto the VPS. That takes the largest and most error-prone part
   out of this migration, keeps 300 MB of images off a 100 GB disk, and serves
   them from Cloudflare's edge rather than from a single server in Germany to
   customers in Accra.

   If you would rather keep everything on one machine, the Storage container is
   still in the stack and `migrate-from-managed.sh` still moves the bucket. R2
   is the better answer for a shop whose customers are all in one city a long
   way from the server.

### One credential that a dump will carry with it

`private.app_config` holds `service_key` — a service-role key, inside the
database, because `pg_net` needs it to authenticate to the Edge Functions. It
is not reachable from outside (the `private` schema is not exposed through
PostgREST; a request for it returns 404, checked today).

But a `pg_dump` includes it. Restore that dump onto the new server and the new
database holds the **old project's service-role key**, which stays valid until
it is rotated. `migrate-from-managed.sh` must clear that row and have you
re-insert the new project's key, and the old one should be rotated afterwards
regardless. This is the one secret that moving the database moves with it.

### Extensions the schema needs

Verified against the migrations: `pg_cron`, `pg_net`, `pgcrypto`, `uuid-ossp`.
All four are in the official `supabase/postgres` image; `pg_cron` and `pg_net`
additionally need `shared_preload_libraries`, which
`docker-compose.override.yml` already sets. Nothing here needs an extension
that self-hosting cannot provide.

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

**Preferred: don't move them here at all — see `r2/`.** 220 MB of referenced
photos into Cloudflare R2, free, no egress charge, served from the edge rather
than from Germany, and switched with one environment variable because
`src/lib/imageHost.js` never changes what is stored.

If they must live on the VPS instead:

```bash
# managed -> local -> self-hosted, bucket product-images
# (rclone with two S3 remotes, or the Supabase CLI's storage commands)
```

Until this is done the shop will show broken images, which is why it must
happen **before** cutover, not after.

