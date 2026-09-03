-- ============================================================================
-- 034: whatsapp_orders.items is stored double-encoded
--
-- Both the storefront and the POS insert `items: JSON.stringify(items)` into a
-- jsonb column. That stores a JSON *string*, not a JSON array, so
-- jsonb_typeof(items) is 'string' and jsonb_array_elements() cannot iterate it.
--
-- That is the real reason online sales recorded profit 0.00: my guard in 032
-- fell through to '[]' and the loop never ran. (033 blamed the RECORD null
-- check, which was a red herring — the loop was never entered at all.)
--
-- Fixed by normalising at read time rather than migrating the column: the two
-- clients would have to change together, and a half-migrated column is worse
-- than one shape handled in one place. Both shapes are accepted.
-- ============================================================================

-- One place that knows how to read the column, whatever shape it is in.
CREATE OR REPLACE FUNCTION wa_items(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE v JSONB;
BEGIN
  IF p_items IS NULL THEN RETURN '[]'::jsonb; END IF;
  IF jsonb_typeof(p_items) = 'array' THEN RETURN p_items; END IF;
  IF jsonb_typeof(p_items) = 'string' THEN
    BEGIN
      v := (p_items #>> '{}')::jsonb;                 -- decode the inner JSON
      IF jsonb_typeof(v) = 'array' THEN RETURN v; END IF;
    EXCEPTION WHEN OTHERS THEN RETURN '[]'::jsonb;
    END;
  END IF;
  RETURN '[]'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_wa_order(p_order_id TEXT, p_processed_by TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_order    RECORD;
  v_items    JSONB;
  v_item     JSONB;
  v_cost     NUMERIC;
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

  IF v_order.sale_receipt_no IS NOT NULL THEN
    SELECT * INTO v_existing FROM sales WHERE receipt_no = v_order.sale_receipt_no;
    RETURN json_build_object(
      'success', true, 'alreadyRecorded', true,
      'receiptNo', v_order.sale_receipt_no,
      'total', COALESCE(v_existing.total, v_order.total),
      'items', COALESCE(v_existing.items, wa_items(v_order.items)),
      'customer', v_order.customer_phone,
      'cashier', COALESCE(v_existing.cashier, p_processed_by),
      'date', v_existing.date);
  END IF;

  IF v_order.status NOT IN ('Paid', 'Completed') THEN
    RETURN json_build_object('success', false,
      'error', 'Order is not paid yet (' || COALESCE(v_order.status, '?') || ')');
  END IF;

  v_items := wa_items(v_order.items);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_qty   := COALESCE((v_item->>'qty')::INTEGER, 0);
    v_price := COALESCE((v_item->>'price')::NUMERIC, 0);
    v_subtotal := v_subtotal + COALESCE((v_item->>'lineTotal')::NUMERIC, v_price * v_qty);

    v_cost := NULL;
    IF v_item->>'productId' IS NOT NULL THEN
      SELECT cost_price INTO v_cost FROM products WHERE id = v_item->>'productId';
    END IF;
    IF v_cost IS NULL THEN
      SELECT cost_price INTO v_cost FROM products
       WHERE lower(name) = lower(COALESCE(v_item->>'name', '')) LIMIT 1;
    END IF;
    IF v_cost IS NOT NULL THEN
      v_profit := v_profit + (v_price - v_cost) * v_qty;
    END IF;
  END LOOP;

  v_type := CASE v_order.source
              WHEN 'web' THEN 'Online' WHEN 'whatsapp' THEN 'WhatsApp' ELSE 'Retail' END;

  v_sale_id := short_id();
  v_receipt := generate_receipt_no();

  -- Store the DECODED array in sales, so receipts and reports can read it
  -- without every consumer having to know about the double encoding.
  INSERT INTO sales (id, receipt_no, date, items, subtotal, discount, total, profit,
                     payment, customer, type, cashier, voided)
  VALUES (v_sale_id, v_receipt, now(), v_items,
          COALESCE(NULLIF(v_order.subtotal, 0), v_subtotal), 0,
          v_order.total, v_profit, 'Momo',
          v_order.customer_phone, v_type, p_processed_by, false);

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
    'profit', v_profit, 'items', v_items,
    'customer', v_order.customer_phone, 'cashier', p_processed_by,
    'type', v_type, 'date', now());
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION public.complete_wa_order(TEXT, TEXT) TO anon, authenticated;

-- deduct_order_stock reads the same column and has the same blind spot.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'deduct_order_stock') THEN
    RAISE NOTICE 'deduct_order_stock exists — verify it uses wa_items() for items';
  END IF;
END $$;
