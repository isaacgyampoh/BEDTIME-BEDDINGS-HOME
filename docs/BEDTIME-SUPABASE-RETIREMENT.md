# Retiring hosted Supabase for Bedtime

**Cutover is DONE.** Both front ends serve from `https://api.bedtimehome.com`
as of 24 November 2026, Supabase's 16 scheduled jobs are disabled, and
Bedtime's 9 run on Contabo. **Do not delete Supabase yet** — the checklist
below has to pass first.

State at the time of writing:

| | |
|---|---|
| front ends | **Contabo** (`api.bedtimehome.com`, real Let's Encrypt cert) |
| database | `bedtime` inside `central-postgres`, exact copy, `ussd_code_seq` 50666 |
| scheduled jobs | 9 `btm-*` on Contabo; Supabase's 16 **disabled, definitions kept** |
| images | R2 via the Worker; new uploads go straight to R2 |
| staff login | verified end-to-end (GoTrue session issued) |
| payments | NaloPay merchant auth verified; `reconcile-payments` every 5 min |
| SMS | verified delivered (mNotify code 2000, 6,458 credits) |
| data exposure | closed on **both** backends (043/044/047) |
| rollback | `bedtime_t0` snapshot + `cutover-delta.py` |
| Everytinroom | unaffected throughout |

### Rolling back

```sh
# 1. carry Contabo's trading back to Supabase
/srv/central/scripts/cutover-delta.py --base bedtime_t0 --current bedtime > back.sql
#    then run back.sql against Supabase (it refuses unless Supabase still equals T0)
# 2. re-enable Supabase's jobs
#    SELECT cron.alter_job(jobid, active := true) FROM cron.job;
# 3. republish the front ends with none of the VITE_ overrides
./scripts/deploy.sh both
```

---

## Everything that still depends on hosted Supabase

| # | Dependency | Status | What replaces it |
|---|---|---|---|
| 1 | Both front ends | **done — on Contabo** | — |
| 2 | 16 cron jobs in Supabase's `cron.job` | **done — disabled** | 9 `btm-*` jobs on Contabo |
| 3 | Edge Functions `super-service` v18, `sms-reports` v10 | **kept on purpose** | so in-flight callbacks still settle; remove at retirement |
| 4 | NaloPay callbacks for charges begun on Supabase | **handled** | `btm-reconcile-payments` polls NaloPay every 5 min, so Contabo is authoritative whichever backend got the callback. Supabase's `super-service` is deliberately left deployed so those callbacks still land. |
| 5 | `product-images` bucket, 1,153 objects | still origin | R2 holds all 948 referenced; the Worker reads through for the rest |
| 6 | R2 Worker `ORIGIN_BASE` | points at Supabase | clear it once nothing misses |
| 7 | `imageUpload.js` Supabase fallback | still a fallback | remove once R2 uploads are proven in daily use |
| 8 | `invoice-photos` bucket | **0 objects, no dependency** | already uploads to R2 |

---

## The cutover, in order

### 1. Stop Supabase writing

Supabase's cron jobs keep sending SMS and settling orders. Leave them running
and two backends act on the same business. Disable them **first**:

```sql
-- against hosted Supabase
UPDATE cron.job SET active = false WHERE jobname NOT LIKE 'btm-%';
```

Reversible: set `active = true` to roll back. Nothing is dropped.

### 2. Final delta

A plain re-run of `migrate-from-supabase.sh` into a populated database **does
not** sync changes — every `CREATE` collides and new rows are skipped. It
reports `MISMATCH` rather than lying, but it does not do the job. The reliable
sequence, which is what was used:

```sh
docker exec -i central-postgres psql -U postgres -d bedtime -c \
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO PUBLIC;'
SUPABASE_DB_URL=… ASSUME_YES=1 /srv/central/scripts/migrate-from-supabase.sh --app bedtime
```

**Then immediately restore the extensions.** `pg_net` is installed into
`public` on Supabase, so the cascade removes `pgcrypto` and `uuid-ossp` too,
and the dump does not carry `CREATE EXTENSION`. Miss this and **no cashier can
sign in**, because `verify_pin()` compares with `crypt()`:

```sql
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto           WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp"        WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
```

Then drop the three retired agent tables again — they come back with every
dump until `supabase/pending/053` is applied on Supabase.

Confirm: row counts and `sum(sales.total)` match, and `ussd_code_seq` is **not
lower** than on Supabase. A lower sequence reissues USSD codes already handed
to customers.

### 3. Refresh the rollback baseline

```sh
docker exec central-postgres psql -U postgres -c 'DROP DATABASE IF EXISTS bedtime_t0'
docker exec central-postgres psql -U postgres -c 'CREATE DATABASE bedtime_t0'
docker exec central-postgres pg_dump -U postgres --no-owner --no-privileges bedtime \
  | docker exec -i central-postgres psql -U postgres -d bedtime_t0 -q
```

`TEMPLATE` will refuse while the services are connected. T0 is what
`cutover-delta.py` diffs against to carry Contabo's trading back to Supabase
if the switch has to be undone.

### 4. Publish the front ends

```sh
VITE_SUPABASE_URL=https://api.bedtimehome.com \
VITE_SUPABASE_ANON_KEY="$(ssh … "grep '^ANON_KEY=' /srv/central/apps/bedtime/.env | cut -d= -f2-")" \
VITE_IMAGE_HOST=https://bedtime-images.nanagyams99.workers.dev \
  ./scripts/deploy.sh both
```

Rollback is the same command without those variables.

### 5. Verify on the live sites

A real PIN sign-in at the till, one product photo loads, one order opens.
Then `/srv/central/scripts/health.sh` → `problems=0`.

### 6. Settle what was in flight

```sql
SELECT bedtime_private.call_edge('/super-service?action=reconcile-payments');
-- then read net._http_response, NOT cron.job_run_details
```

Contabo asks NaloPay for the truth, so it does not matter which backend
received a callback.

---

## Only then, retirement

Leave Supabase running and paid for **at least two weeks** of normal trading.

Before deleting anything, all of these must be true:

- [ ] both front ends served from `api.bedtimehome.com` for 14 days
- [ ] no Supabase cron job has been re-enabled
- [ ] `health.sh` has reported `problems=0` every day
- [ ] a nightly backup has been **restored** into a scratch database and
      reconciled (`restore.sh --app bedtime --file … --into bedtime_restore_check`)
      — a backup nobody has restored is a hope, not a backup
- [ ] offsite copies exist in R2 (`backup-nightly.sh`, 02:15 via `/etc/cron.d/central-platform`)
- [ ] a real USSD payment has settled on Contabo and the SMS confirmation arrived
- [ ] `ussd_code_seq` on Contabo is at or above Supabase's last value
- [ ] the R2 Worker has served every product photo with no `origin-healed`
      misses for a week, so `ORIGIN_BASE` can be cleared
- [ ] `imageUpload.js`'s Supabase fallback has not been used (no
      "R2 upload refused" in the console) for a week
- [ ] the 1,153 Supabase Storage objects are copied somewhere durable — R2 has
      the 948 referenced, the other 205 are referenced by nothing and were
      deliberately skipped

**Order of deletion, slowest to reverse last:**

1. Disable (do not delete) the Supabase cron jobs — already done at step 1
2. Delete the Supabase Edge Functions
3. Delete the Storage buckets, once the objects are copied
4. Pause the Supabase project — reversible for a while
5. Delete the project — **irreversible**

Keep a final `pg_dump` of the Supabase database, off the server, before step 4.

---

## Known residual items

- **`MNOTIFY_KEY` on Contabo is wrong.** Its SHA-256 is identical to
  `NALOPAY_MERCHANT_ID`, so the merchant id was pasted into the mNotify box,
  and mNotify answers `{"status":"error","code":"1004"}`. SMS reports run and
  now correctly report `not-delivered`. Fix with
  `enter-provider-secrets.sh MNOTIFY_KEY` before cutover, or the owner's daily
  reports stop.
- **`PAYSTACK_SECRET_KEY` is absent on both backends, deliberately.** No
  Bedtime order has ever carried a Paystack reference, and its absence is what
  makes `?action=webhook` fail closed.
- **`TIKTOK_CLIENT_KEY`/`SECRET` were skipped**, so `btm-tiktok-status`
  answers "TikTok is not connected". Harmless; set them to re-enable it.
- **`supabase/pending/052`** (16 cron jobs where 8 belong, six with a
  service-role JWT inline) and **043/044/047/049/050** are still unapplied on
  Supabase. After cutover they matter only if Supabase is ever restored.
