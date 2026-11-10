# Bedtime cutover checklist

**10 November 2026. Verdict: NOT READY.**

Not "nearly ready with caveats". Two gates cannot be passed from this
environment at all, and one of them is that there is no server.

## Gates

| # | Gate | State | What is missing |
|---|---|---|---|
| 1 | A complete copy of the live database exists | **FAIL** | 5 tables refuse the public key, `staff` among them. Needs `pg_dump`. |
| 2 | That copy restores into a separate database and reconciles | **PARTIAL PASS** | 24/24 identical on the 9 readable tables, 3,772 rows. Unproven for the other 5. |
| 3 | Schema rebuilds from this repository with no drift | **PASS** | 45 migrations, 0 failed, zero unaccounted columns after 051 |
| 4 | Financial and inventory arithmetic survives the move | **PASS** | revenue GHS 595,706.00, profit GHS 204,461.50, 2,182 units — identical both sides |
| 5 | Identifiers and timestamps preserved | **PASS** | receipt numbers, product ids, order numbers, oldest timestamp |
| 6 | POS integrity holds on real data | **PASS** | stock deducted exactly; tampered price refused; overselling refused; double-deduction guarded; two concurrent cashiers cannot oversell |
| 7 | Staff PIN sign-in works after a restore | **PASS** | bcrypt, self-converting, lockout — verified on a synthetic row |
| 8 | A central VPS exists and is provisioned | **FAIL** | no host, IP or SSH target exists. Nothing has been purchased. |
| 9 | Bedtime is isolated from Everytinroom | **PASS by design, untested** | separate database, roles and directory via `provision-app.sh --name bedtime`. Cannot be tested without a server. |
| 10 | Images migrated to R2 and verified | **FAIL** | no bucket exists. Mechanism prepared and dry-run; 890 referenced files, 223.0 MB. |
| 11 | Edge Functions deployed | **FAIL** | 5 carry undeployed changes; this sandbox refuses deploys |
| 12 | The data exposure is closed | **FAIL** | sales, customers, expenses and orders are readable with the public key shipped in the browser bundle. 043/044/047 staged, gated on `super-service` being deployed first. |
| 13 | Backups scheduled, and a restore verified from a real backup | **FAIL** | no scheduled backup; restore verified from an API export, not a dump |
| 14 | Monitoring and alerting | **PARTIAL** | `healthcheck.sh` works; no alerting on failure |
| 15 | Rollback independently tested | **PARTIAL** | front-end and image rollback are sound; 049 has no automatic rollback |
| 16 | Final synchronisation plan for writes after the snapshot | **NOT STARTED** | see below |

**6 PASS · 3 PARTIAL · 7 FAIL.**

## The two that block everything else

**No complete database copy.** Everything downstream — a real backup test, the
staff PIN reconciliation, the final sync — needs `pg_dump`. The route that
works is authorising the Supabase MCP connector in an interactive session.
Four personal access tokens have been offered across sessions and the sandbox
refuses the Management API regardless of the credential, so offering a fifth
will not help. **Do not paste credentials into a chat.**

**No server.** `provision-app.sh` is ready and takes `--name bedtime`. It needs
a machine. Buying one needs your approval, and if the Supabase project is on
the free tier it *costs* about €5/month rather than saving anything.

## Final synchronisation, when the time comes

The shop trades continuously — it took 146 sales and 75 orders during this
session alone. So a snapshot taken on day one is stale by day two, and the
numbers in these documents are already historical.

The plan, not yet built:

1. Provision and restore from a dump. Verify.
2. Keep Supabase live and serving. Change no DNS.
3. Announce a short write freeze at a quiet hour (this shop's sales cluster in
   the afternoon; 04:00–05:00 GMT is near-dead).
4. Close the online shop with the switch already built for it
   (`src/pages/OnlineShop.jsx`) — the site stays up and shows a notice, so no
   customer sees an error.
5. Take a final dump of the rows created since the first one, keyed on `date`
   and `created_at`, and apply it.
6. Re-run the reconciliation. **If any metric differs, stop and roll back.**
7. Switch DNS. Keep Supabase untouched for at least a month.

Step 6 is the gate. There is no version of this where a differing total is
accepted and sorted out later.

## Approvals needed from you

| # | What | Why it needs you |
|---|---|---|
| 1 | Which Supabase plan the project is on | Decides whether this migration saves ~$19/month or costs ~€5/month |
| 2 | Authorise the Supabase MCP connector | The only route to a complete database copy |
| 3 | Buy a VPS — or decide not to | A purchase |
| 4 | Create the R2 bucket | A resource, though free-tier |
| 5 | Deploy the 5 Edge Functions | Blocked here; also the only way your daily reports move to the new number |
| 6 | Apply `supabase/pending/049` | Changes financial history: merges 36 duplicate customers, GHS 60,755 redistributed, lifetime total unchanged |
| 7 | Apply `supabase/pending/050` | Schema change on the orders table |
| 8 | Decide on the 52 unbooked paid orders | GHS 21,303 of goods paid for and not recorded as sales |
| 9 | Say whether the GHS 250 on `WEB-SMS26348` was refunded | Paid 3 Sept, order cancelled, no refund recorded |
| 10 | `git push` | Denied by this sandbox; 10 commits are local only |

## Verdict

**NOT READY FOR CUTOVER.**

What is genuinely proven: the schema rebuilds, the data reconciles exactly on
everything readable, the money and inventory arithmetic survives, the POS
refuses tampered prices and overselling and double-deduction and concurrent
oversell, and PIN sign-in works after a restore.

What is not: there is no complete copy of the database, no server to put it
on, no verified backup, no deployed Edge Functions, and the public-key data
exposure is still open.

The live shop is operating normally throughout and was never at risk from this
work. Nothing was deleted, no production write was made, and Everytinroom was
read-only.
