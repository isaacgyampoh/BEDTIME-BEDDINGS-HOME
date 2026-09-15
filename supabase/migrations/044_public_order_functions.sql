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
-- the id is a v4 UUID in the link, which is unguessable, exactly like a
-- password-reset link. So the access moves from "anon may read the table" to
-- "anon may ask about the order whose id it already holds".
--
-- Every function below is SECURITY DEFINER with a pinned search_path, returns
-- only the columns the page renders, and refuses to touch `status` except
-- where a payment has already been confirmed by the signed webhook.
-- ---------------------------------------------------------------------------

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
CREATE OR REPLACE FUNCTION public_order_get(p_id UUID)
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
  p_id UUID, p_name TEXT, p_phone TEXT, p_address TEXT, p_notes TEXT)
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
CREATE OR REPLACE FUNCTION public_order_set_ref(p_id UUID, p_ref TEXT)
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
  p_id UUID, p_guy TEXT, p_notes TEXT)
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
REVOKE ALL ON FUNCTION public_order_get(UUID) FROM public;
REVOKE ALL ON FUNCTION public_order_save_details(UUID, TEXT, TEXT, TEXT, TEXT) FROM public;
REVOKE ALL ON FUNCTION public_order_set_ref(UUID, TEXT) FROM public;
REVOKE ALL ON FUNCTION public_order_confirm_delivery(UUID, TEXT, TEXT) FROM public;
REVOKE ALL ON FUNCTION public_order_track(TEXT) FROM public;

GRANT EXECUTE ON FUNCTION public_order_create(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_get(UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_save_details(UUID, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_set_ref(UUID, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_confirm_delivery(UUID, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public_order_track(TEXT) TO anon, authenticated;

-- Now the table itself closes. Staff keep full access through their session;
-- the public keeps exactly the six doors above.
DROP POLICY IF EXISTS "wa_select" ON whatsapp_orders;
DROP POLICY IF EXISTS "wa_insert" ON whatsapp_orders;
DROP POLICY IF EXISTS "wa_update" ON whatsapp_orders;
CREATE POLICY "wa_select" ON whatsapp_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "wa_insert" ON whatsapp_orders FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "wa_update" ON whatsapp_orders FOR UPDATE TO authenticated USING (true);
