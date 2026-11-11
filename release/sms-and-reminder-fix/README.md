# Production fix: the SMS reports and the payment reminder

**A standalone release. It has nothing to do with the VPS migration and does
not depend on it.** Deploy it, or don't; the migration is unaffected either
way.

**Nothing here is deployed. It needs your explicit approval.**

## What is broken in production right now

### Three of the six scheduled SMS reports send nothing

Migration 018 schedules six. The deployed `sms-reports` handles five names,
and only three of them match:

| scheduled | when | handler | what happens today |
|---|---|---|---|
| `?type=morning` | 07:00 daily | `morning` | sent |
| `?type=midday` | 13:00 daily | — | **nothing** |
| `?type=evening` | 20:00 daily | `evening` | sent |
| `?type=lowstock` | 09:00 daily | — | **nothing** |
| `?type=weekly` | 20:00 Sat | `weekly` | sent |
| `?type=monthly` | 20:00 on the 28th | — | **nothing** |

An unhandled type falls through to a branch that returns **HTTP 200** with a
usage string, so `pg_cron` records six successes a day. The 1pm figures, the
low-stock warning and the month-end summary have never arrived. The function
does implement an `afternoon` report — nothing calls it.

### The daily report goes to the old number

The deployed copy hardcodes `['0599084552']`.

### The payment reminder skips orders, three ways

1. `.in('status', ['Pending','Awaiting Payment'])` is an exact match, and
   production holds a status spelled in lower case. Measured against staging:
   **8 of 9 unpaid orders selected.** The missed one is never chased.
2. `isChaseable()` compared with `===` as well, so fixing the query alone just
   moved that order from "not selected" to "skipped".
3. The message said **"Or dial 1001 to pay by mobile money."** `ussd_code` is
   an `INTEGER`; nothing happens when a customer dials a bare short code. The
   rest of the system dials `*920*141*<code>#`.

The query also had no `limit` and no `order` against PostgREST's 1,000-row
cap, so a shop with more unpaid orders than that would chase an arbitrary,
silently partial subset.

## The release

Four functions. `wa-agent` and `ussd-handler` are included because they carry
small corrections of their own, but they are **optional** — the first two are
what fix the faults above.

| function | why | required? |
|---|---|---|
| `sms-reports` | the three missing reports; the recipient; 400 on an unknown type | **required** |
| `super-service` | the reminder's three fixes; case-insensitive status guards; the daily report's own figures | **required** |
| `whatsapp-bot` | a malformed body returned 500, so a webhook retries forever; internals were echoed back | optional |
| `ussd-handler` | a debug stub answered as the shop in the wrong protocol | optional |

`paystack-webhook` carries the payment amount check and idempotency. It is
**deliberately not in this release** — it changes how money is settled and
deserves its own decision. See `../payment-webhook-fix/`.

## Secrets

Both default to the right value in code, so **nothing has to be set for this
release to work**. They exist so the next change needs no deploy.

| name | default in code |
|---|---|
| `ADMIN_SMS_PHONES` | `0548124978` |
| `SHOP_PHONE` | `054 812 4978` |

To change either later:
`supabase secrets set ADMIN_SMS_PHONES=0548124978,0599084552`

## Database compatibility

**No migration is required.** Every change is in function code.

Checked against production as it is today:

- `whatsapp_orders.status` — read only; the fix makes the *comparison*
  case-insensitive, it does not rewrite any row.
- `whatsapp_orders.ussd_code` — `INTEGER`, confirmed; the dial string is
  built around that rather than assuming text.
- `whatsapp_orders.notes` — the reminder markers (`[R1]`…) already live there;
  the format is unchanged, so reminders already sent stay recognised and no
  customer is re-chased on first run.
- `private.app_config` — untouched. The seven jobs keep resolving their base
  URL from the one row they already use.

## Deploying it

```sh
supabase functions deploy sms-reports    --project-ref wqkgfvmvuljzexhevlnp
supabase functions deploy super-service  --project-ref wqkgfvmvuljzexhevlnp
# optional
supabase functions deploy whatsapp-bot   --project-ref wqkgfvmvuljzexhevlnp
supabase functions deploy ussd-handler   --project-ref wqkgfvmvuljzexhevlnp
```

The schedules are already in place and already firing. Nothing needs
rescheduling: the three silent jobs start producing a report on their next
run.

## Verifying it, without sending anything

`sms-reports` takes `&dry=1`, which builds the report and returns it **without
sending an SMS**:

```sh
curl -s "$FN/sms-reports?type=midday&dry=1"   | head -c 400
curl -s "$FN/sms-reports?type=lowstock&dry=1" | head -c 400
curl -s "$FN/sms-reports?type=monthly&dry=1"  | head -c 400
curl -s -o /dev/null -w '%{http_code}\n' "$FN/sms-reports?type=quarterly"   # expect 400
```

Expect `"sent": false`, `"recipients": ["0548124978"]`, and a message with
real figures. Then one live one, deliberately:

```sh
curl -s "$FN/sms-reports?type=midday"         # this DOES send one SMS, to you
```

The reminder cannot be dry-run without sending, so check it by reading what
it did rather than by triggering it: wait for the next run at :15 and look at
whether `notes` gained a marker.

## Risk

| | |
|---|---|
| **Data** | none. No migration, no write to any business record. The only write is a marker appended to `whatsapp_orders.notes`, which already happens today. |
| **Money** | none. No payment code is in this release. |
| **Customer messages** | the reminder will reach customers it was previously skipping, which is the point. Each carries a payment link and a dialable code. Orders already marked are not re-chased. |
| **Your own SMS** | you start receiving three reports that were silent. If that is unwelcome, deploy `super-service` alone and leave `sms-reports`. |
| **Worst case** | a report fails to build and returns 500. The shop, the till and the website are untouched: nothing in the POS or the storefront calls these paths. |

The one behaviour change worth being deliberate about: **an unknown report
type now returns 400 instead of 200.** If anything other than `pg_cron` calls
`sms-reports` with a type this function does not know, it will start seeing an
error instead of a quiet success. Nothing in this repository does.

## Rolling back

Supabase keeps previous versions of a function:

```sh
supabase functions list --project-ref wqkgfvmvuljzexhevlnp
# redeploy the previous commit of just the function you want to revert:
git checkout 8c22a75 -- supabase/functions/sms-reports
supabase functions deploy sms-reports --project-ref wqkgfvmvuljzexhevlnp
git checkout HEAD -- supabase/functions/sms-reports
```

`8c22a75` is the last commit before this work began. Rolling back returns the
three silent reports to silence and the reminder to skipping — it restores the
faults, it does not break anything new.

No database change means there is nothing to reverse on that side.

## Evidence

Every claim above was produced by running the functions, not by reading them.
`migration-package/scripts/exec-functions.sh` reruns it:

```
sms-reports      7 types, HTTP 200 each, sent=false, 180-770 chars
                 unknown type -> HTTP 400
super-service    reminder run 1: 3 sent, marks written
                 reminder run 2: 0 sent, 4 skipped  (idempotent)
                 TEST-LOWER, the lower-case order, chased with R1/R2 marked
whatsapp-bot     valid body 200; malformed body 400; no internals echoed
ussd-handler     application/json, continueSession=false
```

Real Deno 2.9.6, the real `@supabase/*` client from esm.sh, real HTTP, rows
from a database rebuilt from committed migrations and loaded with real
production data. Zero SMS sent: every sender returns early without its key.
