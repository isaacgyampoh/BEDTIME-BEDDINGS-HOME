-- ============================================================================
-- 035: deduct_order_stock / restore_order_stock have never been callable
--
-- Both were declared with `p_order_id uuid`, but whatsapp_orders.id is TEXT
-- (short_id, e.g. '4e8c19f9'). Every call fails with
--     invalid input syntax for type uuid: "4e8c19f9"
-- and nalopay-callback wraps the call in a bare catch, so it has been failing
-- silently since it was written. Consequence: ONLINE ORDERS HAVE NEVER
-- DEDUCTED STOCK, so on-hand figures have been overstated by every web and
-- WhatsApp sale.
--
-- They also read `items` the same broken way as complete_wa_order did: for a
-- double-encoded string jsonb_typeof() returns 'string', which is not null, so
-- the raw string was handed to jsonb_array_elements(). Both now go through
-- wa_items().
--
-- NOT BACKFILLED ON PURPOSE. The goods for past online orders have already
-- left the shop and stock has since been corrected by stock takes; replaying
-- those deductions now would drive quantities negative and make the figures
-- worse, not better. This fixes it going forward. Use a stock take to true up.
-- ============================================================================

DROP FUNCTION IF EXISTS public.deduct_order_stock(uuid);
DROP FUNCTION IF EXISTS public.restore_order_stock(uuid);

CREATE OR REPLACE FUNCTION public.deduct_order_stock(p_order_id TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_order RECORD;
  v_items JSONB;
  v_item  JSONB;
  v_qty   INTEGER;
  v_pid   TEXT;
  v_n     INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM whatsapp_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;

  -- Idempotent: the callback and the reconcile job can both reach this.
  IF COALESCE(v_order.stock_deducted, false) THEN
    RETURN jsonb_build_object('success', true, 'note', 'already deducted');
  END IF;

  v_items := wa_items(v_order.items);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_qty := COALESCE((v_item->>'qty')::INTEGER, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    v_pid := v_item->>'productId';
    IF v_pid IS NULL OR NOT EXISTS (SELECT 1 FROM products WHERE id = v_pid) THEN
      SELECT id INTO v_pid FROM products
       WHERE lower(name) = lower(COALESCE(v_item->>'name', '')) LIMIT 1;
    END IF;
    IF v_pid IS NULL THEN CONTINUE; END IF;

    UPDATE products SET quantity = GREATEST(0, quantity - v_qty) WHERE id = v_pid;
    v_n := v_n + 1;
  END LOOP;

  UPDATE whatsapp_orders SET stock_deducted = true WHERE id = p_order_id;
  RETURN jsonb_build_object('success', true, 'lines_deducted', v_n);
EXCEPTION WHEN OTHERS THEN
  -- Surface it. A swallowed error here is what hid this for so long.
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_order_stock(p_order_id TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_order RECORD;
  v_items JSONB;
  v_item  JSONB;
  v_qty   INTEGER;
  v_pid   TEXT;
  v_n     INTEGER := 0;
BEGIN
  SELECT * INTO v_order FROM whatsapp_orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  IF NOT COALESCE(v_order.stock_deducted, false) THEN
    RETURN jsonb_build_object('success', true, 'note', 'nothing to restore');
  END IF;

  v_items := wa_items(v_order.items);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_qty := COALESCE((v_item->>'qty')::INTEGER, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_pid := v_item->>'productId';
    IF v_pid IS NULL OR NOT EXISTS (SELECT 1 FROM products WHERE id = v_pid) THEN
      SELECT id INTO v_pid FROM products
       WHERE lower(name) = lower(COALESCE(v_item->>'name', '')) LIMIT 1;
    END IF;
    IF v_pid IS NULL THEN CONTINUE; END IF;
    UPDATE products SET quantity = quantity + v_qty WHERE id = v_pid;
    v_n := v_n + 1;
  END LOOP;

  UPDATE whatsapp_orders SET stock_deducted = false WHERE id = p_order_id;
  RETURN jsonb_build_object('success', true, 'lines_restored', v_n);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.deduct_order_stock(TEXT)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_order_stock(TEXT) TO anon, authenticated;
