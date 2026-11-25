-- ===========================================================================
-- 055 — Stop the public key reading every customer order and every margin
--
-- Apply to BOTH backends. Found by the final security audit, 24 Nov 2026.
--
-- WHAT WAS WRONG
--
-- With nothing but the anon key -- which ships in every browser bundle and is
-- public by design -- an attacker could read:
--
--   whatsapp_orders        ALL 663 rows, including customer_name,
--                          customer_phone, address, items, total,
--                          paystack_ref, nalopay_order_id and ussd_code
--   product_price_history  all 170 rows, i.e. the cost and margin history
--
-- The order policy was named `anon_read_own_orders`, which describes an
-- intent its predicate does not implement: `USING (true)` matches every row
-- in the table. The name is why it survived migration 043, which tightened
-- sales, customers and expenses but took that policy at its word.
--
-- A ussd_code is the string a customer dials to pay. Publishing the whole set
-- alongside the order totals is worse than an ordinary PII leak.
--
-- WHY REMOVING IT IS SAFE
--
-- Migration 044 already moved the shop front onto SECURITY DEFINER RPCs owned
-- by postgres -- public_order_create, _get, _track, _save_details, _set_ref,
-- _confirm_delivery -- which do not depend on anon's table privileges at all.
-- public_order_track returns a deliberately narrow field set (order_no,
-- status, total, customer_name, tracking_no, delivery_*) and nothing else:
-- no address, no phone, no payment reference, no items.
--
-- The three remaining direct table calls in storefront/src/App.jsx are
-- FALLBACKS behind rpcOrNull(), which returns null on error. They are dead
-- code now that 044 is applied, and they are removed in the same change so a
-- silently failing RPC cannot quietly resurrect the exposure.
--
-- The till is unaffected: staff hold an `authenticated` session and the
-- wa_select / wa_insert / wa_update policies are untouched.
-- ===========================================================================

BEGIN;

-- ── orders ────────────────────────────────────────────────────────────────
-- USING (true) for anon. The RPCs replace it.
DROP POLICY IF EXISTS "anon_read_own_orders" ON public.whatsapp_orders;
DROP POLICY IF EXISTS "anon_insert_orders"   ON public.whatsapp_orders;

-- Policies only bite where a grant exists, so remove the grant as well.
-- SECURITY DEFINER functions are unaffected: they run as their owner.
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_orders FROM anon;

-- ── cost and margin history ───────────────────────────────────────────────
-- Shown in the till's price history view, which is staff-only.
DROP POLICY IF EXISTS "price_hist_sel" ON public.product_price_history;
CREATE POLICY "price_hist_sel" ON public.product_price_history
  FOR SELECT TO authenticated USING (true);
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.product_price_history FROM anon;

COMMIT;

-- PostgREST caches the schema. Without this the RPCs answer PGRST202 until
-- the next restart -- which is exactly what happened while auditing.
NOTIFY pgrst, 'reload schema';

-- Verify:
--   anon  : whatsapp_orders 0 rows, product_price_history 0 rows
--   anon  : rpc/public_order_track with a real order_no still returns 1 row
--   anon  : rpc/public_order_track with 'W' returns 0 rows
--   staff : whatsapp_orders readable, price history readable
