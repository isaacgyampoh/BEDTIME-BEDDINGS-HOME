# Deploy without a terminal

**This is what fixes your SMS.** Nothing I changed is live yet — the reports
still go to the old number because the function in production is the old one.

## Why you aren't getting them

Read from your database on 18 November:

| | |
|---|---|
| SMS sent in the last 7 days | **113** — SMS itself works fine |
| report SMS to `599084552` | **52**, most recently today at 13:00 |
| report SMS to `548124978` | **0, ever** |

And today six report jobs ran, all reporting "succeeded":

| ran | job | result |
|---|---|---|
| 06:00 | `sms-morning` | sent → 599084552 |
| 08:00 | `morning-sms` | sent → 599084552 (a second morning report) |
| 08:30 | `lowstock-sms` | **nothing** |
| 12:00 | `midday-sms` | **nothing** |
| 13:00 | `sms-afternoon` | sent → 599084552 |
| 13:00 | `afternoon-report` | **nothing** |

"Succeeded" means the request was *sent*, not that an SMS was. Only `sms_log`
knows, and it says three sends, all to the old number.

## What to do — about five minutes

Supabase dashboard → **Edge Functions** → pick the function → the editor →
select everything → paste the file → **Deploy**.

| # | function | paste this | fixes |
|---|---|---|---|
| 1 | `sms-reports` | `sms-reports.ts` | **the number**, and the 12:00, 08:30 and month-end reports that send nothing |
| 2 | `super-service` | `super-service.ts` | the number on its own reports; the payment reminder skipping unpaid orders |

Those two are what you need. These three are optional and carry smaller fixes:

| # | function | paste this | fixes |
|---|---|---|---|
| 3 | `whatsapp-bot` | `whatsapp-bot.ts` | a malformed message made the webhook retry forever |
| 4 | `ussd-handler` | `ussd-handler.ts` | a debug menu answering as the shop in the wrong protocol |
| 5 | `paystack-webhook` | `paystack-webhook.ts` | **a GHS 1 payment settles a GHS 770 order** — read `release/payment-webhook-fix/` first; it is the money path and deserves its own decision |

`wa-agent.ts` is there for completeness; it only stops a paid image
transformation.

**Nothing needs to be set.** `ADMIN_SMS_PHONES` defaults to `0548124978` and
`SHOP_PHONE` to `054 812 4978` inside the code. Secrets only matter if you
later want to change them without a deploy.

## Checking it worked, without waiting for 6am

Each report can be built and returned **without sending an SMS**:

```
https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/sms-reports?type=midday&dry=1
```

Expect `"sent": false` and `"recipients": ["0548124978"]`. Then drop `&dry=1`
to have one real SMS sent to you immediately.

## After that, one more thing

Deploying fixes the number and the three silent reports. It does **not** fix
the duplicates: your cron table has 16 jobs where 7 belong, six of them
carrying a service-role key written into the job command. That is
`supabase/pending/052`, which needs your approval because it writes to
production — and should be applied **after** these deploys, not before.

## Why these are single files

Each one has its shared modules folded in, so there is no order to get wrong
and no second file to forget. Do not edit them: edit
`supabase/functions/<name>/index.ts` and regenerate with

```
node migration-package/scripts/bundle-function.mjs <name>
```

Every file here was run under Deno against a restore of your real database
before being written out — all seven report types answered, addressed to
`0548124978`, with no SMS sent.
