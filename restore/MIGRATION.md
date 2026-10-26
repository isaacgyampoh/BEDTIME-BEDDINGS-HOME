# Where the shop's database lives, and what happened to it

**Status on 26 October 2026: the shop is down. The Supabase project is gone.**

---

## 1. What happened

`wqkgfvmvuljzexhevlnp.supabase.co` no longer resolves in DNS — not on Google's
resolver, not on Cloudflare's, not on Quad9 — while `supabase.co` itself
resolves normally. A *paused* Supabase project still resolves and answers HTTP
with a "project paused" response. A hostname that has stopped resolving
altogether means the project has been **deleted**.

What this looks like to a customer and to the shop:

| | |
|---|---|
| bedtimehome.com | loads, hero and navigation render, **no products at all** |
| admin.bedtimehome.com | loads, **nobody can sign in** — the PIN check is a database call |
| the till | cannot ring up a sale, look up stock, or print a receipt |
| daily SMS reports | stopped |
| online orders and payments | cannot be placed |

The browser's own network log for bedtimehome.com shows every request failing
with `ERR_NAME_NOT_RESOLVED`:

```
ERR net::ERR_NAME_NOT_RESOLVED  …/rest/v1/products?select=id,name,cat…
ERR net::ERR_NAME_NOT_RESOLVED  …/rest/v1/promos?select=*&active=eq.true
ERR net::ERR_NAME_NOT_RESOLVED  …/rest/v1/bundles?…
ERR net::ERR_NAME_NOT_RESOLVED  …/rest/v1/store_settings?…
```

The two websites themselves are fine. They are static files on Cloudflare
Pages and they are serving correctly. Only the database they talk to is gone.

## 2. What Supabase was doing for this project

It was not "the database". It was the entire backend. There is no server
process in this repository — both applications talk to Supabase directly.

| Supabase service | Used for | Calls in the code |
|---|---|---|
| PostgreSQL | every table | 22 tables, 46 migrations, 4,295 lines |
| PostgREST | **the whole API** — there is no other one | 68 table calls across 18 tables |
| Stored procedures | sales, refunds, PIN checks, order pricing | 11 distinct functions, 55 `SECURITY DEFINER` |
| Row Level Security | who may read what | 49 policies |
| Storage | every product photo (`product-images` bucket) | 3 call sites |
| Edge Functions | payments, SMS, WhatsApp, USSD, voice | 6 functions, 2,341 lines, 26 call sites |
| pg_cron + pg_net | the daily reports and reconcilers | 17 scheduled jobs |
| Realtime | live updates between till and screen | 4 subscriptions |

Supabase Auth was **not** used — staff sign in with a PIN checked by a database
function, which is why losing the database also means losing the ability to log
in at all.

## 3. What can be recovered, and what cannot

**The schema: fully recoverable.** The 46 migrations in `supabase/migrations/`
describe every table, function, policy, trigger and scheduled job. This has
been rebuilt from nothing and tested — see section 5.

**The data: no copy exists that I can find.** Checked and all empty:

- no `.dump`, `.sql.gz`, backup or CSV anywhere in the repository
- nothing matching in `~/Downloads`, `~/Desktop` or `~/Documents`
- the migrations contain schema only, no rows
- no Supabase CLI link or local snapshot in `supabase/.temp`
- **the service worker deliberately does not cache API responses** — it was
  changed to app-shell assets only (`public/sw.js`, cache `bedtime-pos-v3`),
  precisely so customer data never sat in device caches
- the apps keep only a cart, a "recently viewed" list and the buyer's own
  details in `localStorage` — a handful of products at most

What that data was, from the last time it was counted: **659 products**,
roughly **400 sales**, **348 customers**, **40 web orders**, the expense
ledger, staff records and PIN hashes, and every product photo in Storage.

### The one thing worth trying immediately

**Contact Supabase support and ask whether the project can be restored.**
Deleted projects are sometimes recoverable for a limited period, and that
period is short. This is time-critical and only the account owner can do it.
Ask specifically for a restore of project ref `wqkgfvmvuljzexhevlnp`, or for a
copy of its most recent automated backup.

Also worth checking in the Supabase dashboard: whether the project was deleted
deliberately, whether it sits in another organisation on the same account, and
whether any paid-plan backup exists.

## 4. Render: what the audit found

The Render account (`rnd_…`, read-only audit) holds:

| Resource | Plan | Belongs to |
|---|---|---|
| gameclaw-api, zazi-web, zazi-api | web services | other projects |
| zazi-postgres | 0.1c-256mb | another project |
| gameclaw-db | basic_256mb | another project |

**Nothing for BEDTIME.** Reusing `zazi-postgres` or `gameclaw-db` would put a
different business's books inside another project's database, which the brief
rules out, and both are small instances already serving something else.

### What moving to Render would actually mean

Render gives a PostgreSQL database and somewhere to run a server. It does not
give the four Supabase services this project leans on hardest:

- **PostgREST** — the API. 68 table calls and 11 RPC calls assume it. Without
  it every one of those has to be replaced with a hand-written endpoint, or
  PostgREST has to be self-hosted as a container.
- **Storage** — product photos. Render has no object storage; this needs
  Cloudflare R2, S3 or similar, plus re-uploading every image and rewriting
  every `image` column.
- **Edge Functions** — 2,341 lines of payments, SMS, WhatsApp and USSD
  handling, deployed as Deno functions. They would become a Node service.
- **pg_cron / pg_net** — 17 scheduled jobs. Render Postgres has neither.
  Render Cron Jobs are **not available on the free tier**.

Verified from Render's own documentation on 26 Oct 2026:

- Free web services **spin down after 15 minutes** of no traffic, and a cold
  start "takes about one minute". A shop's till and storefront cannot wait a
  minute for the first customer of the morning.
- Free Render Postgres **expires 30 days after creation**, with a 14-day grace
  period before Render deletes the database and its data. Storage is fixed at
  1 GB, and only one free database is allowed per workspace.
- Cron Jobs are not offered as free instances.

So a working Render setup means paid instances for at least the database and
the API service, plus object storage elsewhere, plus rewriting the four
services above. Exact paid prices are not on a page that can be read
automatically — confirm them at render.com/pricing before committing.

## 5. What has been built and tested

`restore/` rebuilds the entire database on any PostgreSQL — Supabase, Render,
or a local one — from nothing:

```bash
./restore/restore.sh "postgres://user:pass@host/dbname" --with-fixes
```

- `00-prelude.sql` supplies what a Supabase project provides and a plain
  PostgreSQL does not: the `extensions`, `auth` and `storage` schemas, pgcrypto
  and uuid-ossp, the `anon` / `authenticated` / `service_role` roles and their
  default grants, the Storage tables, the realtime publication, and — where
  pg_cron and pg_net are unavailable — stand-ins that record what *would* have
  been scheduled without pretending to run it.
- `restore.sh` then applies the migrations **one file at a time, in order**.

Verified against an empty PostgreSQL on 26 Oct 2026:

```
40 applied, 0 failed
042, 045 and 046 applied
tables 21 · functions 36 · RLS policies 42 · scheduled jobs 17 · products 0
```

and the restored database was then exercised, not just inspected:

| Check | Result |
|---|---|
| add a staff member | `{"id": "11986e86", "success": true}` |
| that PIN signs in | `{"name": "PRINCE", "role": "Cashier", …}` |
| ring up a sale as `anon` | `{"success": true, "receiptNo": "RCP20261026-001"}` |
| stock after selling 2 of 10 | `8` |
| the daily SMS job | `morning-sms at 0 8 * * 1-6` |

**It restores the schema. It does not restore the data** — there are no rows to
restore until a dump is recovered.

> An earlier version of this concatenated the migrations into one large file.
> That silently swallowed a `CREATE TABLE`: psql exited 0, echoed the
> statement, and the table was not there afterwards. One file at a time cannot
> fail that way, and each file's result is reported.

## 6. The recommendation

**Getting the shop trading again and migrating platforms are two different
jobs, and only the first is urgent.**

| | A new Supabase project | Render |
|---|---|---|
| Shop trading again | within the hour | days to weeks |
| Code changes | one URL and one key | replace PostgREST, Storage, Edge Functions, cron |
| Cost | free tier, as before | paid database + paid service + object storage |
| Risk | the path already proven | four subsystems rewritten at once, under outage |

Create a new Supabase project, run `restore.sh` against it, point the two
applications at it, and the shop is open. Then decide about Render calmly, with
the business running and a backup in hand.

If you still want Render afterwards, the sane order is: database first (the
restore script already works there), then PostgREST in a container so the 79
existing calls keep working untouched, then Storage, then the Edge Functions,
then the scheduled jobs.

## 7. What only you can do

1. **Ask Supabase support to restore `wqkgfvmvuljzexhevlnp`**, today. This is
   the only route to the 659 products, 400 sales and 348 customers.
2. **Say whether the project was deleted deliberately** — if it was part of
   moving to Render, the data went with it and that changes what we do next.
3. **Rotate the Render API key** that was pasted into the chat, and the
   Supabase token before it.
4. Decide: new Supabase project now, or wait for a support answer first. The
   shop is closed online until one of those happens.

## 8. Rolling back

Nothing has been changed on any live system. No Render resource was created, no
database was written to, no credential was stored. The only changes are new
files in this repository (`restore/`), which run nothing by themselves.

If a Supabase restore succeeds, discard `restore/` and carry on — the apps
already point at that project ref and need no change at all.
