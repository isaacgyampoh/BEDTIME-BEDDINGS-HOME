-- ============================================================================
-- 027: system_health() — one place to see whether the automated parts work
--
-- Scheduled reports, payment confirmations and thank-you messages all run with
-- nobody watching. When one breaks it fails silently, which is exactly how the
-- Pending-orders bug and the dead SMS key both survived so long. This surfaces
-- them instead.
--
-- Admin-PIN gated: it reports on payments and messaging, so it is not for the
-- anon role to read freely.
-- ============================================================================

CREATE OR REPLACE FUNCTION system_health(p_admin_pin TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, cron, net, pg_temp
AS $$
DECLARE
  v_jobs        jsonb;
  v_runs        jsonb;
  v_http        jsonb;
  v_sms         jsonb;
  v_orders      jsonb;
  v_stuck       jsonb;
BEGIN
  IF NOT is_admin_pin(p_admin_pin) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin PIN is incorrect');
  END IF;

  -- Scheduled jobs and whether they are firing.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('job', jobname, 'schedule', schedule, 'active', active) ORDER BY jobname), '[]')
    INTO v_jobs FROM cron.job;

  BEGIN
    SELECT COALESCE(jsonb_agg(x), '[]') INTO v_runs FROM (
      SELECT jsonb_build_object('job', j.jobname, 'status', d.status, 'at', d.start_time) AS x
        FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
       ORDER BY d.start_time DESC LIMIT 10) t;
  EXCEPTION WHEN OTHERS THEN v_runs := '[]'; END;

  -- Did the outbound calls actually reach the functions?
  BEGIN
    SELECT COALESCE(jsonb_agg(x), '[]') INTO v_http FROM (
      SELECT jsonb_build_object('code', status_code, 'at', created) AS x
        FROM net._http_response ORDER BY created DESC LIMIT 8) t;
  EXCEPTION WHEN OTHERS THEN v_http := '[]'; END;

  -- SMS actually sent in the last day, by kind.
  SELECT COALESCE(jsonb_object_agg(kind, n), '{}') INTO v_sms FROM (
    SELECT COALESCE(kind, 'unknown') AS kind, count(*) AS n
      FROM sms_log WHERE sent_at > now() - interval '24 hours'
     GROUP BY 1) t;

  -- Order flow over the last week.
  SELECT COALESCE(jsonb_object_agg(k, n), '{}') INTO v_orders FROM (
    SELECT COALESCE(source,'?') || '/' || COALESCE(status,'?') AS k, count(*) AS n
      FROM whatsapp_orders WHERE date > now() - interval '7 days'
     GROUP BY 1) t;

  -- The symptom that started all this: paid-looking orders still Pending.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order', order_no, 'source', source, 'age_hours',
           round(EXTRACT(EPOCH FROM (now() - date))/3600)::int,
           'has_nalopay_id', nalopay_order_id IS NOT NULL)), '[]')
    INTO v_stuck
    FROM whatsapp_orders
   WHERE status = 'Pending' AND date < now() - interval '2 hours'
     AND date > now() - interval '7 days';

  RETURN jsonb_build_object(
    'success', true,
    'checked_at', now(),
    'cron_jobs', v_jobs,
    'recent_runs', v_runs,
    'recent_http', v_http,
    'sms_last_24h', v_sms,
    'orders_last_7d', v_orders,
    'pending_over_2h', v_stuck
  );
END;
$$;

REVOKE ALL ON FUNCTION system_health(TEXT) FROM public;
GRANT EXECUTE ON FUNCTION system_health(TEXT) TO anon, authenticated;
