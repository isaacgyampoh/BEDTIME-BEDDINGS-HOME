# Bedtime deployment report

**10 November 2026.**

## What is live right now

Unchanged from before this work, and still serving the shop:

| | |
|---|---|
| `bedtimehome.com` / `www` | Cloudflare Pages (`bedtime-shop`) — HTTP 200 |
| `admin.bedtimehome.com` | Cloudflare Pages (`bedtime-admin`) — HTTP 200 |
| backend | managed Supabase, project `wqkgfvmvuljzexhevlnp` — answering in 50 ms |
| product photos | Supabase Storage, 1,089 objects, 303.3 MB |

Both front ends were rebuilt and redeployed during this work and verified by
re-downloading the published bundles. The backend was **not** touched.

## What was deployed

Front-end deploys go through `npm run deploy`, which lints, runs the full unit
suite, builds both apps, greps the output for server secrets and then
publishes. A failing gate stops the deploy.

Verified in the live bundles by fetching them from the published URLs:

| change | marker found in the live bundle |
|---|---|
| figures counted in the database | `25e3`, `.range(`, `status.ilike.` |
| case-insensitive order status | `status.ilike.` |
| phone normalisation | the `00233`/`233`/leading-zero reducer |
| new shop number | `054 812 4978` ×1, old number ×0 |
| shop front contact details | `tel:0548124978`, `"telephone": "+233548124978"` |

## What is built but NOT deployed

**Five Edge Functions.** This environment refuses Edge Function deploys, so
everything below is in the repository and not in production:

| function | carries |
|---|---|
| `sms-reports` | the only thing that moves the daily report off the old number |
| `super-service` | `staff-login`, rewritten payment reminders, 9 case-insensitive status guards, `ADMIN_SMS_PHONES`/`SHOP_PHONE` from the environment |
| `paystack-webhook` | payment amount verification and idempotency |
| `wa-agent` | the image-transformation gate |
| `whatsapp-bot` | the new shop number |

Until these are deployed: **your daily reports still go to the old number**,
and a repeated payment notification can still create a second order.

All five parse cleanly (`esbuild --bundle`).

## The central VPS

**No production server exists.** I looked: no host, IP or SSH target appears
anywhere in `~/everytinroom-pos/deploy/`. The 100 passing checks in
`~/everytinroom-staging-evidence/` were run on *disposable* Ubuntu servers
that install Docker from scratch and are destroyed afterwards.

So Bedtime's deployment configuration has been prepared and validated, and
nothing pretends the server is there. Per the brief, no infrastructure was
purchased.

### Readiness of the pieces

| piece | state |
|---|---|
| Multi-tenant provisioning (`provision-app.sh --name bedtime`) | **ready, not run** — needs a server |
| Schema rebuild from migrations | **tested**, 45 applied / 0 failed, four times |
| Data load and reconciliation | **tested**, 24/24 identical |
| Service selection (postgrest + realtime + storage + functions, no auth) | **determined** from the repository |
| R2 image migration (`r2/`) | **prepared**, dry run agrees with an independent inventory |
| Backups (`selfhost/backup.sh`) | **written, never run** against a real server |
| Monitoring (`scripts/healthcheck.sh`) | **works** against production today |

### Cost, stated plainly

Contabo Cloud VPS 4 is about €4.40–5.50/month. **If Bedtime's Supabase project
is on the free tier, moving to the VPS costs about €5/month more**, plus a
server to patch and backups that only work if someone checks them. If it is on
Pro at $25/month, the move saves roughly $19/month.

I cannot see which plan it is on — that is in the Supabase billing dashboard,
and it is the single fact that decides whether this migration is worth doing.

There is also a reliability trade. On managed Supabase, keeping Postgres alive
is someone else's job. Self-hosted, every outage is yours, at whatever hour it
happens. On 26 October this shop was down and nobody noticed for days.

## Production deployment readiness

**NOT READY.** See BEDTIME-CUTOVER-CHECKLIST.md for the gates. The two that
cannot be worked around from here: no complete database copy (five tables
refuse the public key) and no server to deploy onto.
