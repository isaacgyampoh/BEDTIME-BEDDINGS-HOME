-- ============================================================================
-- 021: Product price history (forward-only)
--
-- The "price reduced from X to Y" promotion needs a real previous price.
-- Nothing recorded one, and inventing a prior price for existing products
-- would put a false claim in front of customers. This starts recording from
-- now, so price-change promos work for changes made after this migration and
-- are simply unavailable before it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_price_history (
  id                  BIGSERIAL PRIMARY KEY,
  product_id          TEXT NOT NULL,
  old_price           NUMERIC(10,2),
  new_price           NUMERIC(10,2),
  old_wholesale_price NUMERIC(10,2),
  new_wholesale_price NUMERIC(10,2),
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_hist_product ON product_price_history (product_id, changed_at DESC);

ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_hist_sel ON product_price_history;
CREATE POLICY price_hist_sel ON product_price_history
  FOR SELECT TO anon, authenticated USING (true);
-- Written only by the trigger below; never directly by the app.
REVOKE INSERT, UPDATE, DELETE ON product_price_history FROM anon, authenticated;

CREATE OR REPLACE FUNCTION log_price_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.price IS DISTINCT FROM OLD.price
     OR NEW.wholesale_price IS DISTINCT FROM OLD.wholesale_price THEN
    INSERT INTO product_price_history
      (product_id, old_price, new_price, old_wholesale_price, new_wholesale_price)
    VALUES (OLD.id, OLD.price, NEW.price, OLD.wholesale_price, NEW.wholesale_price);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_price_change ON products;
CREATE TRIGGER trg_log_price_change
  AFTER UPDATE OF price, wholesale_price ON products
  FOR EACH ROW EXECUTE FUNCTION log_price_change();

SELECT 'price history armed' AS status;
