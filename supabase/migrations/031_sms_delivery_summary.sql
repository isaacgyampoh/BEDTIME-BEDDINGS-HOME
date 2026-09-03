-- ============================================================================
-- 031: sms_delivery_summary() — aggregate-only view of outbound messaging
--
-- Counts and HTTP status codes only: no phone numbers, no message bodies. Safe
-- to expose through the health endpoint, and enough to answer the question that
-- went unanswered for months — "are the scheduled jobs actually firing?"
-- ============================================================================

CREATE OR REPLACE FUNCTION sms_delivery_summary()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net, pg_temp
AS $$
DECLARE
  v_by_kind jsonb;
  v_24h     integer;
  v_http    jsonb;
  v_last    timestamptz;
BEGIN
  SELECT COALESCE(jsonb_object_agg(kind, n), '{}') INTO v_by_kind
    FROM (SELECT COALESCE(kind,'unknown') AS kind, count(*) AS n
            FROM sms_log WHERE sent_at > now() - interval '24 hours' GROUP BY 1) t;

  SELECT count(*), max(sent_at) INTO v_24h, v_last
    FROM sms_log WHERE sent_at > now() - interval '24 hours';

  -- Outbound calls pg_net made on the database's behalf: this is the leg
  -- between cron and the edge function.
  BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('code', status_code, 'at', created) ORDER BY created DESC), '[]')
      INTO v_http FROM (SELECT status_code, created FROM net._http_response ORDER BY created DESC LIMIT 8) t;
  EXCEPTION WHEN OTHERS THEN v_http := '[]'; END;

  RETURN jsonb_build_object(
    'sms_last_24h', v_24h,
    'by_kind', v_by_kind,
    'last_sms_at', v_last,
    'recent_outbound_calls', v_http
  );
END;
$$;
REVOKE ALL ON FUNCTION sms_delivery_summary() FROM public, anon, authenticated;
