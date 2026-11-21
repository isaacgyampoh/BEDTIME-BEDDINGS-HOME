# Bedtime — security audit

**21 November 2026.** One finding outranks everything else in this migration.

---

## CRITICAL — anyone can mark any order Paid

### What is live right now

`super-service?action=webhook` accepts an **unsigned, unauthenticated POST**
and settles orders. No Paystack HMAC. No callback secret. No JWT. Nothing.

Proven against production, with no side effect — an event other than
`charge.success` returns before any order is touched:

```
POST .../super-service?action=webhook      (no headers at all)
{"event":"probe.ignore","data":{}}
→ HTTP 200 {"received":true}
```

Then proven to settle, against **the exact file deployed as v13**, on a local
restore of the production dump — never against production:

```
before:  VULN-770   owed GHS 770.00   status Pending   paid_at NULL

POST ?action=webhook   (unsigned)
{"event":"charge.success","data":{"reference":"vuln-ref-770","amount":100}}
→ HTTP 200 {"success":true,"type":"ref"}

after:   VULN-770   owed GHS 770.00   status Paid      paid_at 2026-11-21 10:00
```

**A GHS 770 order settled by an unauthenticated claim of GHS 1.00.**

### What it costs

Settling an order also calls `deduct_order_stock` and texts the customer that
their payment has been received. So the attack takes stock out of inventory
and tells the buyer the shop is happy — the goods leave.

**8 orders are unpaid right now** and therefore settleable by anyone. The
function URL is the same base URL shipped in the browser bundle, so "whoever
knows the URL" is everyone who has loaded the shop.

### Why it was not caught before

The fixed webhook — amount check, idempotency, HMAC — lives in
`paystack-webhook`, which **is not deployed**. Only three functions are:
`hyper-service`, `sms-reports`, `super-service`. I had been auditing a file
that does not run.

### The same fail-open, three more times

`callbackAuthorised()` guards `nalopay-callback`, `hubtel-callback` and
`moolre-callback`. When `PAYMENT_CALLBACK_SECRET` is unset it logs a warning
and **returns `true`**:

```js
if (!CALLBACK_SECRET) {
  console.warn('SECURITY: ... anyone who knows this URL can mark an order Paid.')
  return true          // <-- fail-open
}
```

`PAYMENT_CALLBACK_SECRET` is **not configured** on this project. The code
describes the hole accurately and then opens it. A warning in a log nobody
reads is not a control.

---

## The hotfix

In the repository, **not deployed**. Two steps, in this order, because the
order is what keeps the shop trading.

### Step 1 — safe to deploy now

`action=webhook` requires a valid Paystack HMAC-SHA512 over the raw body, and
**fails closed** when `PAYSTACK_SECRET_KEY` is absent.

**This breaks nothing.** Checked before writing it: **no order has ever
carried a reference in Paystack's own format** — every one is `POS-`, `WEB-`,
`USSD-` or `WA-` — and `PAYSTACK_SECRET_KEY` is not configured. The endpoint
has no legitimate caller. It is pure attack surface.

It also now verifies, on every settle branch:

| | |
|---|---|
| provider status | refuse anything explicitly not `success` |
| currency | refuse anything but `GHS` (`SHOP_CURRENCY` to change) |
| amount | refuse an **underpayment** |

**Overpayment is accepted deliberately.** `nalopayCharge()` multiplies the
order total by `PROCESSING_FEE` (1.013) before charging, so a genuine
mobile-money settlement arrives about 1.3% **above** the order total. An
exact-match check would refuse every real payment. Only underpayment — the
case that gives goods away — is refused, and a refusal texts the shop rather
than failing silently.

Verified against the deployed file on a local restore:

| signed callback | result | order |
|---|---|---|
| GHS 1.00 on a GHS 770 order | `review: underpaid` | **Pending** |
| GHS 769.99 — a pesewa short | `review: underpaid` | **Pending** |
| GHS 770.00 exactly | settled | Paid |
| GHS 780.01 (NaloPay's +1.3%) | settled | Paid |
| right amount, currency NGN | `review: currency is NGN` | **Pending** |
| right amount, status `failed` | `review: provider status is "failed"` | **Pending** |
| unsigned | **HTTP 401** | **Pending** |
| forged signature | **HTTP 401** | **Pending** |

### Step 2 — needs a secret set FIRST

Making `callbackAuthorised()` fail closed. **Do not deploy this before
setting `PAYMENT_CALLBACK_SECRET`**, or every NaloPay confirmation stops and
customers who have paid sit at Pending.

```sh
# 1. set it
supabase secrets set PAYMENT_CALLBACK_SECRET="$(openssl rand -hex 32)" \
  --project-ref wqkgfvmvuljzexhevlnp
# 2. then deploy the fail-closed change
```

The callback URL the code hands NaloPay already appends `&s=<secret>`, so
setting it is enough — no provider-side change.

Step 1 is marked in the source as `HOTFIX 2026-11-21`; step 2 is marked
`DELIBERATELY STILL FAIL-OPEN` so it cannot be mistaken for finished.

### Rolling back

```sh
git checkout 97ff089 -- supabase/functions/super-service
node migration-package/scripts/bundle-function.mjs super-service
# then redeploy super-service
```

`97ff089` is the commit of what is deployed now. Rolling back **reopens the
vulnerability** — it is a way to restore service if the hotfix breaks a real
payment, not a safe resting state.

---

## Other findings

| severity | finding |
|---|---|
| high | **Six cron jobs carry a service-role JWT inline in the job command**, readable by anyone with database access. `supabase/pending/052`. |
| high | **Business data is readable with the public key** — sales, customers, expenses, orders, with the key in the browser bundle. `043/044/047` are staged and were gated on a real session, which now exists. |
| medium | `invoice-photos` is a **public** bucket. It holds 0 objects today, which is the cheapest moment to make it private — a supplier invoice is not a product photo. |
| medium | **`hyper-service` v5 runs from a source nobody has.** Unreviewable, unmigratable. |
| low | `PAYSTACK_SECRET_KEY` and `PAYMENT_CALLBACK_SECRET` are both absent from the project's secrets. |
| low | **No foreign keys** across 24 tables, so a restore cannot be validated by constraint checking. |

## What is already right

Worth recording, because it is the difference between this and a worse report:

- PostgreSQL is **not** exposed publicly on the VPS (5432 filtered).
- `verify_pin` uses bcrypt, rate-limits to 10 failures in 5 minutes, and
  converts a legacy plaintext PIN on first use. Zero plaintext PINs remain.
- `record_sale` recomputes prices server-side and refuses a client-supplied
  total; it refuses overselling and holds under two concurrent cashiers.
- `deduct_order_stock` is idempotent.
- The browser only ever receives the `anon` key. Exactly one token exists in
  the repository and it is that key.
- `nalopay-charge` verifies the order exists, is unpaid, is not cancelled, and
  that the amount matches — in pesewas.
