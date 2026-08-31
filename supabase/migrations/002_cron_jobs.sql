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

-- ============================================================================
-- EVERYTINROOM POS — CRON JOBS FOR SMS REPORTS
-- Run AFTER the schema. Requires pg_cron + pg_net (enabled in Supabase Dashboard → Extensions)
-- 
-- Go to: Supabase Dashboard → Database → Extensions → Enable pg_cron and pg_net
-- Then run this SQL.
--
-- IMPORTANT: Replace https://wqkgfvmvuljzexhevlnp.supabase.co and <SET private.app_config.service_key — SEE 018_cron_config.sql> below!
-- ============================================================================

-- Enable extensions if not already
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ===== 8AM MORNING SMS (Mon-Sat) =====
SELECT cron.schedule(
  'morning-sms',
  '0 8 * * 1-6',  -- 8:00 AM, Monday to Saturday
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/sms-reports?type=morning',
    headers := '{"Authorization": "Bearer <SET private.app_config.service_key — SEE 018_cron_config.sql>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ===== 12PM MIDDAY SMS (Mon-Sat) =====
SELECT cron.schedule(
  'midday-sms',
  '0 12 * * 1-6',
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/sms-reports?type=midday',
    headers := '{"Authorization": "Bearer <SET private.app_config.service_key — SEE 018_cron_config.sql>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ===== 7PM EVENING SMS (Mon-Sat) =====
SELECT cron.schedule(
  'evening-sms',
  '0 19 * * 1-6',
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/sms-reports?type=evening',
    headers := '{"Authorization": "Bearer <SET private.app_config.service_key — SEE 018_cron_config.sql>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ===== WEEKLY SMS (Saturday 7:30PM) =====
SELECT cron.schedule(
  'weekly-sms',
  '30 19 * * 6',  -- Saturday 7:30 PM
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/sms-reports?type=weekly',
    headers := '{"Authorization": "Bearer <SET private.app_config.service_key — SEE 018_cron_config.sql>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ===== MONTHLY SMS (1st of month 9AM) =====
SELECT cron.schedule(
  'monthly-sms',
  '0 9 1 * *',
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/sms-reports?type=monthly',
    headers := '{"Authorization": "Bearer <SET private.app_config.service_key — SEE 018_cron_config.sql>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ===== LOW STOCK ALERT (8:30AM Mon-Sat) =====
SELECT cron.schedule(
  'lowstock-sms',
  '30 8 * * 1-6',
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/sms-reports?type=lowstock',
    headers := '{"Authorization": "Bearer <SET private.app_config.service_key — SEE 018_cron_config.sql>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ===== VERIFY CRONS ARE SET =====
SELECT * FROM cron.job;
