-- ============================================================================
-- 016: DATA INTEGRITY HARDENING
--
-- Run AFTER 015_security_hardening.sql, and before deploying the frontend that
-- goes with it. Idempotent — safe to re-run.
--
-- What this fixes
--   1. record_sale trusted the browser for price, costPrice and lineTotal.
--      The anon key is public, so anyone could post a sale at any price with
--      any profit and corrupt the financial record. Prices and costs are now
--      read from the database; a cart whose prices no longer match is
--      REJECTED rather than silently recorded at a different figure.
--   2. record_sale clamped stock with GREATEST(0, ...), so overselling
--      succeeded silently and stock drifted away from reality.
--   3. Restock / stock-take / adjustment screens all wrote
--      `cached_quantity ± n` read-modify-write, so a sale landing in between
--      was silently reverted. Replaced with one atomic delta function.
--   4. anon could DELETE products, expenses, bundles, promos and invoices
--      outright. Destructive deletes now require an admin PIN.
--   5. `sales` was freely UPDATE-able by anon — the books were rewritable.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Atomic stock movement. The only supported way to change quantity by a
--    delta, so two concurrent writers can never clobber each other.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION adjust_product_stock(p_product_id TEXT, p_delta INTEGER)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new INTEGER;
BEGIN
  UPDATE products
     SET quantity = GREATEST(0, quantity + p_delta)
   WHERE id = p_product_id
  RETURNING quantity INTO v_new;

  IF v_new IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Product not found');
  END IF;
  RETURN jsonb_build_object('success', true, 'quantity', v_new);
END;
$$;
GRANT EXECUTE ON FUNCTION adjust_product_stock(TEXT, INTEGER) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Authoritative unit price for a product, mirroring the POS screen exactly:
--    an active promo wins, then wholesale when the sale is a wholesale sale,
--    otherwise the retail price.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION product_effective_price(p_product_id TEXT, p_type TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prod  RECORD;
  v_promo NUMERIC;
BEGIN
  SELECT price, wholesale_price INTO v_prod FROM products WHERE id = p_product_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Lowest active promo price for this product, if any.
  SELECT MIN((it->>'promoPrice')::NUMERIC) INTO v_promo
    FROM promos pr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE jsonb_typeof(pr.items) WHEN 'array' THEN pr.items ELSE '[]'::jsonb END
    ) AS it
   WHERE pr.active = true
     -- start_date / end_date are DATE columns and may be NULL. The POS screen
     -- treats a missing bound as unbounded (`null > today` is false in JS), so
     -- mirror that exactly — otherwise a promo with no dates prices differently
     -- on the two sides and every sale of it gets rejected as "stale".
     AND COALESCE(pr.start_date, '-infinity'::date) <= CURRENT_DATE
     AND COALESCE(pr.end_date,    'infinity'::date) >= CURRENT_DATE
     AND it->>'productId' = p_product_id
     AND COALESCE((it->>'promoPrice')::NUMERIC, 0) > 0;

  IF v_promo IS NOT NULL AND v_promo > 0 THEN
    RETURN v_promo;
  END IF;

  IF p_type = 'Wholesale' AND COALESCE(v_prod.wholesale_price, 0) > 0 THEN
    RETURN v_prod.wholesale_price;
  END IF;

  RETURN v_prod.price;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. record_sale — prices and costs come from the database, stock is checked
--    before anything is written, and the whole thing is one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_sale(
  p_items      JSONB,
  p_customer   TEXT,
  p_payment    TEXT,
  p_discount   NUMERIC,
  p_type       TEXT,
  p_cashier    TEXT,
  p_split_cash NUMERIC DEFAULT 0,
  p_split_momo NUMERIC DEFAULT 0
) RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id           TEXT;
  v_receipt      TEXT;
  v_subtotal     NUMERIC := 0;
  v_profit       NUMERIC := 0;
  v_total        NUMERIC;
  v_client_total NUMERIC := 0;
  v_discount     NUMERIC;
  v_item         JSONB;
  v_bi           JSONB;
  v_qty          INTEGER;
  v_need         INTEGER;
  v_have         INTEGER;
  v_unit         NUMERIC;
  v_cost         NUMERIC;
  v_name         TEXT;
  v_priced       JSONB := '[]'::JSONB;
  v_needs        JSONB := '{}'::JSONB;
  v_pid          TEXT;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', 'Cart is empty');
  END IF;

  -- A negative discount would have inflated the total above subtotal.
  v_discount := GREATEST(0, COALESCE(p_discount, 0));

  -- ---- Pass 1: authoritative pricing, and tally what stock is required -----
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'qty')::INTEGER, 0);
    IF v_qty <= 0 THEN
      RETURN json_build_object('success', false, 'error', 'Invalid quantity in cart');
    END IF;

    v_client_total := v_client_total + COALESCE((v_item->>'lineTotal')::NUMERIC, 0);

    IF (v_item->>'isBundle')::BOOLEAN IS TRUE THEN
      SELECT name, bundle_price INTO v_name, v_unit
        FROM bundles WHERE id = v_item->>'bundleId' AND active = true;
      IF v_unit IS NULL THEN
        RETURN json_build_object('success', false, 'error',
          'Bundle "' || COALESCE(v_item->>'name','?') || '" is no longer available');
      END IF;

      -- Tally the stock each component needs for this many bundles.
      FOR v_bi IN SELECT * FROM jsonb_array_elements(
                    CASE jsonb_typeof(v_item->'bundleItems') WHEN 'array' THEN v_item->'bundleItems' ELSE '[]'::jsonb END) LOOP
        v_pid  := v_bi->>'productId';
        v_need := COALESCE((v_bi->>'qty')::INTEGER, 0) * v_qty;
        v_needs := jsonb_set(v_needs, ARRAY[v_pid],
                     to_jsonb(COALESCE((v_needs->>v_pid)::INTEGER, 0) + v_need));
      END LOOP;

      -- Unit cost of one bundle = sum of its components' cost prices.
      SELECT COALESCE(SUM(pr.cost_price * COALESCE((bi->>'qty')::NUMERIC, 0)), 0) INTO v_cost
        FROM jsonb_array_elements(
               CASE jsonb_typeof(v_item->'bundleItems') WHEN 'array' THEN v_item->'bundleItems' ELSE '[]'::jsonb END) bi
        JOIN products pr ON pr.id = bi->>'productId';
    ELSE
      v_pid := v_item->>'productId';
      IF v_pid IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Cart line has no product');
      END IF;

      SELECT name, cost_price INTO v_name, v_cost FROM products WHERE id = v_pid;
      IF v_name IS NULL THEN
        RETURN json_build_object('success', false, 'error',
          'Product "' || COALESCE(v_item->>'name','?') || '" no longer exists');
      END IF;

      v_unit := product_effective_price(v_pid, p_type);
      v_needs := jsonb_set(v_needs, ARRAY[v_pid],
                   to_jsonb(COALESCE((v_needs->>v_pid)::INTEGER, 0) + v_qty));
    END IF;

    v_subtotal := v_subtotal + (v_unit * v_qty);
    v_profit   := v_profit   + ((v_unit - COALESCE(v_cost, 0)) * v_qty);

    -- Store the line with the price the DATABASE says, not the browser.
    v_priced := v_priced || jsonb_build_array(
      v_item
      || jsonb_build_object('name', COALESCE(v_name, v_item->>'name'),
                            'price', v_unit,
                            'costPrice', COALESCE(v_cost, 0),
                            'lineTotal', v_unit * v_qty));
  END LOOP;

  -- ---- Refuse to charge a figure other than the one the cashier saw --------
  IF ABS(v_client_total - v_subtotal) > 0.01 THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Prices changed since these items were added. Clear the cart and add them again.',
      'expected', v_subtotal, 'submitted', v_client_total);
  END IF;

  -- ---- Stock check BEFORE writing anything --------------------------------
  FOR v_pid IN SELECT jsonb_object_keys(v_needs) LOOP
    v_need := (v_needs->>v_pid)::INTEGER;
    SELECT quantity, name INTO v_have, v_name FROM products WHERE id = v_pid FOR UPDATE;
    IF v_have IS NULL OR v_have < v_need THEN
      RETURN json_build_object('success', false, 'error',
        'Not enough stock for "' || COALESCE(v_name, v_pid) || '" — ' ||
        COALESCE(v_have, 0)::text || ' left, ' || v_need::text || ' needed');
    END IF;
  END LOOP;

  v_discount := LEAST(v_discount, v_subtotal);   -- never below zero
  v_total    := v_subtotal - v_discount;
  v_id       := short_id();
  v_receipt  := generate_receipt_no();

  INSERT INTO sales (id, receipt_no, date, items, subtotal, discount, total, profit,
                     payment, split_cash, split_momo, customer, type, cashier, voided)
  VALUES (v_id, v_receipt, now(), v_priced, v_subtotal, v_discount, v_total, v_profit,
          p_payment, COALESCE(p_split_cash,0), COALESCE(p_split_momo,0),
          p_customer, p_type, p_cashier, false);

  -- ---- Deduct (rows already locked by the check above) --------------------
  FOR v_pid IN SELECT jsonb_object_keys(v_needs) LOOP
    UPDATE products SET quantity = quantity - (v_needs->>v_pid)::INTEGER WHERE id = v_pid;
  END LOOP;

  IF p_customer IS NOT NULL AND p_customer <> 'Walk-in' AND p_customer <> '' THEN
    INSERT INTO customers (phone, visit_count, total_spent, last_visit)
    VALUES (p_customer, 1, v_total, now())
    ON CONFLICT (phone) DO UPDATE SET
      visit_count = customers.visit_count + 1,
      total_spent = customers.total_spent + v_total,
      last_visit  = now();
  END IF;

  RETURN json_build_object('success', true, 'receiptNo', v_receipt, 'saleId', v_id,
                           'subtotal', v_subtotal, 'discount', v_discount,
                           'total', v_total, 'profit', v_profit, 'date', now());
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION record_sale(JSONB,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Destructive deletes require an admin PIN.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_delete_row(p_admin_pin TEXT, p_table TEXT, p_id TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_admin_pin(p_admin_pin) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin PIN is incorrect');
  END IF;
  -- Fixed allowlist: p_table is never interpolated from arbitrary input.
  IF p_table NOT IN ('products', 'expenses', 'bundles', 'promos', 'invoices') THEN
    RETURN jsonb_build_object('success', false, 'error', 'That table cannot be deleted from');
  END IF;
  EXECUTE format('DELETE FROM %I WHERE id = $1', p_table) USING p_id;
  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION admin_delete_row(TEXT, TEXT, TEXT) TO anon, authenticated;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','expenses','bundles','promos','invoices'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_all', t);
    -- Re-grant everything except DELETE for the tables that used a FOR ALL policy.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_rw', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO anon, authenticated USING (true)', t || '_sel', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO anon, authenticated WITH CHECK (true)', t || '_ins', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO anon, authenticated USING (true)', t || '_upd', t);
    EXECUTE format('REVOKE DELETE ON %I FROM anon, authenticated', t);
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'delete lockdown: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 5. The books are append-only. Voiding goes through void_sale, which leaves
--    the original row intact and flagged.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "sales_update" ON sales;
REVOKE UPDATE, DELETE ON sales FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION void_sale(TEXT) TO anon, authenticated;

-- record_sale is SECURITY DEFINER, so it still writes sales despite the above.
-- The split_cash / split_momo follow-up UPDATE the client used to make is now
-- unnecessary: record_sale takes both as parameters.

-- These legitimately write sales/products and were running as the CALLER, so
-- the revoke above would have broken them. Promote them to SECURITY DEFINER
-- (with a pinned search_path) so they keep working and remain the ONLY route
-- by which the books can change.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'void_sale(text)',
    'process_refund(text, jsonb, text, text, text)',
    'complete_wa_order(text, text)',
    'deduct_order_stock(uuid)',
    'restore_order_stock(uuid)'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER', fn);
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', fn);
      RAISE NOTICE 'promoted % to SECURITY DEFINER', fn;
    EXCEPTION WHEN undefined_function THEN
      RAISE NOTICE 'skipped % (not present)', fn;
    END;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Verification
-- ---------------------------------------------------------------------------
SELECT has_table_privilege('anon','products','DELETE') AS anon_delete_products_should_be_false,
       has_table_privilege('anon','sales','UPDATE')    AS anon_update_sales_should_be_false,
       has_table_privilege('anon','sales','SELECT')    AS anon_read_sales_should_be_true;
