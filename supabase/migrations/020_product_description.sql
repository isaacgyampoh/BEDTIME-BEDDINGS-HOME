-- ============================================================================
-- 020: Optional product description
--
-- Products carry no description today, so promotional copy has nothing
-- product-specific to work from. Nullable and additive: all 342 existing rows
-- keep working untouched, and every read path already selects columns
-- explicitly, so nothing sees this until it is asked for.
-- ============================================================================
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;

SELECT count(*) AS products_total,
       count(description) AS with_description
  FROM products;
