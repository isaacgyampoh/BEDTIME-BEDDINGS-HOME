-- Table for "Back in Stock" notifications
CREATE TABLE IF NOT EXISTS stock_notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  product_id UUID REFERENCES products(id),
  phone TEXT NOT NULL,
  notified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Allow anon to insert notifications
ALTER TABLE stock_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_insert_stock_notify" ON stock_notifications FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_read_own_notify" ON stock_notifications FOR SELECT TO anon USING (true);
