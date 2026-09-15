-- ============================================================================
-- 040: date an online sale when the money arrived, not when it was packaged
--
-- complete_wa_order stamped the sale now(), i.e. whenever someone clicked
-- Process & Package. Package the same day and it makes no difference; package
-- the next morning and yesterday's takings land in today's figures. The sale
-- belongs to the day the customer paid.
--
-- This also matters for the backfill below: two orders from 3 September were
-- marked Paid by hand before the packaging fix existed and were never recorded.
-- Recording them today would drop GHS 1,060 of eleven-day-old revenue into
-- today's numbers.
--
-- Falls back to the order date when paid_at is missing, and to now() if both
-- are somehow absent.
-- ============================================================================

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
  v_when     TIMESTAMPTZ;
  v_existing RECORD;
BEGIN
  SELECT * INTO v_order FROM whatsapp_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Order not found');
  END IF;

  IF v_order.sale_receipt_no IS NOT NULL THEN
    SELECT * INTO v_existing FROM sales WHERE receipt_no = v_order.sale_receipt_no;
    RETURN json_build_object('success', true, 'alreadyRecorded', true,
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

  -- The money arrived when the customer paid.
  v_when := COALESCE(v_order.paid_at, v_order.date, now());

  v_sale_id := short_id();
  v_receipt := generate_receipt_no();

  INSERT INTO sales (id, receipt_no, date, items, subtotal, discount, total, profit,
                     payment, customer, type, cashier, voided)
  VALUES (v_sale_id, v_receipt, v_when, v_items,
          COALESCE(NULLIF(v_order.subtotal, 0), v_subtotal), 0,
          v_order.total, v_profit, 'Momo',
          v_order.customer_phone, v_type, p_processed_by, false);

  UPDATE whatsapp_orders SET sale_receipt_no = v_receipt WHERE id = p_order_id;

  IF COALESCE(v_order.customer_phone, '') <> '' THEN
    INSERT INTO customers (phone, visit_count, total_spent, last_visit)
    VALUES (v_order.customer_phone, 1, v_order.total, v_when)
    ON CONFLICT (phone) DO UPDATE SET
      visit_count = customers.visit_count + 1,
      total_spent = customers.total_spent + v_order.total,
      last_visit  = GREATEST(customers.last_visit, EXCLUDED.last_visit);
  END IF;

  RETURN json_build_object('success', true, 'alreadyRecorded', false,
    'receiptNo', v_receipt, 'saleId', v_sale_id,
    'total', v_order.total, 'subtotal', COALESCE(NULLIF(v_order.subtotal, 0), v_subtotal),
    'profit', v_profit, 'items', v_items,
    'customer', v_order.customer_phone, 'cashier', p_processed_by,
    'type', v_type, 'date', v_when);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION public.complete_wa_order(TEXT, TEXT) TO anon, authenticated;
