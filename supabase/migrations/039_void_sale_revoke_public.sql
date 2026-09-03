-- ============================================================================
-- 039: the ungated void_sale was still reachable
--
-- 038 revoked EXECUTE from anon and authenticated, but Postgres grants EXECUTE
-- on a new function to PUBLIC by default, and anon inherits that. So the
-- one-argument void_sale — which takes no PIN — was still callable with the
-- public anon key. Verified: it ran and returned "Sale not found" rather than
-- a permission error.
--
-- Revoking from PUBLIC is what actually closes it. Same sweep applied to the
-- other privileged helpers, which have the same default-grant exposure.
-- ============================================================================

REVOKE ALL ON FUNCTION public.void_sale(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_sale(TEXT, TEXT) TO anon, authenticated;

-- Same class of exposure on the other internal helpers.
DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.is_admin_pin(text)',
    'public.claim_sms(text,text)',
    'public.sms_delivery_summary()',
    'public.deduct_order_stock(text)',
    'public.restore_order_stock(text)'
  ] LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skipped % (not present)', fn;
    END;
  END LOOP;
END $$;

-- deduct/restore are called by the app's order screens, so re-grant those two.
GRANT EXECUTE ON FUNCTION public.deduct_order_stock(TEXT)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_order_stock(TEXT) TO anon, authenticated;

SELECT
  has_function_privilege('anon','public.void_sale(text)','EXECUTE')          AS ungated_void_should_be_false,
  has_function_privilege('anon','public.void_sale(text,text)','EXECUTE')     AS gated_void_should_be_true,
  has_function_privilege('anon','public.is_admin_pin(text)','EXECUTE')       AS is_admin_pin_should_be_false,
  has_function_privilege('anon','public.claim_sms(text,text)','EXECUTE')     AS claim_sms_should_be_false;
