-- ============================================================================
-- 032: Online orders never reached the sales table
--
-- THE BUG. "Process & Package" did this:
--     1. read the order            (status 'Paid')
--     2. UPDATE status -> 'Completed'
--     3. call complete_wa_order
-- and complete_wa_order's very first guard is
--     IF status = 'Completed' THEN RETURN 'Already completed'
-- which step 2 had just made true. The RPC refused every time, so no sales row
-- was ever written. Confirmed on production: 149 sales rows, of which type
-- 'WhatsApp' = 0. Every web and WhatsApp order's revenue was missing from the
-- dashboard and every report.
--
-- The client-side dedupe could not save it either: it looked for a sale whose
-- receipt_no equalled the ORDER number (WEB-…), but this function mints its own
-- receipt (RCP…), so that check could never match.
--
-- FIXES
--   - idempotency is now a real link, whatsapp_orders.sale_receipt_no, instead
--     of a status guard that the caller trips over. Calling twice returns the
--     first receipt rather than refusing or double-counting.
--   - accepts 'Paid' OR 'Completed', so the order of operations no longer
--     matters.
--   - profit matches on productId first (the storefront sends it) and falls
--     back to name. Matching on name alone silently scored 0 profit for any
--     item whose name had drifted.
--   - payment recorded as 'Momo', not 'Paystack'. These are NaloPay MoMo
--     payments; Paystack is not in this flow.
--   - type reflects where the order came from: 'Online' or 'WhatsApp'.
--   - returns the receipt and its lines so the till can print it.
--
-- Stock is deliberately NOT touched: it is deducted at payment by
-- deduct_order_stock, and deducting here again would double-count.
-- ============================================================================

ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS sale_receipt_no TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_sale_receipt ON whatsapp_orders (sale_receipt_no)
  WHERE sale_receipt_no IS NOT NULL;

CREATE OR REPLACE FUNCTION public.complete_wa_order(p_order_id TEXT, p_processed_by TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_order    RECORD;
  v_item     JSONB;
  v_prod     RECORD;
  v_profit   NUMERIC := 0;
  v_subtotal NUMERIC := 0;
  v_qty      INTEGER;
  v_price    NUMERIC;
  v_sale_id  TEXT;
  v_receipt  TEXT;
  v_type     TEXT;
  v_existing RECORD;
BEGIN
  SELECT * INTO v_order FROM whatsapp_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Order not found');
  END IF;

  -- Already recorded: hand back the same receipt so the caller can reprint it.
  IF v_order.sale_receipt_no IS NOT NULL THEN
    SELECT * INTO v_existing FROM sales WHERE receipt_no = v_order.sale_receipt_no;
    RETURN json_build_object(
      'success', true, 'alreadyRecorded', true,
      'receiptNo', v_order.sale_receipt_no,
      'total', COALESCE(v_existing.total, v_order.total),
      'items', COALESCE(v_existing.items, v_order.items),
      'customer', v_order.customer_phone,
      'cashier', COALESCE(v_existing.cashier, p_processed_by),
      'date', v_existing.date
    );
  END IF;

  IF v_order.status NOT IN ('Paid', 'Completed') THEN
    RETURN json_build_object('success', false,
      'error', 'Order is not paid yet (' || COALESCE(v_order.status, '?') || ')');
  END IF;

  -- Profit from the real cost price. productId first; name only as a fallback.
  FOR v_item IN SELECT * FROM jsonb_array_elements(
        CASE jsonb_typeof(v_order.items) WHEN 'array' THEN v_order.items ELSE '[]'::jsonb END) LOOP
    v_qty   := COALESCE((v_item->>'qty')::INTEGER, 0);
    v_price := COALESCE((v_item->>'price')::NUMERIC, 0);
    v_subtotal := v_subtotal + COALESCE((v_item->>'lineTotal')::NUMERIC, v_price * v_qty);

    v_prod := NULL;
    IF v_item->>'productId' IS NOT NULL THEN
      SELECT * INTO v_prod FROM products WHERE id = v_item->>'productId';
    END IF;
    IF v_prod IS NULL THEN
      SELECT * INTO v_prod FROM products WHERE lower(name) = lower(v_item->>'name') LIMIT 1;
    END IF;

    IF v_prod IS NOT NULL THEN
      v_profit := v_profit + (v_price - COALESCE(v_prod.cost_price, 0)) * v_qty;
    END IF;
  END LOOP;

  v_type := CASE v_order.source
              WHEN 'web'      THEN 'Online'
              WHEN 'whatsapp' THEN 'WhatsApp'
              ELSE 'Retail'
            END;

  v_sale_id := short_id();
  v_receipt := generate_receipt_no();

  INSERT INTO sales (id, receipt_no, date, items, subtotal, discount, total, profit,
                     payment, customer, type, cashier, voided)
  VALUES (v_sale_id, v_receipt, now(), v_order.items,
          COALESCE(NULLIF(v_order.subtotal, 0), v_subtotal), 0,
          v_order.total, v_profit,
          'Momo', v_order.customer_phone, v_type, p_processed_by, false);

  -- The link that makes this idempotent.
  UPDATE whatsapp_orders SET sale_receipt_no = v_receipt WHERE id = p_order_id;

  IF COALESCE(v_order.customer_phone, '') <> '' THEN
    INSERT INTO customers (phone, visit_count, total_spent, last_visit)
    VALUES (v_order.customer_phone, 1, v_order.total, now())
    ON CONFLICT (phone) DO UPDATE SET
      visit_count = customers.visit_count + 1,
      total_spent = customers.total_spent + v_order.total,
      last_visit  = now();
  END IF;

  RETURN json_build_object(
    'success', true, 'alreadyRecorded', false,
    'receiptNo', v_receipt, 'saleId', v_sale_id,
    'total', v_order.total, 'subtotal', COALESCE(NULLIF(v_order.subtotal, 0), v_subtotal),
    'profit', v_profit, 'items', v_order.items,
    'customer', v_order.customer_phone, 'cashier', p_processed_by,
    'type', v_type, 'date', now()
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_wa_order(TEXT, TEXT) TO anon, authenticated;
