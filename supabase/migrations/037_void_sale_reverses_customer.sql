-- ============================================================================
-- 037: Voiding a sale left the customer's lifetime spend inflated
--
-- record_sale and complete_wa_order both add to customers.total_spent and
-- visit_count. void_sale put the stock back but never reversed those, so the
-- Customers page kept counting money that was never taken.
--
-- Clamped at zero: the counters are cumulative and a void of a sale predating
-- some earlier correction must not drive them negative.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.void_sale(p_sale_id TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_sale  RECORD;
  v_items JSONB;
  v_item  JSONB;
  v_qty   INTEGER;
  v_pid   TEXT;
BEGIN
  SELECT * INTO v_sale FROM sales WHERE id = p_sale_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Sale not found');
  END IF;
  IF COALESCE(v_sale.voided, false) THEN
    RETURN json_build_object('success', true, 'note', 'already voided',
                             'receiptNo', v_sale.receipt_no);
  END IF;

  v_items := wa_items(v_sale.items);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_qty := COALESCE((v_item->>'qty')::INTEGER, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    IF (v_item->>'isBundle')::BOOLEAN IS TRUE
       AND jsonb_typeof(v_item->'bundleItems') = 'array' THEN
      DECLARE v_bi JSONB;
      BEGIN
        FOR v_bi IN SELECT * FROM jsonb_array_elements(v_item->'bundleItems') LOOP
          UPDATE products
             SET quantity = quantity + COALESCE((v_bi->>'qty')::INTEGER, 0) * v_qty
           WHERE id = v_bi->>'productId';
        END LOOP;
      END;
    ELSE
      v_pid := v_item->>'productId';
      IF v_pid IS NULL OR NOT EXISTS (SELECT 1 FROM products WHERE id = v_pid) THEN
        SELECT id INTO v_pid FROM products
         WHERE lower(name) = lower(COALESCE(v_item->>'name', '')) LIMIT 1;
      END IF;
      IF v_pid IS NOT NULL THEN
        UPDATE products SET quantity = quantity + v_qty WHERE id = v_pid;
      END IF;
    END IF;
  END LOOP;

  -- Take the money back off the customer's record too.
  IF COALESCE(v_sale.customer, '') NOT IN ('', 'Walk-in') THEN
    UPDATE customers
       SET total_spent = GREATEST(0, total_spent - COALESCE(v_sale.total, 0)),
           visit_count = GREATEST(0, visit_count - 1)
     WHERE phone = v_sale.customer;
  END IF;

  UPDATE sales SET voided = true WHERE id = p_sale_id;

  -- If this sale came from an online order, unlink it so the order can be
  -- re-packaged and re-recorded rather than being permanently stuck.
  UPDATE whatsapp_orders SET sale_receipt_no = NULL
   WHERE sale_receipt_no = v_sale.receipt_no;

  RETURN json_build_object('success', true, 'receiptNo', v_sale.receipt_no,
                           'total', v_sale.total);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION public.void_sale(TEXT) TO anon, authenticated;
