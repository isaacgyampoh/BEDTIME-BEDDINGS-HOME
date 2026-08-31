-- ============================================================================
-- 019: HOTFIX — put `extensions` on every pinned search_path
--
-- 015/016 pinned search_path on the SECURITY DEFINER functions (a real
-- privilege-escalation fix), but pinned it to `public, pg_temp`. Supabase keeps
-- uuid-ossp and pgcrypto in the `extensions` schema, so any function that
-- reaches uuid_generate_v4() / crypt() through a pinned path could no longer
-- resolve them.
--
-- record_sale calls short_id(), which calls uuid_generate_v4(): checkout
-- returned "function uuid_generate_v4() does not exist". This restores it and
-- sweeps every other function with the same gap.
-- ============================================================================

SET search_path = public, extensions, pg_temp;

-- 1. The specific break: every function reachable from checkout.
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('record_sale','void_sale','process_refund',
                         'complete_wa_order','deduct_order_stock','restore_order_stock',
                         'short_id','generate_receipt_no','generate_wa_order_no',
                         'generate_refund_no','verify_pin','is_admin_pin',
                         'admin_save_staff','admin_delete_staff','admin_delete_row',
                         'adjust_product_stock','product_effective_price','claim_sms',
                         'get_dashboard','assign_ussd_code','generate_tracking_no')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', fn.sig);
  END LOOP;
END $$;

-- 2. Sweep: any remaining SECURITY DEFINER function pinned without `extensions`.
DO $$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE '%extensions%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', fn.sig);
    RAISE NOTICE 'repaired search_path on %', fn.sig;
  END LOOP;
END $$;

-- 3. Verification — both counts should be zero.
SELECT count(*) AS secdef_without_extensions_should_be_zero
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname='public' AND p.prosecdef
   AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE '%extensions%');
