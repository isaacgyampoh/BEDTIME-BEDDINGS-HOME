-- ---------------------------------------------------------------------------
-- 047  The order total is worked out by the database, not sent by the browser.
--
-- public_order_create took `subtotal` and `total` straight from the request and
-- stored them. Anyone could post an order for a 450-cedi duvet with a total of
-- 1.00, and nothing downstream would notice: the payment prompt checks the
-- amount against the ORDER, and the order's figure came from the same request.
-- The receipt, the day's takings and the SMS report would all agree with each
-- other and all be wrong.
--
-- The prices are recomputed here from `products` and the live `promos`, using
-- exactly the rule the shop front shows a customer:
--   1. a live promotional price wins
--   2. otherwise the wholesale price, when the quantity ordered in that
--      product's CATEGORY reaches its wholesale minimum
--   3. otherwise the retail price
-- Dates are compared inclusively, the same as the till and the shop front.
--
-- If what the browser believed differs from what the goods actually cost, the
-- order is refused rather than quietly repriced — a customer must never be
-- charged something other than what they agreed to. Stock is checked at the
-- same moment, so an order cannot be placed for more than exists.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public_order_create(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  r          whatsapp_orders%ROWTYPE;
  v_items    JSONB;
  v_total    NUMERIC(10,2);
  v_claimed  NUMERIC(10,2);
  v_bad      TEXT;
BEGIN
  IF coalesce(trim(p->>'customer_name'), '') = ''
     OR coalesce(trim(p->>'customer_phone'), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Name and phone are required');
  END IF;

  -- The browser sends items as a JSON *string* inside the payload, so unwrap
  -- it when that is what arrived.
  v_items := CASE WHEN jsonb_typeof(p->'items') = 'string'
                  THEN (p->>'items')::jsonb ELSE p->'items' END;
  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'The order has no items');
  END IF;

  WITH lines AS (
    SELECT e->>'productId' AS pid,
           GREATEST(1, COALESCE((e->>'qty')::int, 1)) AS qty
      FROM jsonb_array_elements(v_items) e
  ),
  -- Every promotion running today, cheapest price per product.
  live_promo AS (
    SELECT it->>'productId' AS pid, MIN((it->>'promoPrice')::numeric) AS price
      FROM promos pr,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(pr.items) = 'string'
                  THEN (pr.items #>> '{}')::jsonb ELSE pr.items END) it
     WHERE pr.active IS TRUE
       AND (pr.start_date IS NULL OR pr.start_date <= CURRENT_DATE)
       AND (pr.end_date   IS NULL OR pr.end_date   >= CURRENT_DATE)
       AND COALESCE((it->>'promoPrice')::numeric, 0) > 0
     GROUP BY 1
  ),
  joined AS (
    SELECT l.pid, l.qty, pr.name, pr.category, pr.quantity AS stock,
           pr.price AS retail, pr.wholesale_price AS wp,
           COALESCE(pr.wholesale_min_qty, 0) AS wm, lp.price AS promo
      FROM lines l
      LEFT JOIN products pr ON pr.id = l.pid
      LEFT JOIN live_promo lp ON lp.pid = l.pid
  ),
  priced AS (
    SELECT j.*,
           -- The same order of precedence the customer was shown.
           COALESCE(
             j.promo,
             CASE WHEN j.wp > 0 AND j.wm > 0
                       AND SUM(j.qty) OVER (PARTITION BY j.category) >= j.wm
                  THEN j.wp END,
             j.retail
           ) AS unit
      FROM joined j
  )
  SELECT
    (SELECT string_agg(x, '; ') FROM (
        SELECT CASE
                 WHEN name IS NULL THEN 'One item is no longer sold'
                 WHEN qty > COALESCE(stock, 0) THEN name || ' has only ' || COALESCE(stock, 0) || ' left'
               END AS x
          FROM priced
         WHERE name IS NULL OR qty > COALESCE(stock, 0)
      ) bad),
    (SELECT ROUND(SUM(unit * qty), 2) FROM priced)
  INTO v_bad, v_total;

  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', v_bad);
  END IF;

  -- What the browser believed. A mismatch means the price moved between the
  -- cart and the order, so the customer is sent back to look rather than
  -- charged a figure they never saw.
  v_claimed := NULLIF(p->>'total', '')::numeric;
  IF v_claimed IS NOT NULL AND abs(v_claimed - v_total) > 0.01 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Prices have changed since these items went into the cart. Please check the order and try again.',
      'expected_total', v_total);
  END IF;

  INSERT INTO whatsapp_orders
    (order_no, date, customer_name, customer_phone, items, subtotal, total,
     address, notes, status, source, details_filled)
  VALUES
    (p->>'order_no', now(),
     left(trim(p->>'customer_name'), 120),
     left(trim(p->>'customer_phone'), 40),
     v_items,
     v_total, v_total,          -- both computed here; neither is taken on trust
     nullif(trim(coalesce(p->>'address', '')), ''),
     left(coalesce(p->>'notes', ''), 500),
     'Pending', 'web', true)
  RETURNING * INTO r;

  RETURN jsonb_build_object('success', true, 'id', r.id,
                            'ussd_code', r.ussd_code, 'order_no', r.order_no,
                            'total', v_total);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'public_order_create failed: % (%)', SQLERRM, SQLSTATE;
  RETURN jsonb_build_object('success', false, 'error', 'Could not place the order: ' || SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public_order_create(JSONB) FROM public;
GRANT EXECUTE ON FUNCTION public_order_create(JSONB) TO anon, authenticated;
