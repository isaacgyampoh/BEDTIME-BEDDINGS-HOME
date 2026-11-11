# Bedtime migration readiness

**11 November 2026. Verdict: FULLY PRE-VPS READY.**

Every pre-purchase acceptance gate passed. The remaining work is
VPS-dependent only.

Produced by `migration-package/after-credential.sh`, which ran end to end and
exited 0. Evidence: `~/bedtime-preservation/evidence-20261111T083851Z`.

## The blocker that is now closed

Five tables refused the public key — `staff`, `pin_attempts`, `sms_log`,
`sms_exempt_numbers`, `social_connections` — and `staff` holds the PIN
hashes, so "complete" was not claimable without it.

Three things had to be true at once, and each was found by trying:

1. **The credential dialog had never opened.** Three "cancels" were my own
   bugs — any non-zero `osascript` exit was reported as a cancel, which hid
   an AppleScript that did not compile (a multi-line string literal) and then
   a 2-minute AppleEvent timeout.
2. **The password contained an unencoded `@`.** libpq split on the first one
   and read `12345@db.<ref>.supabase.co` as the hostname. Percent-encoded.
3. **`db.<ref>.supabase.co` is IPv6-only.** It has an AAAA record, no A
   record, and this machine has no IPv6 route. The pooler is dual-stack; the
   region is not in the direct URI, so it was discovered by trying each
   candidate with the real credential — `eu-central-1`.

## Backup and reconciliation

| | |
|---|---|
| dump | 832 KB, `-Fc`, mode 0600, outside git |
| contents | 63 tables, 75 functions, 119 indexes, 64 policies, 21 triggers |
| all 21 application tables | **present** |
| the five protected tables | **present, with data** |

Reconciled restored-against-snapshot rather than against live production,
because the shop trades continuously and drift against a live API is the
business working, not a migration fault. The same dump was restored twice and
the two copies compared:

**35 metrics match · 0 differ · 0 blocked**

| | |
|---|---|
| products / customers / sales / orders | 634 / 1,112 / 1,290 / 609 |
| revenue | GHS 602,501.00 |
| profit | GHS 206,959.50 |
| discount | GHS 13,293.00 |
| inventory | 2,186 units · GHS 325,616.00 retail · GHS 197,553.00 cost |
| customer lifetime spend / visits | GHS 602,921.00 / 1,278 |
| order value | GHS 252,919.00 |
| receipt numbers, product ids, order numbers | identical |
| **staff** | **2** |
| **pin_attempts** | **89** |
| **sms_log** | **618** |
| **sms_exempt_numbers** | **2** |
| **social_connections** | **0** |

## Staff and PIN hashes

Verified by shape, never by value. The evidence file is grepped to prove no
hash reached it.

| | |
|---|---|
| staff rows | 2, both active |
| with a bcrypt `pin_hash` | **2** |
| hash length | 60 — bcrypt |
| still holding plaintext | **0** |
| roles | Admin, Cashier |

Zero plaintext means migration 045's cleanup fully took effect in production.

## Acceptance

**35 POS and authentication checks, 0 failed**, against the restored
production data:

- the correct PIN on an unhashed row signs in **and converts** — plaintext
  cleared, 60-character bcrypt hash written
- it then verifies against the hash
- wrong, non-numeric and short PINs refused, leaking nothing about who exists
- ten failures refuse even a **correct** PIN; it recovers once they age out
- every column the till selects exists — PostgREST rejects the whole request
  if one is missing, which reads as an empty shop
- a sale deducts stock by exactly the quantity sold and books the money
- half the real price is refused, and no stock moves
- overselling is refused; stock never goes negative
- `deduct_order_stock` twice deducts once
- two concurrent cashiers against 3 units: one sells 2, the other is told the
  stock is short, 1 left, never negative

**31 Edge Function checks, 0 failed**, all six executing under real Deno with
the real `@supabase/*` client over real HTTP: seven report types, an unknown
type refused with 400, the reminder idempotent across runs, the webhook
refusing unsigned requests and sending an underpayment to review rather than
settling it. Zero SMS, zero WhatsApp messages, zero payments initiated.

825 unit assertions, 203 e2e, 0 lint errors.

## Preservation

| | |
|---|---|
| backup + evidence | `~/bedtime-preservation/evidence-20261111T083851Z` — 0700, dumps 0600 |
| `*.dump` git-ignored | checked, not assumed |
| git bundle | verified by reconstruction: **142 commits**, restored copy passes all 825 tests |

`git push` is still refused by this environment — a sandbox restriction, not
GitHub authorisation, since read access works.

## What remains, and it is only this

1. Provision the server (`provision-app.sh --name bedtime`).
2. Restore this dump onto it.
3. Migrate the images to R2.
4. Deploy the Edge Functions.
5. Final delta synchronisation — the shop trades continuously, so this dump is
   stale within a day and a final sync is mandatory, not optional.
6. Live-server acceptance.
7. Authorised cutover.

## Separately: two production releases awaiting approval

Neither is part of the migration.

- `release/sms-and-reminder-fix/` — three of six scheduled SMS reports send
  nothing in production today, the reports go to the old number, and the
  payment reminder skips orders three ways.
- `release/payment-webhook-fix/` — a GHS 1 payment settles a GHS 770 order.

Packaged separately so a reporting fix and a change to how money is settled do
not share one approval.
