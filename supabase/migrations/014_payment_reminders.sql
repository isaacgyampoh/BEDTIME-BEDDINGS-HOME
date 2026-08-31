-- ############################################################################
-- SUPERSEDED by 018_cron_config.sql — do not run this file as-is.
--
-- The bearer token that used to be inline here was minted for a DIFFERENT
-- Supabase project (a leftover from the previous brand), so these jobs
-- authenticated with the wrong credential. 018 moves the key into
-- private.app_config and reschedules every job through private.call_edge().
--
-- Kept only for reference / for the schedule times.
-- ############################################################################

-- Payment Reminder — runs every hour, sends SMS to customers with unpaid orders
-- Requires pg_cron and pg_net extensions enabled

-- Schedule: every hour at minute 15
SELECT cron.schedule(
  'payment-reminder',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=remind',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SET private.app_config.service_key — SEE 018_cron_config.sql>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To check if it's working:
-- SELECT * FROM cron.job;

-- To remove the schedule:
-- SELECT cron.unschedule('payment-reminder');
