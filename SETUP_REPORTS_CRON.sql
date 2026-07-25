-- ============================================================
-- BEDTIME BEDDINGS HOME — scheduled SMS reports (OPTIONAL)
-- Run AFTER deploying the edge functions. Replace the anon/service
-- key placeholders with the NEW project's key before running.
-- ============================================================

-- ==================== 002_cron_jobs ====================
-- ============================================================================
-- EVERYTINROOM POS — CRON JOBS FOR SMS REPORTS
-- Run AFTER the schema. Requires pg_cron + pg_net (enabled in Supabase Dashboard → Extensions)
-- 
-- Go to: Supabase Dashboard → Database → Extensions → Enable pg_cron and pg_net
-- Then run this SQL.
--
-- IMPORTANT: Replace https://wqkgfvmvuljzexhevlnp.supabase.co and eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w below!
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
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w"}'::jsonb,
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
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w"}'::jsonb,
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
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w"}'::jsonb,
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
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w"}'::jsonb,
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
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w"}'::jsonb,
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
    headers := '{"Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ===== VERIFY CRONS ARE SET =====
SELECT * FROM cron.job;



-- ==================== 013_scheduled_reports ====================
-- Enable pg_cron extension (may already be enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Grant usage
GRANT USAGE ON SCHEMA cron TO postgres;

-- Morning report at 6:00 AM GMT (Ghana time)
SELECT cron.schedule(
  'morning-report',
  '0 6 * * *',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=daily',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);

-- Afternoon report at 1:00 PM GMT
SELECT cron.schedule(
  'afternoon-report',
  '0 13 * * *',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=today',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);

-- Evening report at 8:00 PM GMT
SELECT cron.schedule(
  'evening-report',
  '0 20 * * *',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=evening',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);

-- Weekly report every Monday at 6:00 AM GMT
SELECT cron.schedule(
  'weekly-report',
  '0 6 * * 1',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=weekly',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);

-- Monthly report on 1st of every month at 6:00 AM GMT
SELECT cron.schedule(
  'monthly-report',
  '0 6 1 * *',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=monthly',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);



-- ==================== 014_report_schedule_monsat ====================
-- ============================================================
-- Updated report schedule (run in Supabase SQL Editor)
-- Shop works Mon–Sat. Sunday: send the weekly summary in the morning.
--
-- Cron day-of-week: 0 or 7 = Sunday, 1 = Monday ... 6 = Saturday.
-- Times are GMT (Ghana = GMT, so these are local times).
-- ============================================================

-- Remove the old jobs first so we don't double-send.
SELECT cron.unschedule('morning-report');
SELECT cron.unschedule('afternoon-report');
SELECT cron.unschedule('evening-report');
SELECT cron.unschedule('weekly-report');
-- (monthly-report stays as-is)

-- ---- DAILY reports: Monday–Saturday only (day-of-week 1–6) ----

-- Afternoon "today so far" at 1:00 PM, Mon–Sat
SELECT cron.schedule(
  'afternoon-report',
  '0 13 * * 1-6',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=today',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);

-- Evening end-of-day (money summary) at 8:00 PM, Mon–Sat
SELECT cron.schedule(
  'evening-report',
  '0 20 * * 1-6',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=evening',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);

-- ---- WEEKLY summary: Sunday morning at 8:00 AM (day-of-week 0) ----
-- Covers the Mon–Sat that just ended, with best-sellers.
SELECT cron.schedule(
  'weekly-report',
  '0 8 * * 0',
  $$SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=report&type=weekly',
    body := '{}',
    headers := '{"Content-Type": "application/json"}'::jsonb
  )$$
);

-- ---- Verify what's scheduled now ----
SELECT jobname, schedule FROM cron.job ORDER BY jobname;


