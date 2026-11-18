-- ---------------------------------------------------------------------------
-- 052  Sixteen scheduled jobs where seven belong.
--                                            *** NOT APPLIED — NEEDS APPROVAL
--
-- WHY THIS EXISTS
-- The reports go to the old number and three of them send nothing. Deploying
-- the functions fixes the number. It does NOT fix this: production's cron
-- table has three generations of jobs stacked on top of each other, because
-- each migration that added jobs only unscheduled the names IT used.
--
-- Read from production on 18 November 2026 (SELECT jobname, schedule, command
-- FROM cron.job):
--
--   GENERATION 1 — four jobs calling a function that is not in this repository
--     afternoon-report  13:00 Mon-Sat  charge-momo?action=report&type=today
--     evening-report    20:00 Mon-Sat  charge-momo?action=report&type=evening
--     weekly-report     08:00 Sun      charge-momo?action=report&type=weekly
--     monthly-report    06:00 on 1st   charge-momo?action=report&type=monthly
--
--   GENERATION 2 — six jobs with an INLINE SERVICE-ROLE KEY in the command
--     morning-sms       08:00 Mon-Sat  sms-reports?type=morning
--     midday-sms        12:00 Mon-Sat  sms-reports?type=midday
--     evening-sms       19:00 Mon-Sat  sms-reports?type=evening
--     lowstock-sms      08:30 Mon-Sat  sms-reports?type=lowstock
--     weekly-sms        19:30 Sat      sms-reports?type=weekly
--     monthly-sms       09:00 on 1st   sms-reports?type=monthly
--
--   GENERATION 3 — via private.call_edge(), which is the intended shape
--     sms-morning       06:00 Tue-Sat  /sms-reports?type=morning
--     sms-afternoon     13:00 Mon-Sat  /sms-reports?type=afternoon
--     sms-evening       20:00 Mon-Sat  /sms-reports?type=evening
--     sms-weekly        07:00 Sun      /sms-reports?type=weekly
--     payment-reminder  :15 hourly     /super-service?action=remind
--     tiktok-status     every 10 min   /super-service?action=tiktok-status
--
-- WHAT THAT MEANS IN PRACTICE, on 18 November:
--     06:00 sms-morning      -> SMS sent
--     08:00 morning-sms      -> SMS sent      (a SECOND morning report)
--     08:30 lowstock-sms     -> nothing
--     12:00 midday-sms       -> nothing
--     13:00 sms-afternoon    -> SMS sent
--     13:00 afternoon-report -> nothing
-- Six jobs ran. Every one reported "succeeded", because net.http_post
-- succeeds when the request is DISPATCHED, whatever the function answers. So
-- cron's own history cannot be used to tell a working report from a silent
-- one — only sms_log can, and it shows three sends, all to 599084552.
--
-- THE SECURITY PART
-- The six generation-2 jobs carry a service_role JWT written into the job
-- command, readable by anyone who can read cron.job. Migration 018 introduced
-- private.call_edge() to stop exactly that — it reads the key from
-- private.app_config — and was applied without removing the old jobs.
--
-- ---------------------------------------------------------------------------
-- NOTHING IS DROPPED HERE. Jobs are DISABLED (active := false), so every one
-- can be switched back on with a single UPDATE and the command is preserved.
-- A dropped job cannot be inspected afterwards, and four of these call a
-- function whose status outside this repository I cannot see.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── STEP 1 ── Disable the four jobs that call charge-momo.
--
--   `charge-momo` is not in supabase/functions/. It may still be deployed
--   from before this repository's history, or it may 404. Either way these
--   four duplicate reports that generation 3 already sends, and one of them
--   (afternoon-report, 13:00) fires at the same minute as sms-afternoon.
--
--   If you know charge-momo is live and wanted, do not run this step.
UPDATE cron.job SET active = false
 WHERE jobname IN ('afternoon-report','evening-report','weekly-report','monthly-report');

-- ── STEP 2 ── Disable the six jobs that carry an inline service-role key.
--
--   Their schedules are NOT lost: step 3 recreates every report they were
--   responsible for, through private.call_edge(), which keeps the key out of
--   the job command.
UPDATE cron.job SET active = false
 WHERE jobname IN ('morning-sms','midday-sms','evening-sms','lowstock-sms','weekly-sms','monthly-sms');

-- ── STEP 3 ── One job per report, all through private.call_edge().
--
--   cron.schedule on an existing name replaces it, so this is re-runnable.
--
--   NOTE ON `midday` vs `afternoon`: the deployed function today handles
--   `afternoon` and not `midday`. The corrected function handles both — the
--   schedule asks for `midday` and `afternoon` remains an alias. So APPLY
--   THIS ONLY AFTER DEPLOYING sms-reports, or the 12:00 report will keep
--   sending nothing. Order matters here and nowhere else in this file.
SELECT cron.schedule('sms-morning',      '0 6 * * 1-6',  $$SELECT private.call_edge('/sms-reports?type=morning')$$);
SELECT cron.schedule('sms-midday',       '0 12 * * 1-6', $$SELECT private.call_edge('/sms-reports?type=midday')$$);
SELECT cron.schedule('sms-evening',      '0 20 * * 1-6', $$SELECT private.call_edge('/sms-reports?type=evening')$$);
SELECT cron.schedule('sms-lowstock',     '30 8 * * 1-6', $$SELECT private.call_edge('/sms-reports?type=lowstock')$$);
SELECT cron.schedule('sms-weekly',       '0 19 * * 6',   $$SELECT private.call_edge('/sms-reports?type=weekly')$$);
SELECT cron.schedule('sms-monthly',      '0 9 28 * *',   $$SELECT private.call_edge('/sms-reports?type=monthly')$$);
SELECT cron.schedule('payment-reminder', '15 * * * *',   $$SELECT private.call_edge('/super-service?action=remind')$$);

-- sms-afternoon duplicated the 13:00 slot that generation 1 also occupied.
-- The midday report at 12:00 replaces it.
UPDATE cron.job SET active = false WHERE jobname = 'sms-afternoon';

-- tiktok-status is left exactly as it is. It is not a report and nothing
-- here touches it.

COMMIT;

-- ── Afterwards ─────────────────────────────────────────────────────────────
--   SELECT jobname, schedule, active FROM cron.job ORDER BY active DESC, jobname;
--
--   Expect 8 active: the seven above plus tiktok-status, and 10 inactive
--   whose commands are still there to inspect or re-enable.
--
--   Then confirm it by what ARRIVES, not by cron's status:
--     SELECT to_char(sent_at,'DD Mon HH24:MI'), phone, kind
--       FROM sms_log WHERE kind = 'report' ORDER BY sent_at DESC LIMIT 10;
--   Every row should read 548124978.
--
-- ── Rolling back ───────────────────────────────────────────────────────────
--   UPDATE cron.job SET active = true
--    WHERE jobname IN ('afternoon-report','evening-report','weekly-report',
--                      'monthly-report','morning-sms','midday-sms',
--                      'evening-sms','lowstock-sms','weekly-sms',
--                      'monthly-sms','sms-afternoon');
--   Nothing was dropped, so that is the whole of it.
