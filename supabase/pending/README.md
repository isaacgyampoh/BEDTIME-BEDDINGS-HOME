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
