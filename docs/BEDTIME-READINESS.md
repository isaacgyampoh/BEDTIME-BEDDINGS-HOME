# Bedtime migration readiness

**10 November 2026. Verdict: PRE-VPS READY WITH EXTERNAL BLOCKERS.**

Everything buildable without a purchased server is done and executed. Two
things need an authorisation only you can give, and neither needs a purchase.

## Verdicts, kept apart

| | |
|---|---|
| **PRE-VPS READY** | not claimed — one item below is access-blocked, not finished |
| **PRE-VPS READY WITH EXTERNAL BLOCKERS** | **this is the state.** Implementation complete; a privileged backup and the Edge Function deploys await access |
| **NOT READY** | no — nothing in development or staging is failing |
| READY FOR PRODUCTION CUTOVER | **no, and not close.** No server exists and no complete backup has been taken |

## Verified by execution

Against a database rebuilt from committed migrations only, loaded with real
production rows. Not mocks.

| # | Check | Result |
|---|---|---|
| 1 | Clean rebuild from an empty database | **PASS** 45 migrations, 0 failed |
| 2 | Schema drift after 048 + 051 | **PASS** zero columns unaccounted for |
| 3 | Reconciliation, production vs restored | **PASS** 28 metrics match, 0 differ |
| 4 | Identifiers and timestamps preserved | **PASS** receipt numbers, product ids, order numbers |
| 5 | A sale deducts stock and books the money | **PASS** |
| 6 | A tampered price is refused | **PASS** stock untouched |
| 7 | Overselling is refused | **PASS** never negative |
| 8 | Order stock cannot be deducted twice | **PASS** |
| 9 | Two concurrent cashiers cannot oversell | **PASS** 3 units, two 2-unit sales, one refused |
| 10 | PIN sign-in, legacy plaintext row | **PASS** converts to bcrypt, clears plaintext |
| 11 | PIN sign-in against the hash | **PASS** |
| 12 | Lockout after 10 failures | **PASS** refuses even a correct PIN while locked |
| 13 | All six scheduled SMS reports build | **PASS** 6 of 6, from real data, 0 SMS sent |
| 14 | Reports are addressed to 0548124978 | **PASS** |
| 15 | Unit suite | **PASS** 803 assertions |
| 16 | e2e suites | **PASS** 203 assertions, real Chromium |
| 17 | Deployment runner, every step | **RUN** 3 pass, 11 report BLOCKED with the reason |
| 18 | Credential dialog refuses bad input | **PASS** wrong shape, placeholder, empty, cancelled |
| 19 | Restore refuses to overwrite or target a remote | **PASS** |
| 20 | No secret in any tracked file | **PASS** one token, `role=anon`, public by design |

### What execution found that compiling could not

**Three of six scheduled SMS reports were sending nothing.** `midday`,
`lowstock` and `monthly` are scheduled by migration 018; the function handled
`afternoon` (which nothing calls), and the other two were never implemented.
An unhandled type returned HTTP 200, so pg_cron logged six successes a day.
The 1pm figures, the low-stock warning and the month-end summary have never
arrived. Fixed, and an unknown type is now a 400.

**Two columns production has that no migration created.** `products.group_tag`
— named in the products select, and PostgREST rejects the whole request when a
selected column is absent, so a rebuilt till would load **no products at
all**. And `whatsapp_orders.stock_deducted`, read and written by migration
035's stock functions but created by nothing, so **stock would stop being
deducted silently**. Migration 051.

**The restore script's default output could not be signed into.** It held back
042/045/046, producing a pre-045 database where `staff.pin` is `NOT NULL`, in
which `verify_pin` raises on its own conversion `UPDATE`. A cashier with the
correct PIN could not sign in. The default now reproduces production.

## BLOCKED on access, not on work

### 1. A complete production backup

Five tables refuse the public key: `staff`, `pin_attempts`, `sms_log`,
`sms_exempt_numbers`, `social_connections`. That is RLS working, and `staff`
holds the PIN hashes, so there is no "complete" without it.

**Everything except the credential is ready.** The pooler is reachable from
this machine (TCP open, TLS up, speaking Postgres) and `pg_dump` 18.6 is
installed. `scripts/enter-db-credential.sh` shows a native masked dialog and
stores the URI in the login Keychain; `scripts/backup-production.sh` then runs
unattended and `scripts/restore-and-reconcile.sh` restores and reconciles it.

What is needed: the **database password**, from Project Settings → Database →
Connection string → URI. That is not a `sbp_` personal access token — a
different credential, for a different API, which this sandbox refuses anyway.

### 2. Edge Function deploys

Six functions, all parsing, five carrying undeployed changes. Deploys are
refused here. **Until they are deployed your daily reports still go to the old
number and three of them still send nothing.**

### 3. Remote publishing

`git push` is refused by this environment. Read access works, so this is not
GitHub authorisation. **13 commits are local only**, and `.gitignore` excludes
`*.dump` and `.bedtime/`.

## Not tested, and honestly so

Database restart, server failover, cross-tenant isolation on a real host, live
update latency on real infrastructure, R2 against a real bucket — all need a
server or a bucket that does not exist. Returns and refunds have 0 rows in
production and no e2e coverage; the functions exist but have never run in
anger.

Deno could not be installed (external code is refused here), so the five other
functions are verified by parse plus their Node-loadable `_shared` modules.
`sms-reports` is the one verified by execution, because its builders were
extracted for exactly that purpose. The same could be done for the others.

## Figures, which move

Measured today. Revenue read GHS 595,706 in the morning and GHS 602,501 by
the afternoon — the shop trades continuously, so every number here is
historical the moment it is written. `migration-package/scripts/reconcile.mjs`
is committed so it can be re-run rather than quoted.

| | |
|---|---|
| products / sales / customers / orders | 634 / 1,290 / 1,112 / 609 |
| lifetime revenue | GHS 602,501.00 |
| lifetime profit | GHS 206,959.50 |
| inventory | 2,186 units, GHS 325,616.00 retail |
| November so far | GHS 143,854.00 across 316 sales |
| product photos | 1,089 objects, 303.3 MB, 0 broken |
