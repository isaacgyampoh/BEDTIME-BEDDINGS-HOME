-- ============================================================================
-- 036: void_sale could not void a sale whose items were double-encoded
--
-- void_sale iterates sales.items to put stock back. Rows written before 034
-- carried the double-encoded string straight through from whatsapp_orders, so
-- jsonb_array_elements() raised "cannot extract elements from a scalar" and the
-- sale could not be voided at all — a sale you cannot reverse is a real
-- problem, not a cosmetic one.
--
-- Routed through wa_items() so either shape works.
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
    RETURN json_build_object('success', true, 'note', 'already voided');
  END IF;

  v_items := wa_items(v_sale.items);

  -- Put the stock back.
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

  UPDATE sales SET voided = true WHERE id = p_sale_id;
  RETURN json_build_object('success', true, 'receiptNo', v_sale.receipt_no);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION public.void_sale(TEXT) TO anon, authenticated;
