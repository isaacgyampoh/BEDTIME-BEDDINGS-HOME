# Bedtime migration plan

**10 November 2026.** The mechanism below has been executed and reconciled on
a separate database. Nothing has been run against production.

## Reuse, not rebuild

`~/everytinroom-pos/deploy/` already holds a multi-tenant platform that has
been tested on a real disposable Ubuntu server: 100 named checks passed, 0
failed, 4 unverified. Bedtime does **not** need its own VPS or its own stack.

`deploy/provision-app.sh` takes `--name`, and derives everything else from it:

```
APP_DB="$NAME"                     # the database
APP_AUTHN="${NAME}_authenticator"  # PostgREST's role
APP_RT_USER="${NAME}_realtime"
APP_ST_USER="${NAME}_storage"
APP_DIR="/srv/central/apps/$NAME"
```

So Bedtime becomes a tenant with its own database and its own roles:

```sh
/srv/central/provision-app.sh \
  --name bedtime \
  --domain api.bedtimehome.com \
  --realtime --storage --functions \
  --migrations /srv/central/apps/bedtime/migrations
```

**`--auth` is deliberately absent.** Bedtime has no Supabase Auth: staff sign
in with a PIN checked by `verify_pin`. Running GoTrue would cost ~256 MB
serving nothing. That is a measurement from the repository, not a guess.

`--realtime` **is** needed: the two apps hold 6 subscriptions between them.
See BEDTIME-TEST-RESULTS.md on why polling should be considered instead.

The script does not touch DNS. Nothing points at the server until a record is
created by hand, which is what makes provisioning safe to run while Supabase
is still live.

### Isolation from Everytinroom

Separate database, separate roles, separate `/srv/central/apps/` directory,
separate `.env`. Bedtime is never pointed at Everytinroom's database. I read
that project read-only and changed nothing in it.

## The migration, as executed

Run today against a local PostgreSQL, four times over, with the real data.

### 1. Rebuild the schema

```sh
dropdb --if-exists bedtime_restore && createdb bedtime_restore
./restore/restore.sh "postgres://…/bedtime_restore"
```

One migration file at a time, never concatenated — an earlier version joined
them and silently swallowed a `CREATE TABLE` while `psql` exited 0.

Result: 21 tables, 36 functions, 42 policies, 17 scheduled jobs, **45 applied,
0 failed**.

The default now reproduces production: everything except 043, 044 and 047,
which are genuinely pending. `--pending` applies those three as well.

### 2. Load the data

3,772 rows across 9 tables, with `session_replication_role = replica` during
the load so triggers and foreign keys do not fire — the same approach
`pg_dump` takes — then constraints verified afterwards.

### 3. Reconcile

**24 of 24 metrics identical.** Not a sample: counts, money, inventory,
identifiers and timestamps.

| metric | production | restored |
|---|---|---|
| rows · products / customers / sales / orders | 631 / 1,106 / 1,283 / 607 | identical |
| sales · revenue | **GHS 595,706.00** | identical |
| sales · profit | GHS 204,461.50 | identical |
| sales · discount | GHS 13,013.00 | identical |
| inventory · units | 2,182 | identical |
| inventory · retail / cost value | GHS 325,621.00 / GHS 197,803.00 | identical |
| customers · lifetime spend / visits | GHS 596,126.00 / 1,271 | identical |
| orders · value | GHS 252,219.00 | identical |
| expenses | GHS 1,236.00 | identical |
| receipt numbers, product ids, order numbers | preserved exactly | identical |
| oldest sale timestamp | 2026-08-15T17:34:48 | identical |

Identifiers are **preserved, not regenerated** — every receipt number, product
id and order number compares equal as a sorted set.

### 4. Referential integrity afterwards

```
sales whose customer is absent:    1   (customer = '', a GHS 35 walk-in)
orders pointing at a missing sale: 0
price history for absent products: 33  (31 products deleted over time)
```

Both non-zero results are pre-existing production conditions reproduced
faithfully, not migration faults.

## What this does NOT prove

The 3,772 rows are the **readable** tables. `staff`, `pin_attempts`,
`sms_log`, `sms_exempt_numbers` and `social_connections` refuse the public key,
so they were not copied and have not been reconciled.

**A production cutover cannot proceed on this dataset.** It needs a real
`pg_dump`, which needs the database password or the Management API. Until then
this is a proven mechanism against incomplete data — which is worth having,
and is not the same thing as a migration.

## Order of operations for the real thing

1. Authorise the Supabase MCP connector, or provide database access by a
   secure route. **Not by pasting a credential into a chat.**
2. `pg_dump` the live database, including the five blocked tables.
3. Restore into `bedtime` on the central VPS via `provision-app.sh
   --migrations`.
4. Re-run the reconciliation above against the dump rather than the API, and
   extend it to cover `staff` row counts and `pin_hash` presence (never PIN
   values).
5. Migrate storage to R2 (`r2/README.md`) and verify by SHA-256.
6. Deploy to a private staging hostname. Do not touch DNS.
7. Run the acceptance suite in BEDTIME-TEST-RESULTS.md against staging.
8. Only then consider cutover, per BEDTIME-CUTOVER-CHECKLIST.md.
