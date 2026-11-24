# Bedtime migration — final report

24 November 2026. Migration complete; hosted Supabase retained until the
recovery period ends.

## Production URLs

| | |
|---|---|
| Shop front | <https://bedtimehome.com> · <https://www.bedtimehome.com> |
| Till / POS | <https://admin.bedtimehome.com> |
| API | <https://api.bedtimehome.com> (Let's Encrypt, issuer YE2) |
| Images | `https://bedtime-images.nanagyams99.workers.dev` |
| Old backend | `https://wqkgfvmvuljzexhevlnp.supabase.co` — **forwarder only** |
| Repository | <https://github.com/isaacgyampoh/BEDTIME-BEDDINGS-HOME> (`main`, 56 commits pushed) |

## Deployment status

| Component | State |
|---|---|
| Database | `bedtime` in shared `central-postgres` 17.6, isolated role set |
| Services | 6 healthy: rest, auth, storage, realtime, imgproxy, functions |
| Edge functions | `super-service`, `sms-reports` — byte-identical to the repo |
| Scheduled jobs | 9 `btm-*` on Contabo; Supabase's 16 **disabled, definitions kept** |
| Staff auth | PIN → GoTrue session, verified end-to-end |
| Payments | NaloPay verified; one genuine settlement observed after cutover |
| SMS | mNotify verified delivered; 6,447 credits |
| Images | 949 objects / 249 MB in R2; uploads, replacement and deletion all via R2 |
| Backups | nightly 02:15, offsite to R2; restore rehearsed and matched |
| Monitoring | `bedtime-monitor.py`, 9 checks, every 15 min, independent of Everytinroom's |
| Rollback | `bedtime_t0` snapshot + `cutover-delta.py` + a one-command republish |

**Verified after cutover, on real data:** order `WEB-MWVC2FY3`, GHS 350.00,
created 23:36 and settled 23:37 with its own NaloPay reference, with
confirmation SMS to both customer and owner. Observed passively — no test
payment was created.

## Server resource consumption

Contabo VPS, 6 vCPU / 12 GB / 192 GB, shared with Everytinroom.

| | |
|---|---|
| Memory | **1,960 MB used of 11,960** — 10 GB free |
| ↳ Bedtime | 6 containers, ~473 MiB |
| ↳ Everytinroom | 4 containers, ~484 MiB |
| ↳ Shared (postgres, caddy) | 2 containers, ~379 MiB |
| Disk | **10 GB used of 192** — 181 GB free (6%) |
| Load | 0.09 / 0.12 / 0.09 on 6 cores |
| Databases | bedtime 16 MB, bedtime_t0 14 MB, everytinroom 17 MB, everytinroom_t0 15 MB |
| Backups on disk | 17 MB |
| R2 | 249 MB of the 10 GB free allowance |

Adding Bedtime cost roughly 473 MiB of memory and under 1 GB of disk. There is
room for several more projects on this box.

## Outstanding external dependencies

| # | Dependency | Why it still exists | Action |
|---|---|---|---|
| 1 | **USSD provider endpoint** | NaloPay's configured callback URL lives in their dashboard, not in our code. It may still name the Supabase project. | None required — Supabase now forwards. Change it to `https://api.bedtimehome.com/functions/v1/super-service?action=ussd` at your convenience, then the forwarder can go. |
| 2 | Supabase `super-service` v19 | Forwards pre-cutover NaloPay callbacks | Remove at retirement |
| 3 | Supabase Storage | The Worker reads through to it for the 205 unreferenced objects | Clear `ORIGIN_BASE` once no `origin-healed` misses occur for a week |
| 4 | `imageUpload.js` fallback | Safety net if an R2 upload is refused | Remove once unused for a week |
| 5 | Cloudflare (DNS, Pages, R2, Worker) | Permanent, free tier | — |
| 6 | NaloPay, mNotify | Permanent business providers | — |

**No new paid subscription was added.** R2 and the Worker are inside the free
allowance; the VPS already existed for Everytinroom.

## Known residual items

- **`TIKTOK_CLIENT_KEY`/`SECRET` were skipped**, so `btm-tiktok-status`
  answers "TikTok is not connected". Harmless; set them to re-enable it.
- **`PAYSTACK_SECRET_KEY` is absent on both backends, deliberately.** No
  Bedtime order has ever carried a Paystack reference, and its absence is what
  makes `?action=webhook` fail closed.
- **Nothing deletes product images.** A replacement writes a new timestamped
  path and orphans the old file — which is why 205 Supabase objects are
  referenced by nothing. R2 will accumulate the same way. Not urgent at 249 MB
  of a 10 GB allowance, but it is a slow leak rather than a solved problem.
- **"Delivered" means accepted by mNotify**, not confirmed on a handset. The
  provider's message id is now recorded (`providerMsgId`) so a delivery report
  can be queried; nothing queries it yet.
- `supabase/pending/049`, `050`, `052`, `053` remain unapplied at the source.
  They matter only if Supabase is ever restored to service.

## Retirement date

**Earliest deletion: 8 December 2026** — 14 days of normal trading from
cutover on 24 November.

Before deleting, every box in `docs/BEDTIME-SUPABASE-RETIREMENT.md` must be
ticked. The ones that are not yet:

- [ ] 14 days served from `api.bedtimehome.com` (to 8 December)
- [ ] a genuine USSD payment settled on Contabo **and** its SMS confirmed
- [ ] the USSD provider endpoint repointed, so the forwarder can be removed
- [ ] no `origin-healed` image misses for a week
- [ ] a nightly backup restored and reconciled during that window
- [ ] a final `pg_dump` of Supabase kept off the server

Order of deletion, slowest to reverse last: disable jobs (done) → delete Edge
Functions → delete Storage buckets → pause the project → delete the project.

## Reusable procedure

`selfhost/MIGRATE-A-PROJECT.md` is the consolidated ten-step procedure, with
the scripts that automate each part:

| Concern | Script |
|---|---|
| provider access, key identification | `migration-package/scripts/contabo-api.sh` |
| per-project deploy account | `deploy/access/install-deploy-account.sh` |
| provisioning, networks, aliases | `provision-app.sh` + `ensure-app-networks.sh` |
| scheduled-job plumbing | `ensure-app-edge-caller.sh` |
| DNS and TLS | `cloudflare-dns.sh` + `check-app-dns.sh` |
| database reload, extensions, RLS restore | `app-full-resync.sh` |
| image migration | `r2/migrate.mjs` + `r2/worker.js` |
| credentials, never in chat | `enter-*-credential.sh` (native hidden dialogs) |
| cross-tenant interference | `check-tenant-isolation.sh` |
| monitoring | `bedtime-monitor.py` as the template |
| backups and recovery | `backup.sh`, `restore.sh --into` |
| rollback | `cutover-delta.py` + `<app>_t0` |

`deploy/access/PLATFORM-NOTES.md` records the five traps that cost the most
time, so the next project does not pay for them again.
