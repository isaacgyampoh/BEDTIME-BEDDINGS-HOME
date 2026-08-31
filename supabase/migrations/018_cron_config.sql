-- ============================================================================
-- 018: SCHEDULED JOB CONFIGURATION
--
-- Fixes a live bug and removes a credential from version control.
--
-- 002_cron_jobs.sql and 014_payment_reminders.sql POST to the CORRECT project
-- URL (wqkgfvmvuljzexhevlnp) but carry a bearer token minted for a DIFFERENT
-- project (noiiuwkovoojkcwzupye) — left over from the previous brand. Any
-- function deployed WITH jwt verification therefore rejects the scheduled
-- call, which is why payment reminders can look "scheduled but silent".
--
-- The key is now read from a service-role-only config table instead of being
-- pasted into the SQL, so rotating it never means editing a migration again.
--
-- USAGE — run this file, then set the values once:
--     INSERT INTO private.app_config (key, value) VALUES
--       ('functions_url', 'https://<your-ref>.supabase.co/functions/v1'),
--       ('service_key',   '<your service_role key>')
--     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
--   then re-run the RESCHEDULE block at the bottom.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS private.app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE private.app_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.app_config FROM anon, authenticated;

-- Seed the URL for this project. The key is deliberately NOT seeded.
INSERT INTO private.app_config (key, value)
VALUES ('functions_url', 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- One helper every scheduled job goes through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.call_edge(p_path TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
DECLARE
  v_url TEXT;
  v_key TEXT;
BEGIN
  SELECT value INTO v_url FROM private.app_config WHERE key = 'functions_url';
  SELECT value INTO v_key FROM private.app_config WHERE key = 'service_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE WARNING 'private.call_edge(%): app_config is not populated — skipping', p_path;
    RETURN;
  END IF;

  PERFORM net.http_post(
    url     := v_url || p_path,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- RESCHEDULE — replaces the jobs that carried the wrong project's token.
-- Safe to re-run; cron.schedule on an existing name replaces it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  jobs   TEXT[][] := ARRAY[
    ['sms-morning',       '0 7 * * *',  '/sms-reports?type=morning'],
    ['sms-midday',        '0 13 * * *', '/sms-reports?type=midday'],
    ['sms-evening',       '0 20 * * *', '/sms-reports?type=evening'],
    ['sms-lowstock',      '0 9 * * *',  '/sms-reports?type=lowstock'],
    ['sms-weekly',        '0 20 * * 6', '/sms-reports?type=weekly'],
    ['sms-monthly',       '0 20 28 * *','/sms-reports?type=monthly'],
    ['payment-reminder',  '15 * * * *', '/super-service?action=remind']
  ];
  j TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM private.app_config WHERE key = 'service_key') THEN
    RAISE NOTICE '---------------------------------------------------------------';
    RAISE NOTICE 'app_config.service_key is not set — jobs were NOT rescheduled.';
    RAISE NOTICE 'Insert it (see the header of this file), then re-run this file.';
    RAISE NOTICE '---------------------------------------------------------------';
    RETURN;
  END IF;

  FOREACH j SLICE 1 IN ARRAY jobs LOOP
    BEGIN
      PERFORM cron.unschedule(j[1]);
    EXCEPTION WHEN OTHERS THEN NULL;  -- not scheduled yet
    END;
    PERFORM cron.schedule(j[1], j[2], format('SELECT private.call_edge(%L)', j[3]));
    RAISE NOTICE 'scheduled % (%)', j[1], j[2];
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
SELECT jobname, schedule, command FROM cron.job ORDER BY jobname;

-- No scheduled command should still contain a bearer token:
SELECT count(*) AS jobs_with_inline_token_should_be_zero
  FROM cron.job WHERE command ILIKE '%Bearer eyJ%';
