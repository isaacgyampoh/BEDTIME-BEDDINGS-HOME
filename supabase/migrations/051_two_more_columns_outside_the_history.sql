-- ---------------------------------------------------------------------------
-- 051  Two more columns production has that no migration here creates.
--
-- 048 did this for wa_conversations, whatsapp_orders and promos. It found
-- those by comparing every column the APPLICATION selects, filters or orders
-- by against a schema rebuilt from 001-047. That method cannot see a column
-- only ever touched inside a SQL function, and it missed both of these.
--
-- Found instead by rebuilding the schema into an empty PostgreSQL, loading
-- the real production rows into it, and reading the columns that arrived with
-- no home to go to.
--
-- Against production both statements are a no-op: the columns are already
-- there. They matter only on the day this repository has to rebuild the
-- database, which is the day it would matter most.
--
-- 1. products.group_tag
--    src/hooks/useStore.js:279 names it in the products select:
--      select: 'id,name,category,cost_price,...,image,group_tag,description'
--    PostgREST rejects the whole request when a selected column does not
--    exist, so a rebuilt database would not fail to group products — the till
--    would load NO PRODUCTS AT ALL and read as an empty shop. It is also what
--    src/lib/promoBuilder.js groups a promotion's products by.
--
-- 2. whatsapp_orders.stock_deducted
--    Migration 035 both reads and writes it, in the two functions that move
--    stock when a web order is processed or reversed:
--      035:46   IF COALESCE(v_order.stock_deducted, false) THEN
--      035:67   UPDATE whatsapp_orders SET stock_deducted = true  WHERE id = ...
--      035:112  UPDATE whatsapp_orders SET stock_deducted = false WHERE id = ...
--    and src/components/CartDrawer.jsx:239 sets it on a walk-in order,
--    because POS stock is already deducted by record_sale. Without the
--    column, deduct_order_stock raises on its first statement: stock would
--    stop being deducted when an order is processed, or be deducted twice if
--    the guard were removed. That is an inventory-correctness fault, and a
--    silent one.
-- ---------------------------------------------------------------------------

-- Lower-cased and trimmed by the application on read, so plain TEXT is right.
ALTER TABLE products ADD COLUMN IF NOT EXISTS group_tag TEXT;

-- Products on offer together are looked up by this tag.
CREATE INDEX IF NOT EXISTS products_group_tag_idx ON products (group_tag)
 WHERE group_tag IS NOT NULL AND group_tag <> '';

-- NOT NULL with a default of false: every existing row has had its stock
-- handled one way or the other already, and false is what the guard in 035
-- treats as "not yet deducted" — which is the safe side, because a second
-- deduction is caught by the guard whereas a missed one is not.
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS stock_deducted BOOLEAN NOT NULL DEFAULT false;
