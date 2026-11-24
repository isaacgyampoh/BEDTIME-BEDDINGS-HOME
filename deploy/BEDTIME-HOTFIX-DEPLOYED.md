# Step 1 hotfix — deployed

**24 November 2026.** `super-service` **v13 → v14**, under the approval of
21 November. Step 2 was not deployed.

## Deployed version

| | |
|---|---|
| function | `super-service` |
| version | **14** (was 13) |
| project | `wqkgfvmvuljzexhevlnp` — Mimi, eu-central-1, ACTIVE_HEALTHY |
| source | `release/paste-ready/super-service.ts`, sha256 `2ce03a0d23be…` |
| rollback | `release/rollback/super-service-v13-DEPLOYED.ts`, sha256 `636c5b357e6d…` |

## The safeguards, before deploying

**1. No legitimate caller of the Paystack path.**

- **0 of 645 orders** have ever carried a reference in Paystack's own format.
  Every one is `POS-`, `WEB-`, `USSD-` or `WA-`. 303 orders are settled, and
  not one of them by Paystack.
- `PAYSTACK_SECRET_KEY` is **not configured** on the project.
- **Log evidence was not available.** The Management API's logs endpoint has
  no `function_edge_logs`, `edge_logs` or `function_logs` table for this
  project, so invocation history could not be queried. The reference and
  configuration evidence above is what this rests on. **Residual risk** is
  stated below rather than waved away.

**2. Rollback preserved and tested.** The v13 artifact was run: it starts,
serves, and answers the unauthenticated probe with 200 — v13's behaviour,
which is what a rollback restores.

**3. Nothing else modified.** Each action's region was hashed against v13:
`nalopay-callback`, `nalopay-charge`, `nalopay-status`, `moolre-callback`,
`hubtel-callback`, `ussd`, `resend-sms`, `remind`, `report`, `staff-login`,
`tiktok-status` — **all UNCHANGED**.

This check caught two scope errors of mine: the gate had been applied to
`hubtel-callback` (outside the approval — reverted) and had missed a settle
branch inside `action=webhook` (added).

**4/5. Authentication and verification.** `action=webhook` requires a valid
HMAC-SHA512 over the raw body and **fails closed** without the key. Every
settle branch then checks provider status, currency, amount, whether the order
is already settled, and whether it is cancelled.

**6. Regression: 23 passed, 0 failed.** It failed on its first two runs and
found three real defects — see `BEDTIME-SECURITY-AUDIT.md`.

## Production checks, after deploying

| check | result |
|---|---|
| unsigned `charge.success` | **HTTP 401** `{"error":"unauthorised"}` |
| forged signature | **HTTP 401** |
| payment initialization (`nalopay-charge`) | alive — `{"success":false,"error":"Order reference required"}` |
| USSD handler | alive — the welcome prompt in the telco envelope |
| `sms-reports` | HTTP 200 |
| `nalopay-callback` | behaviour unchanged (step 2 not deployed) |

**Nothing moved.** Before and after my testing:

```
sms_log=138   settled=303   stock=2348        (identical)
SMS sent in the last 20 minutes          : 0
orders settled in the last 20 minutes    : 0
POS-MS4D07VR (the ref I probed with)     : Cancelled, paid_at NULL
```

No customer SMS, no stock adjustment, no order state change. The order I
probed with was already cancelled and stayed cancelled — and under the new
code a cancelled order cannot be settled at all.

Unpaid orders stood at 8 when the vulnerability was reported and at **0** by
deploy time: the shop processed them in the ordinary course of business. There
were none left to be changed.

## Residual risks

| # | risk | why it is acceptable, or not |
|---|---|---|
| 1 | **If Paystack is live and I could not see it**, its callbacks now get 401 and payments would stop settling | The evidence is strong (0 of 645 references, no secret configured). If it happens it is immediately visible — orders stop settling — and the rollback is one deploy. Watch the next few online payments. |
| 2 | **Step 2 is not deployed.** `nalopay-callback`, `hubtel-callback` and `moolre-callback` remain **unauthenticated** because `callbackAuthorised()` returns true when `PAYMENT_CALLBACK_SECRET` is unset | Deliberate. Closing it today would stop every NaloPay confirmation, which is the live provider. **Set `PAYMENT_CALLBACK_SECRET`, then deploy step 2.** This is the largest remaining hole. |
| 3 | `hyper-service` v5 is the **live WhatsApp agent** and has `verify_jwt: false` | Recovered and identified (below). Not reviewed line by line. |
| 4 | Six cron jobs carry a service-role JWT inline | `supabase/pending/052`, unapplied. |
| 5 | Business data readable with the public key | `043/044/047`, unapplied. |

## Rolling back

```sh
cp release/rollback/super-service-v13-DEPLOYED.ts release/paste-ready/super-service.ts
./migration-package/scripts/deploy-functions.sh super-service
```

Rolling back **reopens the vulnerability**. It is for restoring service if a
real payment breaks, not a resting state.
