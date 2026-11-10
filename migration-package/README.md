# Bedtime migration package

Everything needed to put Bedtime on the central self-hosted platform, in one
place, reusable by the central deployment system.

**No VPS has been purchased and nothing here buys one.** Steps that need a
server report BLOCKED and say what is missing.

## Layout

| | |
|---|---|
| `MANIFEST.yml` | Everything project-specific, declaratively. The runner reads this and nothing else about Bedtime. |
| `deploy.sh` | The 15-step sequence. `plan`, a step number, or `all`. Safe to rerun. |
| `scripts/backup-production.sh` | A complete privileged `pg_dump`, with secure credential entry. |
| `scripts/restore-and-reconcile.sh` | Restores a dump into an isolated database and reconciles it. |
| `scripts/reconcile.mjs` | The reconciliation itself. Read-only on both sides. |
| `scripts/enter-db-credential.sh` | Native macOS dialog -> login Keychain. Nothing echoed, nothing in argv, nothing on disk. |
| `scripts/postgrest-shim.mjs` | Serves the slice of PostgREST the Edge Functions use, from a local PostgreSQL — so a function runs under real Deno against real rows instead of being called verified because it parsed. |

Bedtime-specific things stay here. Nothing in this directory belongs in the
shared platform, and no secret is in any of these files.

## Onboarding the next business

Copy `MANIFEST.yml`, change it, and point `deploy.sh` at it. The runner has no
Bedtime knowledge of its own — services, migrations, held-back files, jobs,
secret *names* and reference counts all come from the manifest. That is the
whole of what "reusable" means here.

What the next project should **not** need: a new VPS, a new platform checkout,
or an edit to `provision-app.sh`.

## Current state

```
$ ./migration-package/deploy.sh all
7.  migrations  ✓ clean rebuild from empty: 45 applied, 0 failed
9.  functions   ✓ all 6 parse  ● deploying them is refused here
12. acceptance  ✓ 751 unit assertions · 28 reconciliation metrics match, 0 differ
…
NO-GO for VPS deployment — 11 steps blocked (no server, no privileged dump)
```

## The two real blockers

**1. A complete backup.** Five tables refuse the public key — `staff`,
`pin_attempts`, `sms_log`, `sms_exempt_numbers`, `social_connections` — which
is RLS working. `staff` holds the PIN hashes, so there is no version of
"complete" without it.

This is *nearly* solved. The Supabase connection pooler **is** reachable from
this machine (`aws-0-<region>.pooler.supabase.com:5432` — TCP open, TLS up,
speaking Postgres), and `pg_dump` 18.6 is installed. The only missing piece is
the connection string, which carries the region and the password together.

Supply it without typing it anywhere:

```sh
# Supabase dashboard -> Project Settings -> Database -> Connection string -> URI
# Copy it, then:
security add-generic-password -a "$USER" -s bedtime-db -w   # prompts, nothing echoed

# or, straight from the clipboard, never typed:
mkdir -p ~/.bedtime && umask 077
pbpaste > ~/.bedtime/db.url && chmod 600 ~/.bedtime/db.url
```

Then `scripts/backup-production.sh` runs unattended. It refuses a file that is
not mode 600, refuses anything that is not a `postgres://` URI, never passes
the password in argv where `ps` would show it, and redacts the connection
string from every error path.

**Do not paste that string into a chat.** This exists so you do not have to.

**2. No server.** `provision-app.sh --name bedtime` is ready. Per the current
strategy, that waits until every project is prepared.

## What has actually been verified

Against a database rebuilt from committed migrations only, loaded with real
production rows:

- clean rebuild from empty: **45 migrations, 0 failed**, zero schema drift
- reconciliation: **28 metrics match, 0 differ** — revenue GHS 602,501.00,
  profit GHS 206,959.50, inventory 2,186 units, every receipt number, product
  id and order number identical
- a sale deducts stock exactly and books the money
- a tampered price is refused, stock untouched
- overselling is refused, stock never negative
- order stock cannot be deducted twice
- two concurrent cashiers cannot oversell
- PIN sign-in: bcrypt, self-converting from plaintext, lockout after 10 failures

Figures move: the shop traded through all of this. Re-measure rather than
trusting any number written down, which is what `reconcile.mjs` is for.
