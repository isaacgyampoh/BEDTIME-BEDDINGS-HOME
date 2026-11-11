# Production fix: the payment webhook

**Separate from `../sms-and-reminder-fix/` on purpose.** This one changes how
money is settled, so it deserves its own decision rather than riding along
with a reporting fix.

**Not deployed. Needs your explicit approval.**

## What is wrong today

### The amount was never compared to the order

`charge.success` arrives with an amount in pesewas and the order is marked
Paid whatever it says. **A GHS 1 payment settles a GHS 770 order.**

The endpoint that sends the mobile-money prompt was fixed earlier to charge
the order's own total, which closes the ordinary path — a customer cannot
choose what to pay. But a notification that disagrees with the order should
never settle it silently, whatever its origin.

### A repeated delivery could create a second order

Paystack retries until it gets a 2xx and can deliver the same event twice. The
handler looked the reference up with `.eq(...).single()` and, finding nothing,
created an order. `.single()` **raises** when more than one row matches, and
the error was discarded — so the first duplicate made every later delivery
create one more.

### A successful payment created a 'Pending' order

The create branch set `status: 'Pending'` and `paid_at` together, putting a
paid order in the list the shop chases for money already sent. Production
holds one order in that state.

### The guard that stops a charge had a case bug

`if (ord.status === 'Cancelled')` is what stops a prompt being sent for a
cancelled order, and production holds one spelled `cancelled`. That order
walks past the guard — a customer charged for goods that are not coming.

## What changes

One function, `paystack-webhook`, plus the shared modules it imports
(`_shared/payments.js`, `_shared/status.js`).

- An underpayment goes to **review** and texts the shop, rather than settling.
- An overpayment settles and is flagged — refusing it would leave real money
  unbooked.
- One reference on two orders is a **conflict to report**, not a row to pick.
- Settling updates only a row that is still unsettled, so a second delivery
  changes nothing: no moved `paid_at`, no second stock deduction, no second
  SMS to the customer.
- `paid_at` is the provider's timestamp, not the moment a retry was processed.
- A created order is `Paid`, not `Pending`.
- Status comparisons are case-insensitive.

## Database compatibility

**This release needs no migration**, and is safe without one.

`supabase/pending/050` would additionally make `paystack_ref` unique, which is
the only way to close the *concurrent* case — two deliveries arriving at the
same instant. The function handles the sequential case on its own. 050 is a
separate approval; the webhook is correct either way, and already returns 2xx
on a `23505` unique violation so it is ready for 050 whenever you apply it.

## Deploying it

```sh
supabase functions deploy paystack-webhook --project-ref wqkgfvmvuljzexhevlnp
```

Secrets already required and already set (unchanged):
`PAYSTACK_SECRET_KEY`. Optionally `ADMIN_SMS_PHONES`, which defaults to
`0548124978` in code.

## Verifying it

There is no dry run for a payment, and I would not add one that fabricates a
settlement. Verify it the way it was verified here — against a staging
database, with `migration-package/scripts/exec-functions.sh`, which signs real
HMAC bodies and asserts each outcome:

```
no signature                    401  refused
a wrong signature               401  refused
an event that is not a charge   200  received, no action
GHS 1 on a GHS 770 order        200  review: underpaid
GHS 769.99 — a pesewa short     200  review: underpaid
a cancelled order               200  review
an order already settled        200  duplicate, nothing changed
GHS 770 exactly                 200  settled
the same event, redelivered     200  duplicate, nothing changed
and again                       200  duplicate, nothing changed
```

The harness fails when it should: pointed at a function started with a
different secret it reports 8 failures and exits 1.

In production, after deploying, the honest check is the next real payment:
the order should go to `Paid` with `paid_at` equal to the provider's
timestamp, and the shop should get one SMS, not two.

## Risk

This is the highest-risk release prepared here, because it is the money path.

| | |
|---|---|
| **A payment that should settle does not** | the main risk. Guarded by: the amount check accepts exact and over, and only refuses *under*; an underpayment goes to review **and texts you** rather than failing silently. |
| **A payment settles twice** | reduced, not increased: settling now requires the row to be unsettled. |
| **Data** | no migration. Writes `status`, `paid_at`, `paystack_ref` on the order being settled, as today. |
| **Stock** | `deduct_order_stock` is called on settle, as today, and it has its own `stock_deducted` guard — verified: a second call answers `{"note":"already deducted"}`. |
| **Worst case** | the webhook 500s and Paystack retries. The order stays unpaid and visible in the POS, and the shop's "Paid orders missing from sales" panel counts it. No money is lost; a payment is delayed. |

**Deploy this when you can watch the next few payments**, not last thing at
night.

## Rolling back

```sh
git checkout 8c22a75 -- supabase/functions/paystack-webhook supabase/functions/_shared
supabase functions deploy paystack-webhook --project-ref wqkgfvmvuljzexhevlnp
git checkout HEAD -- supabase/functions/paystack-webhook supabase/functions/_shared
```

Note `_shared` is included: other functions import those modules, so a
rollback of this one alone would leave them on the newer shared code. That is
harmless — the shared modules are backward compatible — but a full revert
should redeploy `super-service` and `sms-reports` too.

Rolling back restores the faults above, including settling a GHS 770 order for
GHS 1. There is nothing to reverse in the database.
