-- ---------------------------------------------------------------------------
-- 042  Remove anon privileges that nothing in the application uses.
--
-- The whole system talks to PostgREST as `anon` — the admin portal included,
-- because staff sign in with a PIN held in the client and there is no Supabase
-- Auth session. So every grant `anon` holds is a grant the public holds: the
-- key is in the JavaScript bundle served from www.bedtimehome.com.
--
-- That is the real problem and it is not fixed here; it needs authentication.
-- What IS fixed here is the surface that no code path needs, so the public
-- cannot use it either.
--
-- Verified before writing this:
--   * no .insert()/.update()/.upsert() on `sales` anywhere in src/,
--     storefront/src/ or supabase/functions/ — every sale goes through
--     record_sale(), and every void through void_sale()
--   * no .delete() on `customers` or `whatsapp_orders` anywhere; destructive
--     deletes go through admin_delete_row(), which takes an admin PIN
--
-- record_sale() and void_sale() are SECURITY DEFINER and owned by the role
-- that owns `sales`, so they still insert and update it after the revoke:
-- SECURITY DEFINER runs with the owner's privileges, and a table's owner is
-- not subject to its RLS policies unless FORCE ROW LEVEL SECURITY is set.
-- Taking the grant away therefore closes direct writes without touching
-- checkout.
-- ---------------------------------------------------------------------------

-- 1. The books are append-only through record_sale. Nothing should be able to
--    post a sale by hand — a forged INSERT here would show up in the day's
--    takings and in the SMS report.
DROP POLICY IF EXISTS "sales_insert" ON sales;
REVOKE INSERT ON sales FROM anon, authenticated;

-- 2. 016 already revoked these, but make it explicit for the two tables that
--    hold customer personal data, so a future CREATE POLICY cannot quietly
--    re-open them.
REVOKE DELETE ON customers FROM anon, authenticated;
REVOKE DELETE ON whatsapp_orders FROM anon, authenticated;

-- Deliberately NOT revoked: social_posts. It looks like an admin-only table,
-- but src/lib/social.js inserts and updates it straight from the browser as
-- anon, so revoking would break scheduling a post. It can only be closed once
-- staff have a real session. Same for products, expenses and whatsapp_orders
-- UPDATE: the admin needs them, and the admin is anon.
