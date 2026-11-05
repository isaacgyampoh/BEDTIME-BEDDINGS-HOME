# Reconciliation: the database against the POS

Every figure here was read from production with the public key over PostgREST
on **5 November 2026, 07:45 UTC**. Nothing was invented, nothing was estimated,
and nothing in the database was changed to produce it.

Where a figure differs from one written earlier in this work, the shop has been
trading in between. Two counts also changed because I was wrong the first time,
and both are called out below.

## 1. What the database holds

| table | rows |
|---|---|
| `sales` | **1,137** (16 voided, 1,121 live) |
| `whatsapp_orders` | **532** |
| `customers` | **982** |
| `products` | **625** |
| `expenses` | **5** |
| `refunds` | **0** |
| `invoices` | **0** |
| `stock_adjustments` | **0** |
| `stock_takes` | **0** |

The four empty tables are genuinely empty, not hidden by a policy: all four
grant `SELECT` to `anon` with `USING (true)`, so a zero here is a zero.

## 2. The POS against the database

| Metric | Database | POS before | POS now |
|---|---|---|---|
| Total customers | 982 | **500** | 982 |
| All-time revenue | GHS 526,690.00 | **GHS 255,153.00** | GHS 526,690.00 |
| All-time profit | GHS 184,533.50 | partial | GHS 184,533.50 |
| Sales held in memory | 1,137 | **500** | 1,137 |
| Orders held in memory | 532 | **500** | 532 |
| Cancelled orders | 294 | **293** | 294 |
| Paid orders not booked as sales | 52 | whatever was loaded | 52 |

The revenue figure was not a rounding error. The POS loaded the newest 500 of
1,137 sales, which reached back to 6 October, while the shop's first sale was
15 August — so **GHS 271,537 of trading, 52% of the business, was outside
every total the dashboard showed**, and a report run for August or September
came back empty. The customer list cut at GHS 350 of lifetime spend, so the
482 customers below that were missing from the page entirely.

Verified by opening the POS against live production after the fix: 1,137 /
532 / 982 rows loaded, revenue GHS 526,690, and the status figures summing to
the table total.

## 3. Findings that need your decision

| # | Finding | Figure | Money |
|---|---|---|---|
| 1 | Paid orders with no sale recorded | 52 orders | **GHS 21,303** |
| 2 | Customers stored twice (phone spelled two ways) | 36 people, 72 rows | GHS 60,755 split across them |
| 3 | An order paid then cancelled, with no refund recorded | `WEB-SMS26348`, 3 Sept | **GHS 250** |
| 4 | Orders with a payment reference that never paid | 264 | — |
| 5 | Orders with `paystack_ref = ''` instead of NULL | 33 | — |
| 6 | Expenses recorded against GHS 526,690 of revenue | 5 rows, GHS 1,236 | — |
| 7 | Products with no photo | 23 of 625 | — |
| 8 | Storage objects nothing references | 197, 79.9 MB | — |

**1 — the one that is actually money.** 52 orders are marked Paid and have no
sale row, so their revenue is in no report and their stock was never deducted.
These are not corrupt: the sale is created when someone presses *Process &
Package*, and these are waiting for that. All 185 Completed orders do have a
sale, so the mechanism works. This is a queue, not a fault — but it is
GHS 21,303 of queue, and the dashboard now counts it correctly.

**2 — staged, not applied.** `supabase/pending/049`. Merging preserves the
lifetime total exactly (GHS 527,110 before and after) and moves GHS 60,755
onto the surviving rows. Verified against a local copy of the real 982 rows:
982 → 946, zero duplicated lines, idempotent. Running it also found two faults
in my own file, both fixed and both described in the file.

**3 — worth ten minutes of your time.** GHS 250 was taken on 3 September and
the order was later cancelled. The `refunds` table is empty, so either the
customer was refunded outside the system or they were not refunded at all. I
cannot tell which from here, and it is not something to guess about.

**4 — the recovery opportunity, not a defect.** A reference is created when a
payment is attempted. 264 attempts did not complete. Nothing currently
distinguishes "tried and was declined" from "never tried", which is exactly
the difference between a customer worth chasing and one who has given up —
hence the `payment_attempts` table staged in `supabase/pending/050`.

**6 — not a bug, but it makes one figure misleading.** The profit shown is
revenue minus cost of goods. With GHS 1,236 of expenses recorded against
GHS 526,690 of revenue, "profit" is gross margin and should not be read as
money earned.

## 4. What is clean

Checked and found correct, so no action:

- **0** duplicate receipt numbers across 1,137 sales
- **0** duplicate order numbers across 532 orders
- **0** duplicate payment references
- **0** orders pointing at a sale that does not exist
- **0** orders with no phone number
- **0** orders with a zero or negative total
- **0** products with no cost price *(so the profit figure is not resting on blanks)*
- **0** products with negative stock
- **0** referenced images missing from storage — no broken photos
- **all 185** Completed orders have a customer record

## 5. Two corrections to my own earlier figures

Recorded because both were wrong in the same direction — asserting from a
partial query instead of checking.

1. **"474 unreferenced storage objects."** Wrong; it is **197**. The first
   count matched only `products.image`. In fact 879 storage paths are
   referenced, and 277 of them are on the item snapshots kept with past
   receipts, orders and bundles. That correction changed the R2 design: the
   stored URL is never rewritten, because rewriting it would mean editing
   historical records.

2. **"198 online buyers have no customer record."** Technically true and
   misleading. Broken down by status, every one is Pending, Cancelled, or Paid
   and not yet processed — and the record is created when the order is
   processed. No Completed order is missing one. Not a defect.

## 6. How to re-run this

The numbers above came from read-only PostgREST queries with the public key.
`scripts/healthcheck.sh` covers the live checks; the reconciliation itself was
a one-off script and is not committed, because a report that quietly re-runs
and disagrees with the document next to it is worse than no report.
