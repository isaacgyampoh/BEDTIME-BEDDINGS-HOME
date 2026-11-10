# Bedtime recovery report

**10 November 2026.** Every figure measured directly against production.

## The headline: there is nothing to recover

The brief describes a database whose hostname stopped resolving and records to
be recovered from backups. That was the situation on 26 October. **It is not
the situation now.** The project was restored, and it has been serving the
shop continuously since.

Checked today, not assumed:

```
$ dig +short wqkgfvmvuljzexhevlnp.supabase.co
172.64.149.246
104.18.38.10

$ curl -o /dev/null -w '%{http_code} in %{time_total}s' .../rest/v1/
401 in 0.049693s
```

It resolves, it answers in 50 ms, and 401 is the correct answer to an
unauthenticated request. Every number in these seven documents was read out of
it today.

## The figures in the brief are below reality

This matters more than it looks. The brief gives "approximately 659 products,
400 sales, 348 customers and 40 orders" as what to recover.

| | Brief expects | Production holds today | Difference |
|---|---|---|---|
| products | ~659 | **631** | −28 |
| sales | ~400 | **1,283** | **+883** |
| customers | ~348 | **1,106** | **+758** |
| orders | ~40 | **607** | **+567** |

**Restoring to the brief's figures would destroy 883 sales, 758 customers and
567 orders.** They are not a recovery target; they are a stale snapshot from
before the shop's busiest three months. Treated as a goal, this brief would
have caused the data loss it was written to prevent.

The live totals those records carry:

| | |
|---|---|
| lifetime revenue | **GHS 595,706.00** (1,265 live sales, 18 voided) |
| lifetime profit | GHS 204,461.50 |
| inventory on hand | 2,182 units, GHS 325,621.00 retail, GHS 197,803.00 at cost |
| customer lifetime spend | GHS 596,126.00 across 1,271 recorded visits |
| order value | GHS 252,219.00 |
| product photos | 1,089 objects, 303.3 MB, **0 broken** |

## Why the hostname stopped resolving

The project was deleted on 26 October and later restored. A deleted Supabase
project's hostname stops resolving immediately — that is the symptom of
deletion, not of a DNS fault, which is why no DNS investigation would have
found anything. Nothing in this repository caused it and nothing here can
prevent it; it is an account-level action.

What it exposed is worth keeping: this repository could not have rebuilt
production. Migrations 048 and 051 close that gap (see
BEDTIME-DATABASE-INVENTORY.md), and the restore path is now tested end to end.

## What cannot be read with the access available

Five tables refuse the public key, which is RLS working correctly — but it
means **a complete migration dataset cannot be produced from here**:

| table | status | what is in it |
|---|---|---|
| `staff` | HTTP 401 | **staff accounts and PINs** — the brief asks for these by name |
| `pin_attempts` | HTTP 401 | sign-in rate-limit state |
| `sms_log` | HTTP 401 | SMS audit trail |
| `sms_exempt_numbers` | HTTP 401 | rate-limit exemptions |
| `social_connections` | HTTP 401 | OAuth tokens for social posting |

This is the one hard blocker in the whole brief. A complete copy needs
`pg_dump`, which needs either the database password or the Management API — and
the Management API is refused by this sandbox regardless of which token is
supplied (four have been tried across sessions). The route that works is
authorising the Supabase MCP connector in an interactive session.

**Do not paste any of those credentials into a chat.** The connector exists so
that you do not have to.

## Recovery status by category

| Category | Status | Evidence |
|---|---|---|
| Products and inventory | **Intact, verified** | 631 rows, 2,182 units reconciled |
| Sales and receipts | **Intact, verified** | 1,283 rows, GHS 595,706.00, every receipt number preserved |
| Customers | **Intact, verified** | 1,106 rows, GHS 596,126.00 |
| Orders | **Intact, verified** | 607 rows, GHS 252,219.00, every order number preserved |
| Expenses | **Intact** | 5 rows, GHS 1,236.00 — see the note below |
| Product images | **Intact, verified** | 890 referenced, 0 broken |
| Price history | **Intact** | 134 rows |
| Bundles, promos, social posts | **Intact** | 4 / 1 / 1 |
| Staff accounts and PINs | **BLOCKED** | table refuses the public key |
| Suppliers and purchases | **Empty, not missing** | `invoices` has 0 rows and a policy granting public read, so a zero here is a zero |
| Refunds, stock takes, stock adjustments | **Empty, not missing** | same — all three readable and genuinely empty |

Nothing was invented and nothing synthetic was substituted anywhere.

**On expenses:** 5 rows totalling GHS 1,236 against GHS 595,706 of revenue.
Not a recovery failure — that is all that was ever recorded. It does mean the
"profit" figure is gross margin, not money earned, and should not be read as
the latter.
