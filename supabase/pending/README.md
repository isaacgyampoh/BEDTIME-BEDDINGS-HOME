# Changes written, reviewed, and waiting to be applied

Everything here is committed code that has **not** been run against the
database. Two files, because they have different preconditions.

| File | When | What it fixes |
|---|---|---|
| `apply-now.sql` | any time | adding a staff member works again (045); the owner's new line is exempt from the SMS cap (046); public privileges no code path uses are removed (042) |
| `apply-after-sessions.sql` | only after a staff PIN sign-in is proven to mint a session | the live data exposure — sales, customers and the expense ledger are readable today with the key in the JavaScript bundle (043); order data closed behind per-order functions (044); order totals recomputed server-side instead of trusted from the browser (047) |

Each file is one transaction, so a failure keeps nothing.

## Why the second file waits

Staff sign in with a PIN held in the browser; there is no Supabase Auth
session, so the admin portal reaches PostgREST as `anon` — the same role as the
public shop. 043 and 044 move the business tables to `authenticated`. Run them
while staff are still `anon` and every admin screen goes blank, and the
WhatsApp Orders page, the invoice payment page and the delivery pages lose the
table they read.

What makes `authenticated` mean something is `?action=staff-login` in the
`super-service` Edge Function, which exchanges a PIN for a real session.
`src/lib/supabase.js` (`startStaffSession`) already calls it and falls back to
`verify_pin` when it is not there, so deploying the function changes nothing
until it works — which is what makes it safe to deploy first and verify.

## Two Edge Functions are also waiting

- **`sms-reports`** — the deployed copy has `const ADMIN_PHONES = ['0599084552']`
  hardcoded. The daily report still goes to the old number and no dashboard
  secret can redirect it; the committed version reads `ADMIN_SMS_PHONES` and
  defaults to `0548124978`. **The number does not change until this is
  deployed.** 046 only stops that number hitting the rate cap.
- **`super-service`** — adds `staff-login` (above) and `realtime-token`, which
  keeps `OPENAI_API_KEY` on the server for the voice assistant.

## Verified against a local rebuild, not just read

`./scripts/verify-sql-locally.sh` replays all of 001-041 into a throwaway local
Postgres, applies both files on top, and then exercises the paths they touch:
rings up a sale through `record_sale` as `anon`, adds a staff member, places a
web order, forges a total, forges a promotion, and compares what the table
owner can see against what the public key can see.

Three real faults were found that way, all now fixed:

1. **044 could never have been applied.** `public_order_get`, `_save_details`,
   `_set_ref` and `_confirm_delivery` all declared `p_id UUID`, but
   `whatsapp_orders.id` is `TEXT DEFAULT short_id()`. Postgres refuses the
   function body with `operator does not exist: text = uuid`.

2. **043 did not close the exposure it was written to close.** 016 created a
   second set of policies in a loop — `<table>_sel`, `_ins`, `_upd` for
   products, expenses, bundles, promos and invoices. 043 dropped only the
   long-named ones, and permissive policies combine with OR, so the expense
   ledger stayed readable and product prices stayed writable by anyone holding
   the public key. The worst of it was `promos_ins`: 047 prices every web order
   from the live promos, so a forged 1-cedi promotion would have produced a
   1-cedi order that the receipt, the takings and the SMS report all agreed on.

3. **Two columns exist in production that no migration creates.**
   `whatsapp_orders.source` and `.details_filled` were added straight to the
   database. Ten places in the application use them. `public_order_create`
   writes both, so on any rebuilt database it failed with `column "source" of
   relation "whatsapp_orders" does not exist`. 044 now adds them if absent,
   which is a no-op against production.

Point 3 means this repository cannot rebuild production exactly. A wider sweep
found the same kind of drift on `wa_conversations` and a few other columns. That
is worth closing separately; it is not in the way of these two files.

## What the verification proves

| Checked as the public key would arrive | Result |
|---|---|
| ring up a sale through `record_sale` after 042 removes the INSERT grant | receipt issued, stock 10 -> 8 |
| insert into `sales` directly | refused |
| add a staff member | succeeds (this is the "cannot create staff" fault) |
| read the catalogue | 1 of 1 products, the shop still works |
| read sales / customers / expenses / orders / invoices | owner sees the rows, the public key sees none |
| forge a promotion, rewrite a price | both refused |
| place a web order | server prices 2 x 300 promo = 600 and stores 600 |
| claim a total of 2.00 for 600 of goods | refused, with the real figure |
| order 99 of 10 in stock | refused |
| track orders with a 3-character query | 0 rows; the real order number returns 1 |
