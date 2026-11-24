-- ===========================================================================
-- 054 — Make hosted Supabase read-only to the public, after cutover
--
-- RUN AGAINST HOSTED SUPABASE ONLY. Never against the Contabo database.
--
-- WHY
--
-- Bedtime cut over to https://api.bedtimehome.com on 24 November 2026. The
-- front ends no longer talk to Supabase, but a customer whose browser still
-- has the OLD bundle cached does, and on Supabase the anon role could still:
--
--   EXECUTE public_order_create, public_order_save_details,
--           public_order_set_ref, public_order_confirm_delivery
--   INSERT  into whatsapp_orders   (table grant AND an RLS policy)
--   UPDATE  products               (table grant -- that is STOCK)
--
-- So a stale tab could create an order, and move stock, in a database nothing
-- reads any more. The order would simply be lost, and the two stock figures
-- would drift apart with nothing to reconcile them.
--
-- A visible failure that a page reload fixes is much better than a silently
-- lost order, which is what this produces.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH
--
-- `service_role`. Supabase's super-service is intentionally left deployed so
-- that NaloPay callbacks for charges begun before cutover still settle there,
-- and it authenticates as service_role, not anon. Revoking anon changes
-- nothing about that path.
--
-- Reads are left alone. They are harmless now -- the data is a frozen copy --
-- and leaving them means a stale tab shows stale products rather than a blank
-- error page while its write attempts fail.
--
-- REVERSIBLE: the GRANT equivalents are at the bottom, commented out, for a
-- rollback to Supabase.
-- ===========================================================================

BEGIN;

-- Refuse to run anywhere but hosted Supabase. The Contabo database has no
-- `anon` role created by Supabase's own bootstrap alongside supabase_admin.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RAISE EXCEPTION 'This is not a hosted Supabase database (no supabase_admin role). Refusing.';
  END IF;
END $$;

-- ── the order RPCs that WRITE ─────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('public_order_create','public_order_save_details',
                        'public_order_set_ref','public_order_confirm_delivery')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
    RAISE NOTICE 'revoked EXECUTE on %', r.proname;
  END LOOP;
END $$;
-- public_order_get and public_order_track are read-only; left executable so a
-- stale tab degrades rather than errors.

-- ── table-level write grants ──────────────────────────────────────────────
-- Driven off the catalogue rather than a fixed list: naming a table that does
-- not exist aborts the whole transaction, and this schema has no sale_items.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['whatsapp_orders','products','sales','customers',
                           'sale_items','stock_adjustments','expenses','invoices']
  LOOP
    IF to_regclass('public.'||quote_ident(t)) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon', t);
      RAISE NOTICE 'revoked writes on %', t;
    END IF;
  END LOOP;
END $$;

-- ── and the policy that allowed the insert ────────────────────────────────
DROP POLICY IF EXISTS "whatsapp_orders_insert" ON public.whatsapp_orders;
DROP POLICY IF EXISTS "orders_insert_public"   ON public.whatsapp_orders;

COMMIT;

-- Verify:
--   SELECT has_function_privilege('anon','public.public_order_create(jsonb)','EXECUTE');  -- false
--   SELECT has_table_privilege('anon','whatsapp_orders','INSERT');                        -- false
--   SELECT has_table_privilege('anon','products','UPDATE');                               -- false
--   SELECT has_table_privilege('service_role','whatsapp_orders','UPDATE');                -- true

-- ── ROLLBACK, if traffic ever goes back to Supabase ───────────────────────
-- GRANT EXECUTE ON FUNCTION public.public_order_create(jsonb) TO anon;
-- GRANT EXECUTE ON FUNCTION public.public_order_save_details(text,text,text,text,text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.public_order_set_ref(text,text) TO anon;
-- GRANT EXECUTE ON FUNCTION public.public_order_confirm_delivery(text,text,text) TO anon;
-- GRANT INSERT, UPDATE ON public.whatsapp_orders TO anon;
-- GRANT UPDATE ON public.products TO anon;
-- CREATE POLICY "whatsapp_orders_insert" ON public.whatsapp_orders FOR INSERT TO anon WITH CHECK (true);
