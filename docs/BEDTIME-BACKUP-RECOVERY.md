# Bedtime backup and recovery

**10 November 2026.**

## Honest status

| requirement | state |
|---|---|
| Automated database backups | **NOT IN PLACE.** Managed Supabase takes its own; nothing in this repository schedules or checks one. |
| Encrypted off-server copies | **NOT IN PLACE** |
| Retention policy | **NOT IN PLACE** |
| Regular restoration verification | **PARTIAL** — see below |
| Application health monitoring | **IN PLACE**, `scripts/healthcheck.sh` |
| Database health monitoring | **PARTIAL** — the healthcheck proves Postgres answers |
| Storage monitoring | **MANUAL** — the inventory script measures it |
| Disk-space alerts | **NOT IN PLACE** (no server) |
| Service restart policies | **PREPARED**, `selfhost/docker-compose.override.yml` |
| Error reporting | **PARTIAL** — the dashboard's System Health panel |
| Backup failure alerts | **NOT IN PLACE** |
| Documented disaster recovery | **IN PLACE**, `restore/MIGRATION.md` + this file |
| Rollback procedure | **IN PLACE** for the front ends and for images; see below |

Nothing above is claimed on the strength of a file existing.

## What restoration verification has actually been done

This is the part that counts, and it was done four times today.

```sh
dropdb --if-exists bedtime_v4 && createdb bedtime_v4
./restore/restore.sh "postgres://…/bedtime_v4"      # 45 applied, 0 failed
node …/migrate.mjs  bedtime_v4                      # 3,772 rows loaded
node …/reconcile.mjs bedtime_v4                     # 24 of 24 identical
```

The reconciliation compares row counts, revenue, profit, discount, inventory
units and value, customer spend and visits, order value, expenses, every
receipt number, product id and order number, and the oldest timestamp.

**It is not a backup restoration.** It is a schema rebuild plus an API export,
because `pg_dump` is not available from here. The difference matters:

- Five tables were **not** copied (`staff`, `pin_attempts`, `sms_log`,
  `sms_exempt_numbers`, `social_connections`).
- A real dump carries functions, triggers, policies, sequences and grants as
  production actually has them, rather than as this repository believes.

So: the restore *mechanism* is verified end to end against real data. A
*backup* has not been verified, because no backup file has been obtained.

## The restore default was unusable, and is fixed

`restore.sh` hid migrations 042/045/046 behind `--with-fixes`, so a default
restore produced a pre-045 database in which `staff.pin` is `NOT NULL`. In
that database `verify_pin` raises on its own conversion `UPDATE`, so **a
cashier with the correct PIN could not sign in** and no staff member could be
added.

Found by restoring, loading the real rows, and trying to sign in. The default
now reproduces production. This is the kind of fault that only appears when a
backup is actually restored and used, which is the argument for doing it.

## Rollback that exists and is tested

| what | how to roll back | tested |
|---|---|---|
| Front-end deploy | redeploy the previous commit; Cloudflare Pages keeps every deployment | yes, deploys are routine |
| Product images moving to R2 | unset `VITE_IMAGE_HOST` and deploy. The database still holds Supabase URLs for all 890 paths and the files are still there. | the mechanism is unit-tested; the move has not been made |
| Migration 051 | `ADD COLUMN IF NOT EXISTS` — no-op against production, nothing to reverse | applied to four local databases |
| `supabase/pending/049` (merge customers) | **no automatic rollback.** It deletes 36 rows after folding their figures in. Take a backup first. | applied and re-applied on a local copy of the real 1,106 rows; total spend unchanged |
| `supabase/pending/050` (unique payment ref) | drop the index; the `''` → NULL change is not reversible row-by-row | applied twice on a local copy of the real orders |

## What is needed to close this out

1. A real `pg_dump`, restored into a separate database and reconciled —
   including the five blocked tables.
2. A scheduled backup with an off-server copy. `selfhost/backup.sh` is written
   to dump, restore itself into a scratch database and count rows before
   calling itself good; it has never run against a real server.
3. Alerting when a backup fails, which matters more than the backup.
