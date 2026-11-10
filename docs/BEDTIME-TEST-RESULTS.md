# Bedtime test results

**10 November 2026.** PASS means a named check ran and passed. BLOCKED means
it cannot run from this environment. NOT TESTED means nobody ran it — it is
never a soft pass.

## Automated suites

| suite | assertions | result |
|---|---|---|
| unit (`npm test`) | **751** | PASS, 0 failed |
| POS e2e (`test:pos`) | 77 | PASS |
| promos e2e | 28 | PASS |
| recovery e2e | 24 | PASS |
| shop e2e | 22 | PASS |
| upload e2e | 14 | PASS |
| shop on/off e2e | 14 | PASS |
| buying e2e | 13 | PASS |
| counts e2e | 11 | PASS |
| lint (admin + shop) | — | 0 errors, 36 warnings |

The e2e suites drive a real Chromium through Electron with CDP, against the
real built application. They stub the network at the HTTP layer, so the
application code, router and rendering are genuine; the database is not.

## Database and POS integrity, against real data

Run against a database rebuilt from this repository and loaded with the 3,772
real production rows.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Schema rebuilds from migrations | **PASS** | 45 applied, 0 failed; 21 tables, 36 functions, 42 policies |
| 2 | Schema drift after 051 | **PASS** | zero columns unaccounted for when loading real rows |
| 3 | Reconciliation, source vs restored | **PASS** | 24 of 24 metrics identical |
| 4 | Identifiers preserved | **PASS** | receipt numbers, product ids, order numbers compare equal |
| 5 | Timestamps preserved | **PASS** | oldest sale 2026-08-15T17:34:48 on both sides |
| 6 | A sale deducts stock exactly | **PASS** | 150 → 148 on a 2-unit sale; GHS 60 revenue, GHS 30 profit booked |
| 7 | A tampered price is refused | **PASS** | submitted GHS 30 against an expected GHS 60 → rejected, stock unchanged |
| 8 | Overselling is refused | **PASS** | 99,999 units requested against 148 → `"Not enough stock … 148 left, 99999 needed"`, stock unchanged, never negative |
| 9 | Order stock cannot be deducted twice | **PASS** | first call `{"success":true,"lines_deducted":3}`; second `{"note":"already deducted"}` |
| 10 | Two cashiers cannot oversell | **PASS** | 3 units, two concurrent 2-unit sales: one succeeded (GHS 140), one refused ("1 left, 2 needed"), final stock 1 |
| 11 | PIN sign-in, legacy plaintext row | **PASS** | succeeds and converts: `pin` → NULL, `pin_hash` → 60-char bcrypt |
| 12 | PIN sign-in against the hash | **PASS** | second attempt verifies via `crypt()` |
| 13 | Wrong and non-numeric PIN | **PASS** | `{"success": false}`, nothing leaked |
| 14 | Lockout after 10 failures in 5 min | **PASS** | a *correct* PIN is refused while locked — the point of it |
| 15 | Restore default is signable-into | **PASS** (after a fix) | it was not; see below |

### Check 15 — the restore default was broken

`restore.sh` excluded migrations 042–047 and hid 042/045/046 behind
`--with-fixes`. Production has 042, 045, 046 and 048. So the default restore
produced a **pre-045** database, where `staff.pin` is still `NOT NULL` — and
in that database `verify_pin`'s own conversion path raises on its `UPDATE`
(it sets `pin = NULL`):

```
ERROR: null value in column "pin" of relation "staff" violates not-null constraint
CONTEXT: SQL statement "UPDATE staff SET pin_hash = crypt(...), pin = NULL"
```

A cashier entering the **correct** PIN could not sign in, and
`admin_save_staff` could not add anyone. A disaster-recovery script whose
default output cannot be logged into is not a recovery script. Fixed: the
default now reproduces production.

I first reported this as a live production bug. **It is not** — migration 045
fixed it and was applied on 1 November. The fault was in my test setup.

## Live production verification

| Check | Result | Evidence |
|---|---|---|
| Database hostname resolves and answers | **PASS** | 401 in 0.049s; resolves to 172.64.149.246 |
| POS figures match the database | **PASS** | opened the deployed POS against live production: 1,283 sales / 1,106 customers / 607 orders loaded, revenue GHS 595,706 |
| Status figures account for every order | **PASS** | buckets sum to the table total |
| Both sites answer | **PASS** | bedtimehome.com, www, admin all HTTP 200 |
| Shop front carries the new phone number | **PASS** | `tel:0548124978`, `+233548124978`, 0 occurrences of the old number |
| Product photos load | **PASS** | 890 referenced images, 0 broken |

## BLOCKED — cannot run from this environment

| # | Check | Why |
|---|---|---|
| 16 | Staff accounts and PINs reconciled | `staff` refuses the public key (HTTP 401) |
| 17 | Edge Function behaviour in production | deploys are refused by this sandbox; five functions carry undeployed changes |
| 18 | Database restart / failover | no server exists to restart |
| 19 | Backup restoration from a real dump | needs `pg_dump`; see the plan |
| 20 | Cross-tenant isolation on the VPS | no VPS has been provisioned |
| 21 | Live-update latency measured on real infrastructure | same |
| 22 | R2 upload / retrieval / deletion against a real bucket | no bucket exists yet |

**Production PIN authentication was deliberately not probed.** Guessing PINs
against the live `verify_pin` would trip the 10-failure lockout and lock real
cashiers out of the till. That is why checks 11–14 were run against a
synthetic staff row in a disposable database instead.

## NOT TESTED

Barcode scanning, shift management, and supplier/purchase workflows — the
tables are empty and no code path for them was found, so there is nothing to
exercise. Returns and refunds have **0 rows** in production and the e2e suite
does not cover them; the functions exist but have never been run in anger.

## On live updates

The brief warns about a Realtime warm-up problem seen in Everytinroom staging.
The two Bedtime apps hold 6 subscriptions. I have **not** measured delivery
latency, because that needs real infrastructure.

What I would do rather than copy the existing approach: the POS already
re-counts headline figures in the database on every load
(`src/lib/counts.js`), which survives a missed notification by construction.
Extending that to revision-based polling for sales, stock and orders would
make correctness independent of delivery, and Realtime then becomes a latency
optimisation rather than the source of truth. That is a recommendation, not
something done.
