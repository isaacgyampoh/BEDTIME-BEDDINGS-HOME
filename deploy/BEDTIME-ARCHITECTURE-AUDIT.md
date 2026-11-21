# Bedtime — architecture and dependency audit

**Phase A. 21 November 2026.** Everything below was measured, not assumed:
the database over a privileged connection, the functions over the Management
API, the VPS from outside. Figures move — the shop traded while this was
written.

## The headline for the migration plan

Three things change what I told you before, and one of them is my fault.

1. **Supabase Auth is now in use.** I had this as "not used — staff sign in
   with a PIN", and the project manifest says `auth: false`. `auth.users` has
   one row, created **18 November**, last sign-in **today**, email
   `staff.<id>@staff.invalid`. That is exactly the address
   `super-service`'s `staff-login` mints. The deployed function was v12 from
   15 September; **I deployed v13 on 18 November**, which is when the user
   appeared. So my deploy turned on a dependency, and GoTrue now has to be
   part of this migration.

2. **Only three Edge Functions are deployed, and one is not in this
   repository.** `hyper-service` v5, last updated 31 July, source unknown.
   `paystack-webhook` is **not** deployed, so the live payment path is
   `super-service`, whose `charge.success` handler marks an order Paid with no
   amount comparison at all.

3. **There are no foreign keys.** Not one, across 24 tables. Referential
   integrity lives entirely in application and function code, which means a
   restore cannot be validated by letting PostgreSQL check the constraints —
   it has to be validated by comparing figures.

## Frontend and hosting

| | |
|---|---|
| POS (`admin.bedtimehome.com`) | React 18 + Vite + Tailwind + Zustand, hash routing |
| Shop (`bedtimehome.com`, `www`) | React 19 + Vite |
| Hosting | Cloudflare Pages — `bedtime-admin`, `bedtime-shop` |
| Desktop | Electron wrapper, serial receipt printer |
| Backend | **none of its own.** PostgREST *is* the API |
| Offline | a cart survives a restart via `localStorage`; no offline write queue |

Repointing the apps is one variable each: `VITE_SUPABASE_URL`. No code change.

## Supabase project

| | |
|---|---|
| ref | `wqkgfvmvuljzexhevlnp` |
| name | **Mimi** |
| region | **eu-central-1** |
| database size | **23 MB** |

Small enough that the data is never the hard part of this migration.

### Database objects, `public` schema

| | |
|---|---|
| tables | 24 |
| views | 2 — `staff_safe`, `social_connections_safe` |
| materialized views | 0 |
| functions | 33 |
| triggers | 4 |
| indexes | 59 |
| sequences | 5 |
| RLS policies | 54 |
| **foreign keys** | **0** |
| primary keys | 24 |
| unique constraints | 5 |
| check constraints | 1 |

### Extensions

`pg_cron` 1.6.4 · `pg_net` 0.20.4 · `pgcrypto` 1.3 · `uuid-ossp` 1.1 ·
`pg_stat_statements` 1.11 · `supabase_vault` 0.3.1 (**0 secrets stored**)

`pg_cron` and `pg_net` need `shared_preload_libraries`. The vault being empty
matters: no function secret is recoverable from a database dump.

### Sequences — these must carry their values

| | |
|---|---|
| `ussd_code_seq` | **50648** |
| `sms_log_id_seq` | 2388 |
| `pin_attempts_id_seq` | 5772 |
| `product_price_history_id_seq` | 159 |
| `social_audit_log_id_seq` | unused |

A reset `ussd_code_seq` would reissue codes customers already hold.

### Rows (exact, 21 November)

`pg_stat_user_tables.n_live_tup` reported **0 for `staff`**, which has two
rows. It is an estimate. These are counted.

| table | rows | | table | rows |
|---|---|---|---|---|
| sales | **1,380** | | staff | 2 |
| customers | **1,192** | | wa_agent_settings | 2 |
| products | **671** | | sms_exempt_numbers | 2 |
| whatsapp_orders | **644** | | social_posts | 1 |
| product_price_history | 159 | | store_settings | 1 |
| sms_log | 108 | | invoices, refunds | 0 |
| pin_attempts | 61 | | stock_adjustments, stock_takes | 0 |
| expenses | 5 | | wa_conversations, wa_messages | 0 |
| bundles | 4 | | social_audit_log, social_automation_rules | 0 |
| promos | 3 | | social_connections | 0 |

Empty is not unused: `invoices`, `refunds`, `stock_takes` and
`stock_adjustments` all have working UI and SQL behind them.

## Storage

| bucket | access | objects | size |
|---|---|---|---|
| `product-images` | **public** | **1,147** | **317 MB** |
| `invoice-photos` | **public** | 0 | 0 |

`invoice-photos` being public is worth a decision before it is recreated on R2:
a supplier invoice is not a product photo, and 0 objects today is the cheapest
moment to make it private.

**890 of the product images are referenced; 282 of those references are not
`products.image` but item snapshots on past receipts, orders and bundles.** So
the stored URL must not be rewritten — `src/lib/imageHost.js` already chooses
the host at render time, which is what makes the move a flag.

## Realtime

Publication `supabase_realtime`, insert/update/delete, **4 tables**:
`products`, `sales`, `whatsapp_orders`, `store_settings`.

The apps hold 6 subscriptions. The POS already re-counts its headline figures
in the database on load (`src/lib/counts.js`), so correctness does not depend
on a notification arriving — which is the right basis for choosing a
replacement.

## Edge Functions

**Deployed (via the Management API):**

| slug | version | updated | in this repo? |
|---|---|---|---|
| `hyper-service` | v5 | 31 Jul 2026 | **NO** |
| `sms-reports` | v6 | 18 Nov 2026 | yes |
| `super-service` | v13 | 18 Nov 2026 | yes |

**In the repository but NOT deployed:** `paystack-webhook`, `wa-agent`,
`whatsapp-bot`, `ussd-handler`.

**Called by cron but not deployed at all:** `charge-momo`.

`hyper-service` has to be resolved before cutover: it is running, something
may call it, and it cannot be migrated from a source nobody has.

## Scheduled jobs — 16, where 7 belong

Three generations stacked, because each migration only unscheduled its own
names.

| generation | count | shape | state |
|---|---|---|---|
| `*-report` | 4 | `charge-momo?action=report&...` | target **not deployed** — send nothing |
| `*-sms` | 6 | `sms-reports?type=...` with a **service-role JWT inline in the job command** | 3 worked, 3 were silent until 18 Nov |
| `sms-*`, `payment-reminder`, `tiktok-status` | 6 | `private.call_edge(...)` | the intended shape |

`cron.job_run_details` says **"succeeded"** whenever `net.http_post`
*dispatched* the request, whatever the function answered. It cannot distinguish
a working report from a silent one. Only `sms_log` can.

Staged as `supabase/pending/052`, which disables rather than drops.

## Integrations

| | |
|---|---|
| Payments | NaloPay (live), Moolre (coded, unused), Paystack (webhook verification only) |
| SMS | mNotify (live — 108 rows in `sms_log`), Arkesel (coded) |
| WhatsApp | WaSender |
| AI | OpenAI (voice/agent) |
| Social | TikTok (a `tiktok-status` job runs every 10 minutes) |

**No credential is shared with Everytinroom, and none should be assumed to
be.** The vault is empty, so every function secret lives only in Supabase's
write-only store and must be re-entered on the server from its own provider
portal.

## The Contabo VPS, from outside

I have **no SSH access**, so this is external observation only.

| | |
|---|---|
| 169.58.120.116:22 | open |
| :80, :443 | open |
| **:5432** | **closed** — PostgreSQL is not exposed publicly, as required |
| `pos-api.erbliving.shop` | → 169.58.120.116, Let's Encrypt, issued **today 07:41 GMT** |
| what answers :443 | **PostgREST** (`PGRST126` — root metadata disabled) |

So the server already runs a Supabase-compatible stack behind TLS. Bedtime
joins it as a tenant: its own database, its own roles, its own PostgREST, its
own hostname. `~/everytinroom-pos/deploy/provision-app.sh --name bedtime` is
built for exactly that.

## Everytinroom — hands off

Its cutover runbook has **every pre-flight box ticked today**: off-site
backups verified by a real restore (31/31 identical), the API hostname and
certificate live, 1,155 storage objects copied, both builds prepared with zero
references to the old project.

It is poised for cutover, not mid-cutover. Nothing in this audit touched the
server, and no Bedtime work should run during its window.

## Risks, worst first

| # | risk | why it matters |
|---|---|---|
| 1 | **The live payment path has no amount check** | `super-service` settles `charge.success` without comparing the amount. A GHS 1 payment settles a GHS 770 order. The fix exists in `paystack-webhook`, which is **not deployed**. |
| 2 | **`hyper-service` is running from unknown source** | cannot be migrated, cannot be reviewed, and something may depend on it |
| 3 | **No foreign keys** | a restore cannot be validated by constraint checking; figures must be compared instead |
| 4 | **Supabase Auth is now live** | GoTrue must be provisioned, or `staff-login` reworked. My 18 Nov deploy caused this. |
| 5 | **Six cron jobs carry a service-role JWT inline** | readable by anyone with database access |
| 6 | **Secrets exist only in Supabase's write-only store** | a dump recovers none of them; each must come from its own provider portal |
| 7 | **`ussd_code_seq` at 50648** | reset it and customers' existing codes collide |
| 8 | **The public data exposure** | sales, customers, expenses and orders are readable with the key in the browser bundle. 043/044/047 are staged and were gated on a real session — which now exists |

## What I cannot do without you

**SSH access to 169.58.120.116.** Phases B through F all need it: provisioning
the database, the services, the staging endpoint, the backups, and running the
tests against the real server rather than a local copy.

The keys on this machine (`~/.ssh/everytinroom_contabo`,
`everytinroom_contabo_rsa`) are refused by the server, and there is no
`~/.ssh/config`, so the `ssh etr` alias the Everytinroom tooling uses was set
up elsewhere. I stopped after one refusal rather than trying combinations.

Everything in Phase A that does not need the server is done.
