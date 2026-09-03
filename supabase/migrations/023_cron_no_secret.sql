-- ============================================================================
-- 023: Schedule the cron jobs without storing any secret
--
-- 018 made private.call_edge() require a service_role key in app_config, and I
-- refused to commit one. That turns out to be unnecessary: every function these
-- jobs call is deployed --no-verify-jwt, so the Authorization header is never
-- checked. Verified against the live endpoints — both return 200 with no header.
--
-- This matters more than it first appeared: the repository is PUBLIC. Not
-- putting a service_role key in a migration was the right call, and now the
-- jobs do not need one to run at all.
--
-- Authorization for the sensitive actions is enforced where it belongs:
--   - admin-PIN checks on the TikTok and staff RPCs
--   - PAYMENT_CALLBACK_SECRET on the payment callbacks
--   - claim_sms() rate limiting on everything that spends money on SMS
-- ============================================================================

SET search_path = private, public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION private.call_edge(p_path TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, pg_temp
AS $$
DECLARE
  v_url TEXT;
  v_key TEXT;
  v_headers JSONB;
BEGIN
  SELECT value INTO v_url FROM private.app_config WHERE key = 'functions_url';
  IF v_url IS NULL THEN
    RAISE WARNING 'private.call_edge(%): functions_url is not set — skipping', p_path;
    RETURN;
  END IF;

  -- Send the key only if one happens to be configured. Its absence is not an
  -- error, because the target functions do not verify it.
  SELECT value INTO v_key FROM private.app_config WHERE key = 'service_key';
  v_headers := jsonb_build_object('Content-Type', 'application/json');
  IF v_key IS NOT NULL THEN
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_key);
  END IF;

  PERFORM net.http_post(url := v_url || p_path, headers := v_headers, body := '{}'::jsonb);
END;
$$;

-- Reschedule every job through the helper, replacing the ones that still carry
-- the previous brand's project token inline.
DO $$
DECLARE
  jobs TEXT[][] := ARRAY[
    ['sms-morning',      '0 7 * * *',   '/sms-reports?type=morning'],
    ['sms-midday',       '0 13 * * *',  '/sms-reports?type=midday'],
    ['sms-evening',      '0 20 * * *',  '/sms-reports?type=evening'],
    ['sms-lowstock',     '0 9 * * *',   '/sms-reports?type=lowstock'],
    ['sms-weekly',       '0 20 * * 6',  '/sms-reports?type=weekly'],
    ['sms-monthly',      '0 20 28 * *', '/sms-reports?type=monthly'],
    ['payment-reminder', '15 * * * *',  '/super-service?action=remind'],
    ['tiktok-status',    '*/10 * * * *','/super-service?action=tiktok-status']
  ];
  j TEXT[];
BEGIN
  FOREACH j SLICE 1 IN ARRAY jobs LOOP
    BEGIN PERFORM cron.unschedule(j[1]); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule(j[1], j[2], format('SELECT private.call_edge(%L)', j[3]));
    RAISE NOTICE 'scheduled % (%)', j[1], j[2];
  END LOOP;
END $$;

-- Verification: no job may still carry an inline bearer token.
SELECT count(*) AS jobs_with_inline_token_should_be_zero
  FROM cron.job WHERE command ILIKE '%Bearer eyJ%';
SELECT jobname, schedule FROM cron.job ORDER BY jobname;
