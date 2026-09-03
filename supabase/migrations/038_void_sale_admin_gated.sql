-- ============================================================================
-- 038: Voiding a sale must be authorised on the SERVER
--
-- The Receipts screen verifies an admin PIN before calling void_sale, but a
-- client-side check protects nothing: the anon key is public, so anyone could
-- call void_sale directly and erase a day's takings. Voiding money out of the
-- books is exactly as destructive as deleting a product, so it goes through
-- the same admin-PIN gate those already use.
--
-- The one-argument form is kept for the service role (the reconcile job and
-- support work) but revoked from anon, so the app must present a PIN.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.void_sale(p_sale_id TEXT, p_admin_pin TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT is_admin_pin(p_admin_pin) THEN
    RETURN json_build_object('success', false, 'error', 'Admin PIN is incorrect');
  END IF;
  RETURN public.void_sale(p_sale_id);
END;
$$;

REVOKE ALL ON FUNCTION public.void_sale(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_sale(TEXT, TEXT) TO anon, authenticated;

SELECT has_function_privilege('anon','public.void_sale(text)','EXECUTE')      AS ungated_should_be_false,
       has_function_privilege('anon','public.void_sale(text,text)','EXECUTE') AS gated_should_be_true;
