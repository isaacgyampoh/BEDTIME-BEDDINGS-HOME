-- ============================================================================
-- 029: Do not rate-limit the shop's own phone
--
-- claim_sms caps 4 messages per number per 10 minutes, which is right for a
-- customer number: it stops the unauthenticated SMS endpoints being used to
-- flood someone. It is wrong for the shop's own line, which legitimately
-- receives an alert for every online payment plus four scheduled reports a
-- day. Five orders in ten minutes and the owner stops being told, silently.
--
-- Shop numbers are configured here rather than hardcoded, and still counted
-- so system_health() can show the real volume.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sms_exempt_numbers (
  phone      TEXT PRIMARY KEY,          -- last 9 digits, matching claim_sms
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sms_exempt_numbers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_exempt_numbers FROM anon, authenticated;

INSERT INTO sms_exempt_numbers (phone, label) VALUES ('599084552', 'Shop / owner line')
ON CONFLICT (phone) DO NOTHING;

CREATE OR REPLACE FUNCTION claim_sms(p_phone TEXT, p_kind TEXT DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_phone  TEXT;
  v_recent INTEGER;
  v_daily  INTEGER;
  v_global INTEGER;
  v_exempt BOOLEAN;
BEGIN
  v_phone := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  IF length(v_phone) < 9 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid phone');
  END IF;
  v_phone := right(v_phone, 9);

  SELECT EXISTS (SELECT 1 FROM sms_exempt_numbers WHERE phone = v_phone) INTO v_exempt;

  IF NOT v_exempt THEN
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
  END IF;

  -- The shop-wide backstop still applies to everyone: it exists to catch a
  -- runaway loop, and the owner's line is not exempt from a runaway loop.
  SELECT count(*) INTO v_global FROM sms_log WHERE sent_at > now() - interval '1 hour';
  IF v_global >= 200 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'shop hourly limit');
  END IF;

  INSERT INTO sms_log (phone, kind) VALUES (v_phone, p_kind);
  DELETE FROM sms_log WHERE sent_at < now() - interval '7 days';

  RETURN jsonb_build_object('allowed', true, 'exempt', v_exempt);
END;
$$;
REVOKE ALL ON FUNCTION claim_sms(TEXT, TEXT) FROM public, anon, authenticated;
