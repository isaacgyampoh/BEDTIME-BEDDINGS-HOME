-- ============================================================================
-- 041: send reports only for days the shop actually trades
--
-- 024 scheduled all three daily reports seven days a week. The shop works
-- Mon–Sat, so every Sunday sent three SMS about a day with no trading — noise
-- that costs money and trains the owner to ignore the reports.
--
-- 014b_report_schedule_monsat.sql had this right, but it is named outside the
-- CLI's pattern and has been skipped on every push since it was written, so it
-- never took effect. Its intent is captured here and the dead file is removed.
--
-- The morning report covers YESTERDAY, so it runs Tue–Sat (covering Mon–Fri).
-- Saturday's trading is picked up by the Sunday weekly, which means no report
-- ever describes a day the shop was shut.
--
-- pg_cron day-of-week: 0 = Sunday, 1 = Monday … 6 = Saturday.
-- Ghana is GMT, so these are local times.
-- ============================================================================

DO $$
DECLARE
  jobs TEXT[][] := ARRAY[
    -- yesterday's summary, Tue–Sat (covers Mon–Fri)
    ['sms-morning',      '0 6 * * 2-6',  '/sms-reports?type=morning'],
    -- today so far, trading days only
    ['sms-afternoon',    '0 13 * * 1-6', '/sms-reports?type=afternoon'],
    -- end of day, trading days only
    ['sms-evening',      '0 20 * * 1-6', '/sms-reports?type=evening'],
    -- the week in full, Sunday morning — this is what covers Saturday
    ['sms-weekly',       '0 7 * * 0',    '/sms-reports?type=weekly'],
    ['payment-reminder', '15 * * * *',   '/super-service?action=remind'],
    ['tiktok-status',    '*/10 * * * *', '/super-service?action=tiktok-status']
  ];
  j TEXT[];
BEGIN
  FOREACH j SLICE 1 IN ARRAY jobs LOOP
    BEGIN PERFORM cron.unschedule(j[1]); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule(j[1], j[2], format('SELECT private.call_edge(%L)', j[3]));
  END LOOP;
END $$;

SELECT jobname, schedule FROM cron.job ORDER BY jobname;
