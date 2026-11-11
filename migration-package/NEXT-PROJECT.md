# Onboarding the next Supabase project

Written after preparing Bedtime, for whoever does the third one. Bedtime is
finished to the point where only access is missing, so this is the reusable
part.

## What to reuse, and what not to

**Reuse:** `~/everytinroom-pos/deploy/` — the platform, `provision-app.sh`,
`bootstrap.sh`, the compose stack, `backup.sh`, the acceptance framework. One
VPS, one Postgres, one tenant per business.

**Do not reuse:** anything in this repository's `migration-package/`. It is
Bedtime-specific by design. Copy `MANIFEST.yml`, rewrite it, and point
`deploy.sh` at it.

**Do not put a business's rules or secrets into the platform.** The platform
should not know that Bedtime exists.

## The steps that actually mattered

In the order they paid off.

### 1. Check the brief's premises before acting on them

Bedtime's brief asked to recover a database "whose hostname stopped
resolving", to figures of 659 products / 400 sales / 348 customers / 40
orders. The hostname resolved in 50 ms, and production held 631 / 1,283 /
1,106 / 607. **Restoring to the brief's figures would have destroyed 883
sales.** A stale snapshot in a brief reads exactly like a recovery target.

Measure first. Treat every number you are given as historical.

### 2. Rebuild the schema from committed migrations into an empty database

```sh
createdb <app>_v1 && ./restore/restore.sh "postgres://$(whoami)@localhost/<app>_v1"
```

Then **load the real rows into it** and see which columns have nowhere to go.
That is how both of Bedtime's remaining drifted columns were found, and one of
them would have made the till load no products at all.

Comparing what the application *selects* is not enough: a column touched only
inside a SQL function is invisible to that method. Bedtime's
`whatsapp_orders.stock_deducted` is only ever read and written by a stored
function, and the earlier audit missed it for exactly that reason.

### 3. Make the restore default reproduce production

Bedtime's restore script held back the migrations production actually had, so
its default output was a database **nobody could sign into**. A recovery
script whose default output cannot be logged into is not a recovery script.

Check which migrations the live project really has, and make that the default.

### 4. Decide services by measurement

`inspect-supabase.py` counts rows in `auth.users` rather than assuming. Bedtime
has none — staff sign in with a PIN — so GoTrue is off and ~256 MB is not spent
serving nothing. Do the same for Realtime and Storage.

### 5. Execute the Edge Functions, do not compile them

This is the one that found the most. Bedtime's `sms-reports` parsed perfectly
and **three of its six scheduled reports had been sending nothing** — the
schedule asked for `midday`, `lowstock` and `monthly`; the function handled
`afternoon` and returned HTTP 200 for the rest, so cron logged success.

Cross-reference the scheduled job list against the handled cases:

```sh
comm -23 <(grep -oE 'type=[a-z]+' supabase/migrations/*cron*.sql | sed 's/.*type=//' | sort -u) \
         <(grep -oE "case '[a-z]+'" supabase/functions/<fn>/index.ts | sed "s/case '//;s/'//" | sort -u)
```

Then extract the logic into `_shared/*.js` with an injected data source so
Node can run it. Deno may not be installable. A function whose decisions live
in a shared module can be tested without deploying anything.

### 6. Reconciliation must be a committed script

Bedtime's first reconciliation lived in a scratch directory the next session
deleted, so the figures in the reports could not be re-derived. It is
`migration-package/scripts/reconcile.mjs` now. Businesses trade while you
work — Bedtime's revenue moved GHS 6,795 in one afternoon.

### 7. Credentials: build the entry mechanism, do not ask

Five personal access tokens were pasted into chat across these sessions, none
of which was the credential needed. `scripts/enter-db-credential.sh` is the
answer: a native masked dialog into the login Keychain.

Three things that do **not** work, each found by testing:

| | |
|---|---|
| `security add-generic-password -w <value>` | the secret lands in `argv`, where `ps` shows it |
| piping into `security -w` with no value | silently stores an **empty** password |
| `security -i` with shell-style quoting | truncated a password containing `'` from 81 chars to 28 |

What works: base64 the value (reducing it to `[A-Za-z0-9+/=]`) and pass it
through `security -i` on stdin. Round-trip verified with `' " $ ! # & * ( ) [ ] { }`.

Accept every shape the dashboard offers — URI, `postgres://`, a `psql "…"`
wrapper, and the `host=… password=…` keyword form — and reject the
`[YOUR-PASSWORD]` placeholder, because it passes a shape check and then fails
at dump time with something unhelpful.

### 8. Know which credential you need

A `sbp_` personal access token drives the **Management API**. The database
password drives **Postgres**. `pg_dump` needs the second. Conflating them
cost several rounds on Bedtime.

Also: `db.<ref>.supabase.co` no longer resolves for current projects. The path
is `aws-0-<region>.pooler.supabase.com:5432`, and the region is in the
dashboard's connection string — which is why asking for that one line gets
both facts at once.

## The checklist, short form

1. Measure production. Do not trust the brief's figures.
2. Rebuild from migrations into an empty database; load real rows; fix the drift.
3. Make the restore default match production, then sign into it.
4. Decide services by measurement, not by default.
5. Cross-reference scheduled jobs against handled cases.
6. Extract function logic to `_shared/*.js`; execute it in Node.
7. Commit the reconciliation script.
8. Build the credential dialog before anyone offers a token.
9. Write the manifest; leave `deploy.sh` generic.
10. Separate the verdicts: pre-VPS readiness is not cutover readiness.

## Improvements worth lifting into the platform

Verified against Bedtime, not yet applied to Everytinroom — check they do not
break it first.

- **The scheduled-job / handler cross-reference** as a platform check. It
  found a live three-of-six failure here and nothing else would have.
- **`enter-db-credential.sh`** is generic apart from the service name. It
  belongs in `deploy/scripts/`, taking the app name as an argument.
- **A `--pending` style flag on restore**, so "production's state" and
  "everything in the repository" are separate and the default is the former.
- **Reconciling credential *shape*** — row counts and hash presence, never
  values — so `staff` can be verified without ever selecting a PIN.

---

## Added after finishing Bedtime

The three things that actually cost time at the end, so project three does not
repeat them.

### 9. Connecting to Supabase Postgres is three problems, not one

All three had to be solved before a single byte could be dumped, and each was
hidden by the one before it.

**`db.<ref>.supabase.co` is IPv6-only.** Supabase retired IPv4 on direct
connections. It has an AAAA record and no A record, so a machine without an
IPv6 route cannot reach it at all:

```sh
dig +short A    db.<ref>.supabase.co     # empty
dig +short AAAA db.<ref>.supabase.co     # 2a05:...
```

The pooler is dual-stack and is the path. It needs a **different username** —
`postgres.<project-ref>`, not `postgres` — and a region in the hostname.

**The region is not in the direct URI.** Discover it by trying each pooler
host with the real credential: "Tenant or user not found" means the wrong
region, an auth failure or a success means the right one. Bedtime is
`eu-central-1`. `scripts/repair-db-url.sh` does this.

**A password containing a reserved character breaks the URI.** `@` in the
userinfo must be `%40`. Unencoded, libpq splits on the first `@`:

```
could not translate host name "12345@db.<ref>.supabase.co" to address
```

Percent-encode the password before use, and never print it to find out.

### 10. A diagnostic that collapses failures is worse than none

The credential dialog was "cancelled" three times. It had **never opened**.
The script turned every non-zero `osascript` exit into `Cancelled`, which hid
an AppleScript that did not compile and then a 2-minute AppleEvent timeout.
Three rounds were spent asking the owner to do something impossible.

For any dialog: distinguish `-128`/"User canceled" from everything else, print
the real error, go through `System Events` with `activate` so it does not open
behind a browser, and wrap it in `with timeout of 1800 seconds`.

### 11. Verify the verification

Three of the faults found at the end were in the checking, not the thing
checked, and each would have reported a healthy system as broken or a broken
one as healthy:

| | |
|---|---|
| `pg_restore -l` writes `TABLE DATA <schema> <name> <owner>` | anchoring the table name at `$` reported all five protected tables MISSING from a dump that held every one |
| `pg_restore` exits non-zero on any error, and a Supabase dump always errors about absent roles | chaining with `&&` failed a snapshot that had restored fine |
| the webhook harness hardcoded one secret while the runner passed another | every request came back 401 and the suite still printed **"all checks passed"** |

The last is the one to take seriously. **Make every harness fail on demand
before trusting it.** Point it at a deliberately wrong secret, delete the
guard it checks, reintroduce the constraint it tests — and watch it go red.
A harness that cannot fail is not evidence.

### 12. Reconcile against the backup, not against production

A live shop's totals change while you work — Bedtime's revenue moved GHS 6,795
in one afternoon. Comparing a restore with the live API shows drift that is
the business trading, and it is indistinguishable from a migration fault.

Restore the same dump twice and reconcile the two copies. That isolates the
restore path, which is the thing under test.
