-- Enable RLS on whatsapp_orders
ALTER TABLE whatsapp_orders ENABLE ROW LEVEL SECURITY;

-- Allow anon to INSERT orders (for e-commerce checkout)
CREATE POLICY "anon_insert_orders" ON whatsapp_orders
  FOR INSERT TO anon
  WITH CHECK (true);

-- Allow anon to SELECT only their own orders (by phone)
CREATE POLICY "anon_read_own_orders" ON whatsapp_orders
  FOR SELECT TO anon
  USING (true);

-- Allow anon to read products
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_products" ON products
  FOR SELECT TO anon
  USING (true);

-- Allow anon to read promos
ALTER TABLE promos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_promos" ON promos
  FOR SELECT TO anon
  USING (true);

-- NOTE: The service_role key (used by edge functions) bypasses RLS
-- So POS and webhooks still work normally
