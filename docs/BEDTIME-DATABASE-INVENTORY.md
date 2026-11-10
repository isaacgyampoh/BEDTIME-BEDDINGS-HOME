# Bedtime database inventory

**10 November 2026.** Read from production, and from a schema rebuilt out of
this repository and compared against it.

## Tables

21 tables in `public`. Row counts are production's; "readable" means with the
public key, which is the only access this environment has.

| table | rows | readable | notes |
|---|---|---|---|
| `sales` | **1,283** | yes | 1,265 live, 18 voided |
| `customers` | **1,106** | yes | 1,046 distinct people — see the duplicate note |
| `whatsapp_orders` | **607** | yes | web, WhatsApp and walk-in orders |
| `products` | **631** | yes | 608 with a photo |
| `product_price_history` | **134** | yes | 33 rows belong to 31 deleted products |
| `expenses` | 5 | yes | |
| `bundles` | 4 | yes | |
| `promos` | 1 | yes | |
| `social_posts` | 1 | yes | |
| `invoices` | 0 | yes | genuinely empty, not hidden |
| `refunds` | 0 | yes | genuinely empty |
| `stock_adjustments` | 0 | yes | genuinely empty |
| `stock_takes` | 0 | yes | genuinely empty |
| `wa_conversations` | 0 | yes | the 30-day cleanup now works (048 added `updated_at`) |
| `social_audit_log` | 0 | yes | |
| `social_automation_rules` | 0 | yes | |
| `staff` | — | **401** | staff accounts and PINs |
| `pin_attempts` | — | **401** | |
| `sms_log` | — | **401** | |
| `sms_exempt_numbers` | — | **401** | |
| `social_connections` | — | **401** | OAuth tokens |

The four "genuinely empty" tables each carry a policy granting `SELECT` to
`anon` with `USING (true)`, so an empty result is an empty table rather than a
policy hiding rows. That distinction was checked, not assumed.

## Functions, policies, extensions, jobs

Rebuilt from `supabase/migrations/` into an empty PostgreSQL:

```
tables        : 21
functions     : 36
RLS policies  : 42
scheduled jobs: 17
45 migrations applied, 0 failed
```

**Extensions required:** `pgcrypto`, `uuid-ossp`, `pg_cron`, `pg_net`. All four
ship with the `supabase/postgres` image; `pg_cron` and `pg_net` additionally
need `shared_preload_libraries`.

**Authentication:** no Supabase Auth. Staff sign in with a 4-digit PIN checked
by `verify_pin`, which uses bcrypt (`crypt(p_pin, pin_hash)`), locks out after
10 failures in 5 minutes, and converts a legacy plaintext PIN to a hash on
first use. There are no auth users to migrate — usually the hardest part of
leaving managed Supabase, and here it does not apply.

## Schema drift: this repository versus production

Drift runs **both ways**, and every instance was found by rebuilding and
comparing rather than by reading.

### Production has columns the migrations never created

Migration **048** (applied 1 Nov) added seven to `wa_conversations`, three to
`whatsapp_orders` and one to `promos`.

Migration **051** (new, this session) adds the two that 048 missed. 048 was
built by comparing every column the *application selects* against a rebuild,
and that method cannot see a column only ever touched inside a SQL function:

| column | what a rebuild without it does |
|---|---|
| `products.group_tag` | `useStore.js:279` names it in the products select. PostgREST rejects the whole request when a selected column is absent, so the till loads **no products at all** and reads as an empty shop. |
| `whatsapp_orders.stock_deducted` | Migration 035 reads and writes it in `deduct_order_stock` and `restore_order_stock`. Without it the first statement raises: **stock stops being deducted**, silently. |

Both are `ADD COLUMN IF NOT EXISTS`, so against production 051 is a no-op.

### The migrations create something production lacks

`wa_conversations.updated_at` — migration 009 creates the table with it and
the 30-day cleanup job deletes by it, but it was absent from production. That
is how applying 048 failed the first time:

```
ERROR: 42703: column "updated_at" does not exist
```

048 now adds it first. The cleanup job had been failing in production for as
long as the column was missing.

### After 051, drift is zero

Loading all 3,772 production rows into a fresh rebuild reports:

```
SCHEMA DRIFT found while loading
  none
```

## Data-quality findings

Carried over from `RECONCILIATION-2026-11-05.md`, re-measured today:

| finding | figure | money |
|---|---|---|
| Paid orders with no sale recorded | 52 | **GHS 21,303** |
| Customers stored twice (phone spelled two ways) | ~36 people | GHS 60,755 split across them |
| Orders with a reference that never paid | 264 | — |
| Orders with `paystack_ref = ''` rather than NULL | 33 | — |
| Price-history rows for deleted products | 33 rows, 31 products | — |
| One sale with `customer = ''` | 1 | GHS 35 |
| Storage objects nothing references | 199 | 80.3 MB |

The last three are benign. Price history outliving its product is arguably
correct; an empty customer string is a walk-in that was not labelled; and
"nothing references it" is not "nothing needs it", which is why nothing is
deleted.

`supabase/pending/049` merges the duplicate customers and `050` adds a unique
payment reference plus a `payment_attempts` table. Both are staged, tested
against local copies of the real tables, and **not applied**.
