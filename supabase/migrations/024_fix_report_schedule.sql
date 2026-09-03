-- ============================================================================
-- 024: Schedule only the reports that actually exist
--
-- 023 carried the job list over from 002_cron_jobs.sql without checking it
-- against the deployed function. sms-reports handles exactly:
--     morning | afternoon | evening | weekly | test
-- so 'midday', 'lowstock' and 'monthly' hit the default branch and sent
-- nothing. They are removed, and 'midday' is corrected to 'afternoon'.
--
-- Times follow the schedule the function itself describes in its test message:
--   06:00 yesterday's summary · 13:00 today so far · 20:00 end of day
--   Monday 06:00 weekly
-- Ghana is UTC+0, so pg_cron's UTC clock needs no offset.
-- ============================================================================

DO $$
DECLARE
  dead TEXT[] := ARRAY['sms-midday','sms-lowstock','sms-monthly'];
  jobs TEXT[][] := ARRAY[
    ['sms-morning',      '0 6 * * *',   '/sms-reports?type=morning'],
    ['sms-afternoon',    '0 13 * * *',  '/sms-reports?type=afternoon'],
    ['sms-evening',      '0 20 * * *',  '/sms-reports?type=evening'],
    ['sms-weekly',       '0 6 * * 1',   '/sms-reports?type=weekly'],
    ['payment-reminder', '15 * * * *',  '/super-service?action=remind'],
    ['tiktok-status',    '*/10 * * * *','/super-service?action=tiktok-status']
  ];
  d TEXT; j TEXT[];
BEGIN
  FOREACH d IN ARRAY dead LOOP
    BEGIN PERFORM cron.unschedule(d); RAISE NOTICE 'removed dead job %', d;
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;

  FOREACH j SLICE 1 IN ARRAY jobs LOOP
    BEGIN PERFORM cron.unschedule(j[1]); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule(j[1], j[2], format('SELECT private.call_edge(%L)', j[3]));
  END LOOP;
END $$;

-- Every scheduled report type must be one the function implements.
SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;
