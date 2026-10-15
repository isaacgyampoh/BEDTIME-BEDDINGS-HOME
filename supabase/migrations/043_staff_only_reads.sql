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
