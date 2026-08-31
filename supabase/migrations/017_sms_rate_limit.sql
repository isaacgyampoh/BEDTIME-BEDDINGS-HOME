-- ============================================================================
-- 017: SMS RATE LIMITING
--
-- The Edge Function actions that send SMS (send-ussd-code, thankyou-sms,
-- resend-sms, remind) are deployed --no-verify-jwt and take an unauthenticated
-- POST. Every call spends real money at mNotify/Arkesel and can be pointed at
-- any phone number, so the URL alone was enough to run up the SMS bill or to
-- harass a customer.
--
-- Enforced in the database rather than in the function's memory, because Edge
-- Function instances are ephemeral and there are several of them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sms_log (
  id      BIGSERIAL PRIMARY KEY,
  phone   TEXT NOT NULL,
  kind    TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_log_phone_time ON sms_log (phone, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_log_time       ON sms_log (sent_at DESC);

ALTER TABLE sms_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_log FROM anon, authenticated;   -- service_role only

/**
 * Claim one SMS send. Returns {allowed:true} and records the send, or
 * {allowed:false, reason:...} when a limit is hit. Atomic: the caller must
 * treat a false result as "do not send".
 *
 * Limits are set for a single shop's real traffic:
 *   per number  — 4 in 10 minutes   (a retry or two is fine, a flood is not)
 *   per number  — 12 in 24 hours
 *   whole shop  — 200 in 1 hour     (backstop against a runaway loop)
 */
CREATE OR REPLACE FUNCTION claim_sms(p_phone TEXT, p_kind TEXT DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_phone   TEXT;
  v_recent  INTEGER;
  v_daily   INTEGER;
  v_global  INTEGER;
BEGIN
  -- Normalise so 0244…, +233244… and 233244… share one bucket.
  v_phone := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF length(v_phone) < 9 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid phone');
  END IF;
  v_phone := right(v_phone, 9);

  SELECT count(*) INTO v_recent FROM sms_log
   WHERE phone = v_phone AND sent_at > now() - interval '10 minutes';
  IF v_recent >= 4 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'per-number 10 minute limit');
  END IF;

  SELECT count(*) INTO v_daily FROM sms_log
   WHERE phone = v_phone AND sent_at > now() - interval '24 hours';
  IF v_daily >= 12 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'per-number daily limit');
  END IF;

  SELECT count(*) INTO v_global FROM sms_log WHERE sent_at > now() - interval '1 hour';
  IF v_global >= 200 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'shop hourly limit');
  END IF;

  INSERT INTO sms_log (phone, kind) VALUES (v_phone, p_kind);

  DELETE FROM sms_log WHERE sent_at < now() - interval '7 days';

  RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE ALL ON FUNCTION claim_sms(TEXT, TEXT) FROM public, anon, authenticated;
-- service_role only: the Edge Functions call this with the service key.

-- Verification
SELECT has_function_privilege('anon', 'claim_sms(text,text)', 'EXECUTE') AS anon_can_send_sms_should_be_false;
