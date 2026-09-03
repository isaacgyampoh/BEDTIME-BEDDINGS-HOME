-- ============================================================================
-- 025: Add the nalopay_order_id column the code has always assumed exists
--
-- THE BUG THIS FIXES — why e-commerce orders stayed Pending until fixed by hand.
--
-- super-service references whatsapp_orders.nalopay_order_id in six places, but
-- the column was never created. Two independent failures followed:
--
--   1. After a successful charge the function writes
--        UPDATE whatsapp_orders SET paystack_ref=…, nalopay_order_id=…
--      That UPDATE throws on the missing column and is swallowed by a bare
--      catch {}. So paystack_ref was never written either. Confirmed against
--      production: all 14 web orders have paystack_ref = NULL.
--      nalopay-callback then looks the order up BY paystack_ref, finds nothing,
--      logs "no matching order" and leaves the order Pending.
--
--   2. reconcile-payments — the safety net that should catch a missed callback —
--      SELECTs nalopay_order_id. The whole select errors, pend comes back null,
--      and it reports "No pending orders to reconcile" every single time.
--
-- Adding the column repairs both paths for new orders. Orders placed before
-- this have no NaloPay id recorded and can only be confirmed by the callback's
-- order_no fallback (added in the same change) or by hand.
-- ============================================================================

ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS nalopay_order_id TEXT;

CREATE INDEX IF NOT EXISTS idx_wa_nalopay_order_id
  ON whatsapp_orders (nalopay_order_id) WHERE nalopay_order_id IS NOT NULL;

-- paystack_ref is the other lookup key the callback uses; it was never indexed.
CREATE INDEX IF NOT EXISTS idx_wa_paystack_ref
  ON whatsapp_orders (paystack_ref) WHERE paystack_ref IS NOT NULL;

-- order_no is the callback's new fallback, and the storefront's tracking key.
CREATE INDEX IF NOT EXISTS idx_wa_order_no ON whatsapp_orders (order_no);

SELECT column_name FROM information_schema.columns
 WHERE table_name = 'whatsapp_orders' AND column_name = 'nalopay_order_id';
