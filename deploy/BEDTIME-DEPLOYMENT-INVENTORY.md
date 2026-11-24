# BEDTIME — Production Edge Function Inventory

Project `wqkgfvmvuljzexhevlnp` ("Mimi"), region `eu-central-1`.
Compiled 24 November 2026 from the Management API plus the ESZIP bundles
pulled from the running deployments. Nothing here is inferred from a
repository filename.

## What is actually deployed

**Three functions. Not one more.**

| Slug | Ver | Last genuinely updated | Real source | JWT |
|---|---|---|---|---|
| `super-service` | 17 | 2026-11-24 13:22 UTC | `supabase/functions/super-service/index.ts` | off |
| `sms-reports` | 8 | 2026-11-18 19:54 UTC | `supabase/functions/sms-reports/index.ts` | off |
| `hyper-service` | 7 | **2026-07-31 08:11 UTC** | `supabase/functions/wa-agent/index.ts` (renamed) | off |

### Version numbers are not a deployment signal

Supabase bumps version integers platform-wide. `hyper-service` went 5 → 7 and
`sms-reports` 6 → 8 with their `updated_at` unchanged. **Use `updated_at`.**

### `hyper-service` is `wa-agent` under an old name

Established by pulling the ESZIP2.3 bundle from the live deployment and
parsing it with `@deno/eszip`. The function's own module specifier inside the
bundle is `source/index.ts` (719 lines); the `file:///tmp/user_fn_...` path in
the deployment metadata does not appear in the bundle, which is why an earlier
extraction filtered on it and found nothing. A `strings`-based extraction
before that produced 723 lines that would not parse, because it interleaved
the function with bundled std-library code. Neither was deployable.

The verified extraction is `deploy/recovered/hyper-service-LIVE.ts`. It
type-checks as a whole module under Deno 2.9.6. Identity is not a guess:
`waSend` 13 occurrences, `wa_conversations` 12, and the OpenAI tool set is
identical to `wa-agent` — `search_products`, `send_product_images`,
`create_order`, `save_delivery`, `send_location`, `flag_human`.

## Not deployed, despite existing in the repository

- `paystack-webhook` — the amount-verification work in it protects nothing.
  The live payment path is `super-service`.
- `charge-momo` — this is why the four `*-report` cron jobs send nothing.
- `wa-agent` — **the slug trap.** `deploy-functions.sh` derives the slug from
  the bundle filename, so `release/paste-ready/wa-agent.ts` would deploy to a
  *fourth* function named `wa-agent` that nothing calls. An earlier image
  transform gate was lost exactly this way. To reach the running agent the
  bundle must be named `hyper-service.ts`.

## Project secrets

Names only; no value was fetched.

Configured: `MNOTIFY_KEY`, `NALOPAY_API_KEY`, `NALOPAY_AUTH_HEADER`,
`NALOPAY_MERCHANT_ID`, `PAYMENT_CALLBACK_SECRET`, `SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`,
`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`.

`PAYMENT_CALLBACK_SECRET` present confirms the Step 2 precondition was met
before `super-service` v17 went out.

### The WhatsApp agent cannot run

| Required | State |
|---|---|
| `SUPABASE_URL` | configured |
| `SUPABASE_SERVICE_ROLE_KEY` | configured |
| `OPENAI_API_KEY` | **missing** |
| `WASENDER_API_KEY` | **missing** |
| `OWNER_PHONE` | missing (falls back in code) |

With `WASENDER_API_KEY` unset every WaSender call carries `Authorization:
Bearer ` and comes back 401. With `OPENAI_API_KEY` unset the agent cannot
think. `wa_conversations` holds **0 rows** — it has never recorded a single
conversation. `hyper-service` is deployed and inert.

`PAYSTACK_SECRET_KEY` is also absent, which means `super-service`'s
`?action=webhook` now fails closed on every request. That is the correct
outcome: no Bedtime order has ever carried a Paystack-format reference, and
that endpoint was the unauthenticated settlement hole. It is shut.

## Payment callback routing in `super-service` v17

| Endpoint | Guard |
|---|---|
| `?action=webhook` | `paystackSignatureValid()` — HMAC-SHA512, fails closed |
| `?action=nalopay-callback` | `callbackAuthorised()` — shared secret |
| `?action=hubtel-callback` | `callbackAuthorised()` |
| `?action=moolre-callback` | `callbackAuthorised()` |

The NaloPay charge call builds its own callback URL with `&s=<secret>`
appended, so genuine callbacks carry the secret and pass. The pre-deploy check
found 0 charges in flight, so no in-flight charge was issued a callback URL
predating the secret.

## Image transformations

Re-verified 24 November 2026 against nine real product images: every one
returned HTTP 200 with `x-transformations: width:800,resizing_type:fit,
quality:75`, averaging **41% of the original's bytes**. A repeat request
returned `cf-cache-status: HIT`.

So the endpoint **works**. It is not broken, and a gate that defaults it off
does not repair a fault — it avoids a bill. Billing is per origin image per
month, and 644 products carry storage-hosted images, which bounds the
exposure. The allowance figure recorded earlier in code (553 against 100) came
from the dashboard; `api.supabase.com` exposes no usage endpoint, so it cannot
be re-checked from here and should be treated as indicative.

Current Bedtime spend on transformations is **nil**, because the only code
path that transforms them cannot run. Nine transforms were caused by the
verification above — at $5 per 1,000 origin images, under $0.05, and only for
images not already counted this period.
