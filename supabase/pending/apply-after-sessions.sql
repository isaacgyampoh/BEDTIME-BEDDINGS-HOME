-- ===========================================================================
--  APPLY AFTER STAFF SESSIONS ARE PROVEN  —  not before
--
--  PRECONDITION, in this order:
--    1. the `super-service` Edge Function is deployed (it adds
--       ?action=staff-login, which is what mints a real session)
--    2. a staff member signs in with their PIN on a real device at
--       https://admin.bedtimehome.com and the portal loads normally
--    3. only then run this file
--
--  Run before step 2 succeeds, every admin screen goes blank: the portal would
--  still be arriving as `anon` with its reads taken away. The shop front is
--  unaffected either way — products, bundles, promos and store_settings stay
--  readable without a session, because it is a shop.
--
--  Contents, in dependency order (044 creates public_order_create, 047
--  replaces it, so they cannot be reordered):
--    043  sales, customers, expenses, product writes and social posts become
--         staff-only. This is the fix for the exposure: today the key in the
--         JavaScript bundle can read 400 sales rows with the profit on each,
--         348 customer phone numbers, and the expense ledger.
--    044  closes whatsapp_orders and replaces it with six functions scoped to
--         one order id. The pages customers open already call these and fall
--         back to the direct query, so they keep working across the change.
--    047  the order total is recomputed from products and live promos instead
--         of being taken from the browser.
--
--  One transaction: if any statement fails, nothing is kept.
-- ===========================================================================

BEGIN;


-- ─── 043_staff_only_reads.sql ──────────────────────────────────────────────

-- ---------------------------------------------------------------------------
-- 043  Move the business tables from `anon` to `authenticated`.
--
--   DO NOT APPLY THIS UNTIL STAFF SESSIONS ARE PROVEN WORKING.
--   Order of operations:
--     1. supabase functions deploy super-service      (adds ?action=staff-login)
--     2. deploy the web app                            (Login.jsx exchanges the
--                                                       PIN for a session)
--     3. sign in on a real device, confirm the portal still loads
--     4. only then: supabase db push
--   Applied before step 3, every admin screen goes blank, because the portal
--   would still be arriving as `anon` with the reads taken away.
--
-- WHY
-- The admin portal and the public shop both reach PostgREST as `anon`, using
-- the key that ships inside the JavaScript bundle. Verified against production
-- with that key alone: 400 sales rows including the profit on each, 348
-- customer phone numbers with spend history, and the expense ledger were all
-- readable by anyone. Nothing was misconfigured — `USING (true)` for `anon` is
-- exactly what 004 asked for, back when there was no way to tell staff apart.
-- staff-login gives the browser a genuine session, which is what makes
-- `TO authenticated` mean something.
--
-- SCOPE
-- Only tables that no anonymous page touches. Confirmed by reading every
-- PostgREST call in storefront/src, src/pages/InvoicePay.jsx and
-- src/pages/DeliveryConfirm.jsx: between them they use products, bundles,
-- promos, store_settings and whatsapp_orders, and nothing else.
--
-- whatsapp_orders is deliberately NOT included here — 044 closes it, once the
-- pages customers open (invoice payment, delivery confirmation, checkout and
-- tracking) have been moved behind functions scoped to a single order id.
-- Apply 044 after this one, and after the deploy that uses those functions.
--
-- record_sale() and void_sale() are SECURITY DEFINER and owned by the table
-- owner, so they keep writing sales and customers regardless of what anon and
-- authenticated hold here.
-- ---------------------------------------------------------------------------

-- Sales: read is staff-only. Insert already went through record_sale (042).
DROP POLICY IF EXISTS "sales_select" ON sales;
CREATE POLICY "sales_select" ON sales
  FOR SELECT TO authenticated USING (true);

-- Customers: personal data. record_sale maintains the rows.
DROP POLICY IF EXISTS "customers_select" ON customers;
DROP POLICY IF EXISTS "customers_insert" ON customers;
DROP POLICY IF EXISTS "customers_update" ON customers;
CREATE POLICY "customers_select" ON customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "customers_insert" ON customers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "customers_update" ON customers FOR UPDATE TO authenticated USING (true);

-- Expenses: the books.
DROP POLICY IF EXISTS "expenses_select" ON expenses;
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
DROP POLICY IF EXISTS "expenses_update" ON expenses;
DROP POLICY IF EXISTS "expenses_delete" ON expenses;
CREATE POLICY "expenses_select" ON expenses FOR SELECT TO authenticated USING (true);
CREATE POLICY "expenses_insert" ON expenses FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "expenses_update" ON expenses FOR UPDATE TO authenticated USING (true);

-- Products: the shop must still read the catalogue, but only staff may change
-- prices. Anyone could rewrite a price before this.
DROP POLICY IF EXISTS "products_insert" ON products;
DROP POLICY IF EXISTS "products_update" ON products;
DROP POLICY IF EXISTS "products_delete" ON products;
CREATE POLICY "products_insert" ON products FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "products_update" ON products FOR UPDATE TO authenticated USING (true);
-- products_select stays open to anon: it is a shop.

-- Social posts: drafts, captions and stock levels. Admin surface only.
DROP POLICY IF EXISTS social_posts_sel ON social_posts;
DROP POLICY IF EXISTS social_posts_ins ON social_posts;
DROP POLICY IF EXISTS social_posts_upd ON social_posts;
CREATE POLICY social_posts_sel ON social_posts FOR SELECT TO authenticated USING (true);
CREATE POLICY social_posts_ins ON social_posts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY social_posts_upd ON social_posts FOR UPDATE TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- The policies 016 created in a loop, which the drops above miss entirely.
--
-- 016 (line 280) ran
--     FOREACH t IN ARRAY ARRAY['products','expenses','bundles','promos','invoices']
--        CREATE POLICY <t>_sel ON <t> FOR SELECT TO anon, authenticated USING (true)
--        CREATE POLICY <t>_ins ...  CREATE POLICY <t>_upd ...
-- so each of those five tables carries a SECOND set of policies under short
-- names. Permissive policies combine with OR, so dropping only
-- `expenses_select` and creating `expenses_select TO authenticated` leaves
-- `expenses_sel TO anon` standing and the expense ledger just as readable as
-- before. Verified by replaying 001-041 into a local database: products and
-- expenses each end up with six policies, not three.
--
-- promos matters most. 047 prices every web order from the live `promos` rows.
-- With `promos_ins` open to anon, anyone could insert a promotion setting a
-- 450-cedi duvet to 1 cedi, and 047 would price the order at 1 cedi and agree
-- with itself all the way to the receipt and the day's takings.
--
-- bundles and promos keep SELECT open to anon: the shop front renders both.
-- invoices are supplier records and only InvoicesPage.jsx touches them.
-- ---------------------------------------------------------------------------

-- Expenses: close the duplicate set too, or nothing above took effect.
DROP POLICY IF EXISTS expenses_sel ON expenses;
DROP POLICY IF EXISTS expenses_ins ON expenses;
DROP POLICY IF EXISTS expenses_upd ON expenses;

-- Products: writes become staff-only. Exactly one SELECT policy is left, open,
-- so the catalogue keeps loading for a shopper with no session.
DROP POLICY IF EXISTS products_ins ON products;
DROP POLICY IF EXISTS products_upd ON products;
DROP POLICY IF EXISTS products_sel ON products;
DROP POLICY IF EXISTS products_select ON products;
CREATE POLICY products_select ON products FOR SELECT TO anon, authenticated USING (true);

-- Bundles and promos: read by the shop, written only by staff.
DROP POLICY IF EXISTS bundles_ins    ON bundles;
DROP POLICY IF EXISTS bundles_upd    ON bundles;
DROP POLICY IF EXISTS bundles_insert ON bundles;
DROP POLICY IF EXISTS bundles_update ON bundles;
CREATE POLICY bundles_insert ON bundles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY bundles_update ON bundles FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS promos_ins    ON promos;
DROP POLICY IF EXISTS promos_upd    ON promos;
DROP POLICY IF EXISTS promos_insert ON promos;
DROP POLICY IF EXISTS promos_update ON promos;
CREATE POLICY promos_insert ON promos FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY promos_update ON promos FOR UPDATE TO authenticated USING (true);

-- Invoices: supplier records, admin surface only.
DROP POLICY IF EXISTS invoices_sel    ON invoices;
DROP POLICY IF EXISTS invoices_ins    ON invoices;
DROP POLICY IF EXISTS invoices_upd    ON invoices;
DROP POLICY IF EXISTS invoices_select ON invoices;
DROP POLICY IF EXISTS invoices_insert ON invoices;
DROP POLICY IF EXISTS invoices_update ON invoices;
CREATE POLICY invoices_select ON invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY invoices_insert ON invoices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY invoices_update ON invoices FOR UPDATE TO authenticated USING (true);


-- ─── 044_public_order_functions.sql ────────────────────────────────────────

-- ---------------------------------------------------------------------------
-- 044  Close whatsapp_orders to the public, without breaking the pages
--      customers actually open.
--
--   APPLY AFTER 043, AND AFTER THE STOREFRONT + PORTAL DEPLOY THAT USES THESE.
--   The clients call these functions first and fall back to the old direct
--   queries if the function is missing, so deploying the code early is safe.
--   Applying this before that deploy is not: ordering, paying and confirming
--   delivery all read the table directly today.
--
-- WHY
-- 043 left this table open because three pages reach it with no session: the
-- invoice payment page, the delivery confirmation page, and the shop's own
-- checkout and tracking. Anyone with the public key could therefore list all
-- 40 orders — names, phone numbers, home addresses.
--
-- Each of those pages only ever needs ONE order, and it already knows which:
-- the id is in the link. So the access moves from "anon may read the table" to
-- "anon may ask about the order whose id it already holds".
--
-- Worth being exact about how strong that is. `id` is TEXT, not a uuid —
-- 001 defaults it to short_id(), the first 8 hex characters of a v4 uuid, so
-- about 4.3 billion values. That is not a password-grade secret: it is one
-- order per correct guess, over HTTPS, against Supabase's rate limits, instead
-- of the whole table in a single request. The remaining exposure is one
-- guessed order, not 40 of them, and closing it further means changing the id
-- of every order and every link already sent to a customer.
--
-- Every function below is SECURITY DEFINER with a pinned search_path, returns
-- only the columns the page renders, and refuses to touch `status` except
-- where a payment has already been confirmed by the signed webhook.
-- ---------------------------------------------------------------------------

-- 0. Two columns this function writes exist in production but are created by no
--    migration in this repository: `source` and `details_filled` were added
--    straight to the database. Ten places in the application read or write
--    them, so production has them; a database rebuilt from this history does
--    not, and public_order_create fails with
--      column "source" of relation "whatsapp_orders" does not exist
--    Found by replaying 001-041 locally and calling the function. IF NOT
--    EXISTS makes this a no-op against production and a repair anywhere else.
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS source         TEXT;
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS details_filled BOOLEAN DEFAULT false;

-- 1. Place an order. Returns only what checkout needs. Previously an INSERT
--    ... .select('id,ussd_code'), which required SELECT on the whole table.
CREATE OR REPLACE FUNCTION public_order_create(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE r whatsapp_orders%ROWTYPE;
BEGIN
  IF coalesce(trim(p->>'customer_name'), '') = ''
     OR coalesce(trim(p->>'customer_phone'), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Name and phone are required');
  END IF;

  INSERT INTO whatsapp_orders
    (order_no, date, customer_name, customer_phone, items, subtotal, total,
     address, notes, status, source, details_filled)
  VALUES
    (p->>'order_no', now(),
     left(trim(p->>'customer_name'), 120),
     left(trim(p->>'customer_phone'), 40),
     -- `p->` not `p->>`: items is JSONB, and ->> would hand it TEXT, which
     -- Postgres will not assign to a jsonb column. The client sends
     -- JSON.stringify(items), so this stores a JSON *string* — the same
     -- double-encoded shape every existing consumer already decodes.
     p->'items',
     (p->>'subtotal')::NUMERIC,
     (p->>'total')::NUMERIC,
     nullif(trim(coalesce(p->>'address', '')), ''),
     left(coalesce(p->>'notes', ''), 500),
     'Pending', 'web', true)
  RETURNING * INTO r;

  RETURN jsonb_build_object('success', true, 'id', r.id,
                            'ussd_code', r.ussd_code, 'order_no', r.order_no);
END;
$$;

-- 2. Read one order by its id. The pay page and the delivery page both render
--    this; the shop's success screen polls it for `status`.
CREATE OR REPLACE FUNCTION public_order_get(p_id TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT to_jsonb(x) FROM (
    SELECT id, order_no, date, customer_name, customer_phone, items, subtotal,
           delivery_fee, total, address, notes, status, paid_at, ussd_code,
           tracking_no, delivery_status, delivery_guy, delivered_at
      FROM whatsapp_orders WHERE id = p_id
  ) x;
$$;

-- 3. The customer filling in their delivery details on the invoice page.
--    Refused once the order is settled, so a stale link cannot rewrite the
--    address of an order already out for delivery.
CREATE OR REPLACE FUNCTION public_order_save_details(
  p_id TEXT, p_name TEXT, p_phone TEXT, p_address TEXT, p_notes TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM whatsapp_orders WHERE id = p_id;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  IF v_status IN ('Completed', 'Cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'This order is closed');
  END IF;

  UPDATE whatsapp_orders
     SET customer_name  = left(trim(coalesce(p_name, customer_name)), 120),
         customer_phone = left(trim(coalesce(p_phone, customer_phone)), 40),
         address        = nullif(left(trim(coalesce(p_address, '')), 300), ''),
         notes          = left(coalesce(p_notes, ''), 500),
         details_filled = true
   WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 4. Record which gateway reference came back. Deliberately cannot set
--    `status` — that belongs to the signed webhook and the reconcile job, or
--    anyone could mark an order Paid with ?reference=anything in the URL.
CREATE OR REPLACE FUNCTION public_order_set_ref(p_id TEXT, p_ref TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF coalesce(trim(p_ref), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reference required');
  END IF;
  UPDATE whatsapp_orders SET paystack_ref = left(trim(p_ref), 120) WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 5. The delivery person confirming a drop. The "only advance status when the
--    money already landed" rule used to live in the browser, where the page
--    that enforced it was the page anyone could open. It is enforced here now.
CREATE OR REPLACE FUNCTION public_order_confirm_delivery(
  p_id TEXT, p_guy TEXT, p_notes TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE r whatsapp_orders%ROWTYPE; v_paid BOOLEAN;
BEGIN
  IF coalesce(trim(p_guy), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Name required');
  END IF;
  SELECT * INTO r FROM whatsapp_orders WHERE id = p_id;
  IF r.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Order not found');
  END IF;
  IF r.delivery_status = 'Delivered' THEN
    RETURN jsonb_build_object('success', true, 'already', true);
  END IF;

  v_paid := (r.status IN ('Paid', 'Completed')) OR (r.paid_at IS NOT NULL);

  UPDATE whatsapp_orders
     SET delivery_status = 'Delivered',
         delivery_guy    = left(trim(p_guy), 120),
         delivered_at    = now(),
         delivery_notes  = left(coalesce(p_notes, ''), 500),
         status          = CASE WHEN v_paid THEN 'Completed' ELSE status END
   WHERE id = p_id;

  RETURN jsonb_build_object('success', true, 'paid', v_paid);
END;
$$;

-- 6. Order tracking. The old query was
--       .or(`customer_phone.ilike.%q%,order_no.ilike.%q%`)
--    so a single character matched every order in the table. Exact match on
--    the order number, or on the phone with Ghanaian prefixes normalised, and
--    a length floor so a short string cannot be used to sweep the table.
CREATE OR REPLACE FUNCTION public_order_track(p_query TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  WITH q AS (
    SELECT trim(coalesce(p_query, '')) AS raw,
           regexp_replace(trim(coalesce(p_query, '')), '\D', '', 'g') AS digits
  ), norm AS (
    SELECT raw, digits,
           CASE WHEN digits LIKE '233%' THEN '0' || substr(digits, 4)
                WHEN length(digits) = 9  THEN '0' || digits
                ELSE digits END AS local_phone
      FROM q
  )
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM (
    SELECT o.order_no, o.status, o.total, o.customer_name, o.tracking_no,
           o.delivery_status, o.delivery_guy, o.delivered_at, o.date
      FROM whatsapp_orders o, norm n
     WHERE length(n.raw) >= 6
       AND ( upper(o.order_no) = upper(n.raw)
             OR upper(o.tracking_no) = upper(n.raw)
             OR regexp_replace(o.customer_phone, '\D', '', 'g')
                = regexp_replace(n.local_phone, '\D', '', 'g') )
     ORDER BY o.date DESC
     LIMIT 20
  ) x;
$$;

REVOKE ALL ON FUNCTION public_order_create(JSONB) FROM public;
REVOKE ALL ON FUNCTION public_order_get(TEXT) FROM public;
REVOKE ALL ON FUNCTION public_order_save_details(TEXT, TEXT, TEXT, TEXT, TEXT) FROM public;
REVOKE ALL ON FUNCTION public_order_set_ref(TEXT, TEXT) FROM public;
REVOKE ALL ON FUNCTION public_order_confirm_delivery(TEXT, TEXT, TEXT) FROM public;
REVOKE ALL ON FUNCTION public_order_track(TEXT) FROM public;

GRANT EXECUTE ON FUNCTION public_order_create(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_get(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_save_details(TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_set_ref(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_confirm_delivery(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_track(TEXT) TO anon, authenticated;

-- Now the table itself closes. Staff keep full access through their session;
-- the public keeps exactly the six doors above.
DROP POLICY IF EXISTS "wa_select" ON whatsapp_orders;
DROP POLICY IF EXISTS "wa_insert" ON whatsapp_orders;
DROP POLICY IF EXISTS "wa_update" ON whatsapp_orders;
CREATE POLICY "wa_select" ON whatsapp_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "wa_insert" ON whatsapp_orders FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "wa_update" ON whatsapp_orders FOR UPDATE TO authenticated USING (true);


-- ─── 047_order_total_computed_server_side.sql ──────────────────────────────

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

COMMIT;
