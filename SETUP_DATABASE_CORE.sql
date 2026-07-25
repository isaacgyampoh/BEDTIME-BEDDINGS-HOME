-- ============================================================
-- BEDTIME BEDDINGS HOME — CORE database setup (tables + functions)
-- Run this ONCE in Supabase -> SQL Editor on the new project.
-- Assembled from the EVERYTINROOM schema (proven in production).
-- ============================================================


-- ==================== 001_schema ====================
-- ============================================================================
-- EVERYTINROOM POS — FULL SUPABASE SCHEMA
-- Run this ONCE in: Supabase Dashboard → SQL Editor → New Query → Run
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Helper: short IDs like the old system
CREATE OR REPLACE FUNCTION short_id() RETURNS TEXT AS $$
  SELECT substring(uuid_generate_v4()::text, 1, 8);
$$ LANGUAGE sql;

-- ======================== PRODUCTS ========================
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  name TEXT NOT NULL,
  category TEXT DEFAULT '',
  cost_price NUMERIC(10,2) DEFAULT 0,
  price NUMERIC(10,2) DEFAULT 0,
  wholesale_price NUMERIC(10,2) DEFAULT 0,
  quantity INTEGER DEFAULT 0,
  image TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- ======================== BUNDLES ========================
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  name TEXT NOT NULL,
  products JSONB DEFAULT '[]',
  bundle_price NUMERIC(10,2) DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== SALES ========================
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  receipt_no TEXT NOT NULL UNIQUE,
  date TIMESTAMPTZ DEFAULT now(),
  items JSONB DEFAULT '[]',
  subtotal NUMERIC(10,2) DEFAULT 0,
  discount NUMERIC(10,2) DEFAULT 0,
  total NUMERIC(10,2) DEFAULT 0,
  profit NUMERIC(10,2) DEFAULT 0,
  payment TEXT DEFAULT 'Cash',
  split_cash NUMERIC(10,2) DEFAULT 0,
  split_momo NUMERIC(10,2) DEFAULT 0,
  customer TEXT DEFAULT 'Walk-in',
  type TEXT DEFAULT 'Retail',
  cashier TEXT DEFAULT '',
  voided BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_no);
CREATE INDEX IF NOT EXISTS idx_sales_cashier ON sales(cashier);

-- ======================== CUSTOMERS ========================
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  phone TEXT NOT NULL UNIQUE,
  visit_count INTEGER DEFAULT 0,
  total_spent NUMERIC(10,2) DEFAULT 0,
  last_visit TIMESTAMPTZ DEFAULT now()
);

-- ======================== STAFF ========================
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  name TEXT NOT NULL,
  role TEXT DEFAULT 'Cashier',
  pin TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== EXPENSES ========================
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  date TIMESTAMPTZ DEFAULT now(),
  category TEXT DEFAULT '',
  description TEXT DEFAULT '',
  amount NUMERIC(10,2) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);

-- ======================== STOCK TAKES ========================
CREATE TABLE IF NOT EXISTS stock_takes (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  date TIMESTAMPTZ DEFAULT now(),
  items JSONB DEFAULT '[]',
  notes TEXT DEFAULT '',
  conducted_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== STOCK ADJUSTMENTS ========================
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  date TIMESTAMPTZ DEFAULT now(),
  product_id TEXT DEFAULT '',
  product_name TEXT DEFAULT '',
  qty INTEGER DEFAULT 0,
  reason TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  adjusted_by TEXT DEFAULT ''
);

-- ======================== PROMOS ========================
CREATE TABLE IF NOT EXISTS promos (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  name TEXT NOT NULL,
  start_date DATE,
  end_date DATE,
  items JSONB DEFAULT '[]',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== INVOICES ========================
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  invoice_id TEXT DEFAULT '',
  date TIMESTAMPTZ DEFAULT now(),
  supplier TEXT DEFAULT '',
  amount NUMERIC(10,2) DEFAULT 0,
  notes TEXT DEFAULT '',
  image TEXT DEFAULT '',
  photo_index INTEGER DEFAULT 1,
  total_photos INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_id ON invoices(invoice_id);

-- ======================== WHATSAPP ORDERS ========================
CREATE TABLE IF NOT EXISTS whatsapp_orders (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  order_no TEXT NOT NULL,
  date TIMESTAMPTZ DEFAULT now(),
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  subtotal NUMERIC(10,2) DEFAULT 0,
  delivery_fee NUMERIC(10,2) DEFAULT 0,
  total NUMERIC(10,2) DEFAULT 0,
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'Pending',
  paystack_ref TEXT DEFAULT '',
  paid_at TIMESTAMPTZ,
  processed_by TEXT DEFAULT '',
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_status ON whatsapp_orders(status);
CREATE INDEX IF NOT EXISTS idx_wa_date ON whatsapp_orders(date);

-- ======================== REFUNDS ========================
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY DEFAULT short_id(),
  refund_no TEXT NOT NULL,
  date TIMESTAMPTZ DEFAULT now(),
  original_receipt_no TEXT DEFAULT '',
  original_sale_id TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  refund_amount NUMERIC(10,2) DEFAULT 0,
  reason TEXT DEFAULT '',
  processed_by TEXT DEFAULT '',
  customer TEXT DEFAULT '',
  status TEXT DEFAULT 'Completed',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ======================== ROW LEVEL SECURITY ========================
-- POS is internal (PIN-protected), so allow full anon access.
-- Tighten later if you add Supabase Auth.

DO $$ 
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'products','bundles','sales','customers','staff','expenses',
    'stock_takes','stock_adjustments','promos','invoices',
    'whatsapp_orders','refunds'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY "anon_full_%s" ON %I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)', t, t
    );
  END LOOP;
END $$;

-- ======================== SEQUENCE GENERATORS ========================

CREATE OR REPLACE FUNCTION generate_receipt_no() RETURNS TEXT AS $$
DECLARE prefix TEXT; cnt INTEGER;
BEGIN
  prefix := 'RCP' || to_char(now(), 'YYYYMMDD');
  SELECT COUNT(*) INTO cnt FROM sales WHERE receipt_no LIKE prefix || '%';
  RETURN prefix || '-' || lpad((cnt + 1)::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_wa_order_no() RETURNS TEXT AS $$
DECLARE prefix TEXT; cnt INTEGER;
BEGIN
  prefix := 'WA' || to_char(now(), 'YYYYMMDD');
  SELECT COUNT(*) INTO cnt FROM whatsapp_orders WHERE order_no LIKE prefix || '%';
  RETURN prefix || '-' || lpad((cnt + 1)::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION generate_refund_no() RETURNS TEXT AS $$
DECLARE prefix TEXT; cnt INTEGER;
BEGIN
  prefix := 'RFD' || to_char(now(), 'YYYYMMDD');
  SELECT COUNT(*) INTO cnt FROM refunds WHERE refund_no LIKE prefix || '%';
  RETURN prefix || '-' || lpad((cnt + 1)::text, 3, '0');
END;
$$ LANGUAGE plpgsql;

-- ======================== RPC: RECORD SALE (atomic) ========================
-- Does everything in one transaction: insert sale, deduct stock, update customer

CREATE OR REPLACE FUNCTION record_sale(
  p_items JSONB,
  p_customer TEXT,
  p_payment TEXT,
  p_discount NUMERIC,
  p_type TEXT,
  p_cashier TEXT,
  p_split_cash NUMERIC DEFAULT 0,
  p_split_momo NUMERIC DEFAULT 0
) RETURNS JSON AS $$
DECLARE
  v_id TEXT;
  v_receipt TEXT;
  v_subtotal NUMERIC := 0;
  v_profit NUMERIC := 0;
  v_total NUMERIC;
  v_item JSONB;
  v_prod RECORD;
  v_qty INTEGER;
  v_bundle_item JSONB;
BEGIN
  v_id := short_id();
  v_receipt := generate_receipt_no();

  -- Calculate totals
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_subtotal := v_subtotal + COALESCE((v_item->>'lineTotal')::NUMERIC, 0);
    v_profit := v_profit + (
      COALESCE((v_item->>'price')::NUMERIC, 0) - COALESCE((v_item->>'costPrice')::NUMERIC, 0)
    ) * COALESCE((v_item->>'qty')::INTEGER, 0);
  END LOOP;

  v_total := v_subtotal - p_discount;

  -- Insert sale
  INSERT INTO sales (id, receipt_no, date, items, subtotal, discount, total, profit,
    payment, split_cash, split_momo, customer, type, cashier, voided)
  VALUES (v_id, v_receipt, now(), p_items, v_subtotal, p_discount, v_total, v_profit,
    p_payment, p_split_cash, p_split_momo, p_customer, p_type, p_cashier, false);

  -- Deduct stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    IF (v_item->>'isBundle')::BOOLEAN IS TRUE AND v_item->'bundleItems' IS NOT NULL THEN
      -- Bundle: deduct each bundle component
      FOR v_bundle_item IN SELECT * FROM jsonb_array_elements(v_item->'bundleItems') LOOP
        v_qty := COALESCE((v_bundle_item->>'qty')::INTEGER, 0) * COALESCE((v_item->>'qty')::INTEGER, 1);
        UPDATE products SET quantity = GREATEST(0, quantity - v_qty)
        WHERE id = v_bundle_item->>'productId';
      END LOOP;
    ELSIF v_item->>'productId' IS NOT NULL THEN
      UPDATE products SET quantity = GREATEST(0, quantity - COALESCE((v_item->>'qty')::INTEGER, 0))
      WHERE id = v_item->>'productId';
    END IF;
  END LOOP;

  -- Upsert customer
  IF p_customer IS NOT NULL AND p_customer != 'Walk-in' AND p_customer != '' THEN
    INSERT INTO customers (phone, visit_count, total_spent, last_visit)
    VALUES (p_customer, 1, v_total, now())
    ON CONFLICT (phone) DO UPDATE SET
      visit_count = customers.visit_count + 1,
      total_spent = customers.total_spent + v_total,
      last_visit = now();
  END IF;

  RETURN json_build_object(
    'success', true,
    'receiptNo', v_receipt,
    'saleId', v_id,
    'subtotal', v_subtotal,
    'discount', p_discount,
    'total', v_total,
    'date', now()
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;

-- ======================== RPC: VOID SALE ========================

CREATE OR REPLACE FUNCTION void_sale(p_sale_id TEXT) RETURNS JSON AS $$
DECLARE
  v_sale RECORD;
  v_item JSONB;
  v_bundle_item JSONB;
  v_qty INTEGER;
BEGIN
  SELECT * INTO v_sale FROM sales WHERE id = p_sale_id;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Sale not found'); END IF;
  IF v_sale.voided THEN RETURN json_build_object('success', false, 'error', 'Already voided'); END IF;

  -- Restore stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_sale.items) LOOP
    IF (v_item->>'isBundle')::BOOLEAN IS TRUE AND v_item->'bundleItems' IS NOT NULL THEN
      FOR v_bundle_item IN SELECT * FROM jsonb_array_elements(v_item->'bundleItems') LOOP
        v_qty := COALESCE((v_bundle_item->>'qty')::INTEGER, 0) * COALESCE((v_item->>'qty')::INTEGER, 1);
        UPDATE products SET quantity = quantity + v_qty WHERE id = v_bundle_item->>'productId';
      END LOOP;
    ELSIF v_item->>'productId' IS NOT NULL THEN
      UPDATE products SET quantity = quantity + COALESCE((v_item->>'qty')::INTEGER, 0)
      WHERE id = v_item->>'productId';
    END IF;
  END LOOP;

  UPDATE sales SET voided = true WHERE id = p_sale_id;
  RETURN json_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;

-- ======================== RPC: COMPLETE WA ORDER ========================

CREATE OR REPLACE FUNCTION complete_wa_order(p_order_id TEXT, p_processed_by TEXT)
RETURNS JSON AS $$
DECLARE
  v_order RECORD;
  v_item JSONB;
  v_prod RECORD;
  v_profit NUMERIC := 0;
  v_sale_id TEXT;
  v_receipt TEXT;
BEGIN
  SELECT * INTO v_order FROM whatsapp_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Order not found'); END IF;
  IF v_order.status = 'Completed' THEN RETURN json_build_object('success', false, 'error', 'Already completed'); END IF;

  -- Deduct stock + calculate profit
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_order.items) LOOP
    SELECT * INTO v_prod FROM products WHERE lower(name) = lower(v_item->>'name') LIMIT 1;
    IF FOUND THEN
      UPDATE products SET quantity = GREATEST(0, quantity - COALESCE((v_item->>'qty')::INTEGER, 0))
      WHERE id = v_prod.id;
      v_profit := v_profit + (
        COALESCE((v_item->>'price')::NUMERIC, 0) - v_prod.cost_price
      ) * COALESCE((v_item->>'qty')::INTEGER, 0);
    END IF;
  END LOOP;

  v_sale_id := short_id();
  v_receipt := generate_receipt_no();

  INSERT INTO sales (id, receipt_no, date, items, subtotal, discount, total, profit,
    payment, customer, type, cashier, voided)
  VALUES (v_sale_id, v_receipt, now(), v_order.items, v_order.subtotal, 0,
    v_order.total, v_profit, 'Paystack', v_order.customer_phone, 'WhatsApp',
    p_processed_by, false);

  -- Upsert customer
  IF v_order.customer_phone != '' THEN
    INSERT INTO customers (phone, visit_count, total_spent, last_visit)
    VALUES (v_order.customer_phone, 1, v_order.total, now())
    ON CONFLICT (phone) DO UPDATE SET
      visit_count = customers.visit_count + 1,
      total_spent = customers.total_spent + v_order.total,
      last_visit = now();
  END IF;

  UPDATE whatsapp_orders SET
    status = 'Completed', processed_by = p_processed_by, processed_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object('success', true, 'receiptNo', v_receipt, 'saleId', v_sale_id);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;

-- ======================== RPC: PROCESS REFUND ========================

CREATE OR REPLACE FUNCTION process_refund(
  p_receipt_no TEXT,
  p_items JSONB,
  p_reason TEXT,
  p_processed_by TEXT,
  p_customer TEXT
) RETURNS JSON AS $$
DECLARE
  v_sale RECORD;
  v_refund_id TEXT;
  v_refund_no TEXT;
  v_amount NUMERIC := 0;
  v_item JSONB;
  v_orig_items JSONB;
  v_is_full BOOLEAN := false;
BEGIN
  SELECT * INTO v_sale FROM sales WHERE receipt_no = p_receipt_no;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Sale not found'); END IF;
  IF v_sale.voided THEN RETURN json_build_object('success', false, 'error', 'Sale already voided'); END IF;

  v_refund_id := short_id();
  v_refund_no := generate_refund_no();

  -- Calculate refund amount + restore stock
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_amount := v_amount + COALESCE((v_item->>'price')::NUMERIC, 0) * COALESCE((v_item->>'qty')::INTEGER, 0);
    -- Restore stock
    UPDATE products SET quantity = quantity + COALESCE((v_item->>'qty')::INTEGER, 0)
    WHERE lower(name) = lower(v_item->>'name') OR id = COALESCE(v_item->>'productId', '');
  END LOOP;

  INSERT INTO refunds (id, refund_no, date, original_receipt_no, original_sale_id,
    items, refund_amount, reason, processed_by, customer, status)
  VALUES (v_refund_id, v_refund_no, now(), p_receipt_no, v_sale.id,
    p_items, v_amount, p_reason, p_processed_by, p_customer, 'Completed');

  -- Check if full refund → void original sale
  IF jsonb_array_length(p_items) = jsonb_array_length(v_sale.items) THEN
    UPDATE sales SET voided = true WHERE id = v_sale.id;
    v_is_full := true;
  END IF;

  RETURN json_build_object(
    'success', true, 'refundNo', v_refund_no,
    'refundAmount', v_amount, 'isFullRefund', v_is_full
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$ LANGUAGE plpgsql;

-- ======================== RPC: DASHBOARD ========================

CREATE OR REPLACE FUNCTION get_dashboard() RETURNS JSON AS $$
DECLARE today_start TIMESTAMPTZ; result JSON;
BEGIN
  today_start := date_trunc('day', now());
  SELECT json_build_object(
    'todaySales', COALESCE((SELECT SUM(total) FROM sales WHERE date >= today_start AND NOT voided), 0),
    'todayProfit', COALESCE((SELECT SUM(profit) FROM sales WHERE date >= today_start AND NOT voided), 0),
    'todayCount', COALESCE((SELECT COUNT(*) FROM sales WHERE date >= today_start AND NOT voided), 0),
    'pendingOrders', COALESCE((SELECT COUNT(*) FROM whatsapp_orders WHERE status = 'Pending'), 0),
    'paystackOrders', COALESCE((SELECT COUNT(*) FROM whatsapp_orders WHERE paystack_ref != '' AND status != 'Cancelled'), 0)
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- ======================== REALTIME ========================
-- Live updates for key tables
ALTER PUBLICATION supabase_realtime ADD TABLE whatsapp_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE sales;
ALTER PUBLICATION supabase_realtime ADD TABLE products;

-- ============================================================================
-- DONE! Now paste your SUPABASE_URL and SUPABASE_ANON_KEY into the frontend.
-- ============================================================================


-- ==================== 003_storage ====================
-- ============================================================================
-- 003: STORAGE BUCKETS FOR IMAGES
-- Run in Supabase SQL Editor AFTER 001_schema.sql
-- ============================================================================

-- Create storage buckets for product images and invoice photos
INSERT INTO storage.buckets (id, name, public) VALUES ('product-images', 'product-images', true) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('invoice-photos', 'invoice-photos', true) ON CONFLICT DO NOTHING;

-- Allow public read access
CREATE POLICY "Public read product images" ON storage.objects FOR SELECT USING (bucket_id = 'product-images');
CREATE POLICY "Public read invoice photos" ON storage.objects FOR SELECT USING (bucket_id = 'invoice-photos');

-- Allow anon uploads
CREATE POLICY "Anon upload product images" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'product-images');
CREATE POLICY "Anon upload invoice photos" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'invoice-photos');
CREATE POLICY "Anon delete product images" ON storage.objects FOR DELETE USING (bucket_id = 'product-images');
CREATE POLICY "Anon delete invoice photos" ON storage.objects FOR DELETE USING (bucket_id = 'invoice-photos');


-- ==================== 004_security ====================
-- ============================================
-- EVERYTINROOM POS - SECURITY HARDENING
-- Run this in Supabase SQL Editor
-- https://supabase.com/dashboard/project/wqkgfvmvuljzexhevlnp/sql
-- ============================================

-- STEP 1: Enable RLS on all tables
-- (If already enabled, these will just succeed silently)
ALTER TABLE IF EXISTS products ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS whatsapp_orders ENABLE ROW LEVEL SECURITY;

-- Optional tables (won't error if missing)
DO $$ BEGIN ALTER TABLE promos ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE invoices ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE stock_takes ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- STEP 2: Drop existing policies (clean slate)
DO $$ 
DECLARE
  tbl text;
  pol text;
BEGIN
  FOR tbl, pol IN 
    SELECT schemaname || '.' || tablename, policyname 
    FROM pg_policies 
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s', pol, tbl);
  END LOOP;
END $$;

-- STEP 3: Create access policies
-- The anon key is used by the POS app. We allow full access
-- because authentication is handled by PIN at the app level.
-- RLS ensures the data is only accessible through the Supabase API,
-- NOT directly via the database connection string.

-- Products
CREATE POLICY "products_select" ON products FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "products_insert" ON products FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "products_update" ON products FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "products_delete" ON products FOR DELETE TO anon, authenticated USING (true);

-- Sales (no delete - sales should never be deleted, only voided)
CREATE POLICY "sales_select" ON sales FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "sales_insert" ON sales FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "sales_update" ON sales FOR UPDATE TO anon, authenticated USING (true);

-- Staff
CREATE POLICY "staff_select" ON staff FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "staff_insert" ON staff FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "staff_update" ON staff FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "staff_delete" ON staff FOR DELETE TO anon, authenticated USING (true);

-- Expenses
CREATE POLICY "expenses_select" ON expenses FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "expenses_insert" ON expenses FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "expenses_update" ON expenses FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "expenses_delete" ON expenses FOR DELETE TO anon, authenticated USING (true);

-- Customers
CREATE POLICY "customers_select" ON customers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "customers_insert" ON customers FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "customers_update" ON customers FOR UPDATE TO anon, authenticated USING (true);

-- Bundles
CREATE POLICY "bundles_select" ON bundles FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "bundles_insert" ON bundles FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "bundles_update" ON bundles FOR UPDATE TO anon, authenticated USING (true);
CREATE POLICY "bundles_delete" ON bundles FOR DELETE TO anon, authenticated USING (true);

-- Refunds (no delete)
CREATE POLICY "refunds_select" ON refunds FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "refunds_insert" ON refunds FOR INSERT TO anon, authenticated WITH CHECK (true);

-- WhatsApp Orders
CREATE POLICY "wa_select" ON whatsapp_orders FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "wa_insert" ON whatsapp_orders FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "wa_update" ON whatsapp_orders FOR UPDATE TO anon, authenticated USING (true);

-- Optional tables
DO $$ BEGIN EXECUTE 'CREATE POLICY "promos_all" ON promos FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN EXECUTE 'CREATE POLICY "invoices_all" ON invoices FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN EXECUTE 'CREATE POLICY "stocktakes_all" ON stock_takes FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)'; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN EXECUTE 'CREATE POLICY "stockadj_all" ON stock_adjustments FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)'; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- STEP 4: Ensure RPC functions use SECURITY DEFINER
-- This means they run with the function owner's permissions,
-- bypassing RLS for the operations inside the function.
-- The functions themselves validate inputs.

-- Done! Your database is now secured with RLS.


-- ==================== 005_categories ====================
-- ============================================
-- EVERYTINROOM POS - STANDARDIZE CATEGORIES
-- Run this in Supabase SQL Editor
-- ============================================

-- This updates product categories to the standard set.
-- Only run if you want to clean up existing category names.

-- Standard Categories for Everytin Room:
-- 1. Curtains
-- 2. Kitchenware
-- 3. Cookware Sets
-- 4. Racks
-- 5. Rods
-- 6. Chairs
-- 7. Carpets
-- 8. Home Appliances
-- 9. Blankets
-- 10. Bed Sheets
-- 11. Mats
-- 12. Pillows
-- 13. Towels & Covers
-- 14. Artefacts & Decor
-- 15. Other

-- Fix common misspellings / variations
UPDATE products SET category = 'Curtains' WHERE lower(category) IN ('curtain', 'curtains', 'curtain set', 'curtain sets');
UPDATE products SET category = 'Kitchenware' WHERE lower(category) IN ('kitchenware', 'kitchenwares', 'kitchen ware', 'kitchen wares', 'kitchen', 'kitchen items');
UPDATE products SET category = 'Cookware Sets' WHERE lower(category) IN ('cookware', 'cookware sets', 'cookware set', 'cooking set', 'cooking sets', 'pots', 'pans');
UPDATE products SET category = 'Racks' WHERE lower(category) IN ('rack', 'racks', 'shelf', 'shelves', 'storage rack');
UPDATE products SET category = 'Rods' WHERE lower(category) IN ('rod', 'rods', 'curtain rod', 'curtain rods');
UPDATE products SET category = 'Chairs' WHERE lower(category) IN ('chair', 'chairs', 'seating');
UPDATE products SET category = 'Carpets' WHERE lower(category) IN ('carpet', 'carpets', 'rug', 'rugs');
UPDATE products SET category = 'Home Appliances' WHERE lower(category) IN ('home appliances', 'human appliances', 'appliance', 'appliances', 'electronics');
UPDATE products SET category = 'Blankets' WHERE lower(category) IN ('blanket', 'blankets', 'duvet', 'duvets', 'comforter');
UPDATE products SET category = 'Bed Sheets' WHERE lower(category) IN ('bed sheet', 'bed sheets', 'bedsheet', 'bedsheets', 'sheet', 'sheets', 'bedding');
UPDATE products SET category = 'Mats' WHERE lower(category) IN ('mat', 'mats', 'door mat', 'floor mat', 'bathroom mat');
UPDATE products SET category = 'Pillows' WHERE lower(category) IN ('pillow', 'pillows', 'pillow case', 'pillowcase');
UPDATE products SET category = 'Towels & Covers' WHERE lower(category) IN ('towel', 'towels', 'tope', 'topes', 'cover', 'covers', 'table cover', 'table cloth');
UPDATE products SET category = 'Artefacts & Decor' WHERE lower(category) IN ('artefact', 'artefacts', 'artifact', 'artifacts', 'decor', 'decoration', 'decorations', 'flowers', 'flower', 'vase', 'aesthetics');
UPDATE products SET category = 'Other' WHERE category IS NULL OR category = '';


-- ==================== 006_wholesale_min_qty ====================
-- ============================================
-- Add wholesale minimum quantity to products
-- Run in Supabase SQL Editor
-- ============================================

-- Add the column (default 0 means no wholesale minimum set)
ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_min_qty integer DEFAULT 0;

-- Example: If a product has wholesale_price = 15 and wholesale_min_qty = 6,
-- when a customer adds 6+ of that product to cart, the price auto-switches
-- from retail price to wholesale price.


-- ==================== 007_pin_security ====================
-- ============================================
-- SECURITY: Server-side PIN verification
-- Run this in Supabase SQL Editor
-- PINs will no longer be sent to the browser
-- ============================================

CREATE OR REPLACE FUNCTION verify_pin(p_pin text)
RETURNS jsonb AS $$
DECLARE
  staff_record record;
BEGIN
  -- Check staff table
  SELECT id, name, role, active INTO staff_record
  FROM staff
  WHERE pin = p_pin AND active = true
  LIMIT 1;

  IF staff_record.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'id', staff_record.id,
      'name', staff_record.name,
      'role', staff_record.role
    );
  END IF;

  -- Not found
  RETURN jsonb_build_object('success', false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ==================== 008_admin_serverside ====================
-- ============================================
-- SECURITY UPDATE: Admin PIN also server-side
-- Run in Supabase SQL Editor
-- ============================================

-- Make sure you have an Admin staff record with PIN 1024
-- (or whatever PIN you want for admin)
INSERT INTO staff (name, role, pin, active)
VALUES ('Admin', 'Admin', '1024', true)
ON CONFLICT DO NOTHING;

-- If Admin already exists, update the PIN:
-- UPDATE staff SET pin = '1024' WHERE name = 'Admin' AND role = 'Admin';

-- The verify_pin function already checks the staff table,
-- so Admin will be verified server-side like all other staff.
-- No PIN is exposed in the browser anymore.


-- ==================== 009_whatsapp_bot ====================
-- ============================================
-- 009: WhatsApp AI Bot - Conversations Table
-- Run this in Supabase SQL Editor
-- ============================================

-- Store AI conversation history per customer
CREATE TABLE IF NOT EXISTS wa_conversations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id text UNIQUE NOT NULL,          -- e.g. 233241234567@s.whatsapp.net
  customer_name text DEFAULT 'Customer',
  messages jsonb DEFAULT '[]'::jsonb,     -- Array of {role, content}
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Index for fast lookup by chat_id
CREATE INDEX IF NOT EXISTS idx_wa_conv_chat ON wa_conversations(chat_id);

-- Auto-cleanup: delete conversations older than 30 days
-- (keeps database small, customers rarely continue chats after 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_conversations()
RETURNS void AS $$
BEGIN
  DELETE FROM wa_conversations WHERE updated_at < now() - interval '30 days';
END;
$$ LANGUAGE plpgsql;


-- ==================== 010_secure_pins ====================
-- ============================================
-- SECURITY: Restrict PIN column access
-- Run this in Supabase SQL Editor
-- ============================================

-- Create a secure view for staff that excludes PINs
-- The frontend should use this view instead of the staff table directly
CREATE OR REPLACE VIEW staff_safe AS
SELECT id, name, role, active
FROM staff;

-- Grant access to the view
GRANT SELECT ON staff_safe TO anon, authenticated;

-- Create a secure function to update staff with optional PIN
-- This prevents the frontend from needing to read PINs
CREATE OR REPLACE FUNCTION update_staff_secure(
  p_id uuid,
  p_name text,
  p_role text,
  p_pin text DEFAULT NULL,
  p_active boolean DEFAULT true
)
RETURNS jsonb AS $$
BEGIN
  IF p_pin IS NOT NULL AND length(p_pin) = 4 THEN
    UPDATE staff SET name = p_name, role = p_role, pin = p_pin, active = p_active WHERE id = p_id;
  ELSE
    UPDATE staff SET name = p_name, role = p_role, active = p_active WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create a secure function to add new staff
CREATE OR REPLACE FUNCTION add_staff_secure(
  p_name text,
  p_role text,
  p_pin text,
  p_active boolean DEFAULT true
)
RETURNS jsonb AS $$
DECLARE
  new_id uuid;
BEGIN
  IF length(p_pin) != 4 THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must be 4 digits');
  END IF;
  
  INSERT INTO staff (name, role, pin, active)
  VALUES (p_name, p_role, p_pin, p_active)
  RETURNING id INTO new_id;
  
  RETURN jsonb_build_object('success', true, 'id', new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ==================== 011_ussd_payment ====================
-- ============================================
-- 011: USSD Payment - Add ussd_code to whatsapp_orders
-- Run this in Supabase SQL Editor
-- ============================================

-- Add ussd_code column (numeric, for USSD dialing)
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS ussd_code INTEGER;

-- Create a sequence starting at 50001
CREATE SEQUENCE IF NOT EXISTS ussd_code_seq START 50001;

-- Auto-assign ussd_code when a new order is created without one
CREATE OR REPLACE FUNCTION assign_ussd_code()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ussd_code IS NULL THEN
    NEW.ussd_code := nextval('ussd_code_seq');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trg_assign_ussd_code ON whatsapp_orders;
CREATE TRIGGER trg_assign_ussd_code
  BEFORE INSERT ON whatsapp_orders
  FOR EACH ROW
  EXECUTE FUNCTION assign_ussd_code();

-- Index for fast lookup by ussd_code
CREATE INDEX IF NOT EXISTS idx_wa_ussd_code ON whatsapp_orders(ussd_code);

-- Backfill existing orders that don't have a ussd_code
UPDATE whatsapp_orders SET ussd_code = nextval('ussd_code_seq') WHERE ussd_code IS NULL;

-- Verify
SELECT id, order_no, ussd_code, total, status FROM whatsapp_orders ORDER BY date DESC LIMIT 5;


-- ==================== 012_delivery_tracking ====================
-- Add delivery tracking columns to whatsapp_orders
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS tracking_no TEXT DEFAULT '';
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT '';
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS delivery_guy TEXT DEFAULT '';
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS delivery_photo TEXT DEFAULT '';
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS delivery_notes TEXT DEFAULT '';

-- Generate tracking number function
CREATE OR REPLACE FUNCTION generate_tracking_no()
RETURNS TEXT AS $$
DECLARE
  track TEXT;
BEGIN
  track := 'ETR-' || TO_CHAR(NOW(), 'YYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
  RETURN track;
END;
$$ LANGUAGE plpgsql;

-- Auto-assign tracking number when order moves to Paid
CREATE OR REPLACE FUNCTION auto_tracking_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'Paid' AND (OLD.status IS NULL OR OLD.status != 'Paid') AND (NEW.tracking_no IS NULL OR NEW.tracking_no = '') THEN
    NEW.tracking_no := 'ETR-' || TO_CHAR(NOW(), 'YYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_tracking ON whatsapp_orders;
CREATE TRIGGER trg_auto_tracking
  BEFORE UPDATE ON whatsapp_orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_tracking_no();

-- Also assign tracking on insert if status is Paid
CREATE OR REPLACE FUNCTION auto_tracking_no_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'Paid' AND (NEW.tracking_no IS NULL OR NEW.tracking_no = '') THEN
    NEW.tracking_no := 'ETR-' || TO_CHAR(NOW(), 'YYMMDD') || '-' || LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_tracking_insert ON whatsapp_orders;
CREATE TRIGGER trg_auto_tracking_insert
  BEFORE INSERT ON whatsapp_orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_tracking_no_insert();


-- ==================== 014_payment_reminders ====================
-- Payment Reminder — runs every hour, sends SMS to customers with unpaid orders
-- Requires pg_cron and pg_net extensions enabled

-- Schedule: every hour at minute 15
SELECT cron.schedule(
  'payment-reminder',
  '15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://wqkgfvmvuljzexhevlnp.supabase.co/functions/v1/charge-momo?action=remind',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vaWl1d2tvdm9vamtjd3p1cHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzExOTQyMTcsImV4cCI6MjA4Njc3MDIxN30.Wpduc4qYawgVSWqMqKPaDWUXm0dp8A_z9IxOrVfqN7w'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To check if it's working:
-- SELECT * FROM cron.job;

-- To remove the schedule:
-- SELECT cron.unschedule('payment-reminder');


-- ==================== order_source ====================
-- ============================================================
-- Order source tagging: distinguish Website / WhatsApp / Walk-in.
-- Run once in Supabase -> SQL Editor.
-- ============================================================

-- Source of the order: 'web' | 'whatsapp' | 'walkin'
alter table public.whatsapp_orders
  add column if not exists source text;

-- Whether the WhatsApp customer has submitted their delivery details yet.
alter table public.whatsapp_orders
  add column if not exists details_filled boolean default false;

-- (The 'address' column already exists and is used by website orders.)

-- Backfill existing rows from their order_no prefix so old orders show a source:
update public.whatsapp_orders
  set source = case
    when order_no like 'WEB-%' then 'web'
    when order_no like 'WA-%'  then 'whatsapp'
    when order_no like 'POS-%' then 'walkin'
    else source
  end
where source is null;

-- Index for filtering by source on the portal.
create index if not exists whatsapp_orders_source_idx on public.whatsapp_orders (source);


-- ==================== products_group_tag ====================
-- ============================================================
-- Add a product "group" so colour/type variants of the same product
-- share wholesale pricing. Run once in Supabase -> SQL Editor.
-- ============================================================

alter table public.products
  add column if not exists group_tag text;

-- (Optional) index for faster grouping if you have many products.
create index if not exists products_group_tag_idx on public.products (group_tag);

-- How to use:
--  Give every colour/type of the same product the SAME group_tag.
--  e.g. all "Two-in-One Sunblock Curtains" colours -> group_tag = 'sunblock-curtains'
--  Leave group_tag empty for products that have no variants (they behave as before).


-- ==================== store_settings ====================
-- ============================================================
-- Store on/off switch — shared between POS and erbliving.shop
-- Run this ONCE in Supabase (SQL Editor).
-- ============================================================

-- A single-row settings table. id is fixed to 1 so there's always one row.
create table if not exists public.store_settings (
  id           int primary key default 1,
  shop_open    boolean not null default true,
  closed_message text not null default 'We are currently closed. Please check back soon.',
  updated_at   timestamptz not null default now(),
  constraint store_settings_singleton check (id = 1)
);

-- Seed the single row (open by default). Safe to run repeatedly.
insert into public.store_settings (id, shop_open)
values (1, true)
on conflict (id) do nothing;

-- ---------- Row Level Security ----------
alter table public.store_settings enable row level security;

-- Anyone (the public shop, using the anon key) can READ the switch.
drop policy if exists "store_settings read" on public.store_settings;
create policy "store_settings read"
  on public.store_settings for select
  using (true);

-- Anyone with the anon key can UPDATE the switch.
-- (The POS already uses the anon key and is PIN-gated to admins in the app.)
-- If you later want this locked tighter, replace `true` with an auth check.
drop policy if exists "store_settings update" on public.store_settings;
create policy "store_settings update"
  on public.store_settings for update
  using (true)
  with check (true);

-- Optional: let Realtime broadcast changes so the shop flips instantly
-- without a refresh. (Safe to run; ignored if already added.)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'store_settings'
  ) then
    alter publication supabase_realtime add table public.store_settings;
  end if;
end $$;


-- ==================== store_settings_fix ====================
-- ============================================================
-- FIX / RE-RUN: store on/off switch
-- Safe to run again even if you ran it before. This guarantees the
-- table exists, the single row (id=1) exists, and the anon key (which
-- both the POS and the shop use) can READ and UPDATE it.
-- Run this whole thing in Supabase -> SQL Editor.
-- ============================================================

create table if not exists public.store_settings (
  id             int primary key default 1,
  shop_open      boolean not null default true,
  closed_message text not null default 'We are currently closed. Please check back soon.',
  updated_at     timestamptz not null default now()
);

-- Make sure the single row exists (id = 1).
insert into public.store_settings (id, shop_open)
values (1, true)
on conflict (id) do nothing;

-- If closed_message column was missing from an earlier run, add it.
alter table public.store_settings
  add column if not exists closed_message text not null default 'We are currently closed. Please check back soon.';

-- ---------- Permissions ----------
alter table public.store_settings enable row level security;

-- Grant the anon + authenticated roles table privileges (RLS still applies).
grant select, insert, update on public.store_settings to anon, authenticated;

-- Drop any old policies, then create open read + write policies.
drop policy if exists "store_settings read"   on public.store_settings;
drop policy if exists "store_settings update" on public.store_settings;
drop policy if exists "store_settings insert" on public.store_settings;

create policy "store_settings read"
  on public.store_settings for select
  to anon, authenticated
  using (true);

create policy "store_settings update"
  on public.store_settings for update
  to anon, authenticated
  using (true) with check (true);

create policy "store_settings insert"
  on public.store_settings for insert
  to anon, authenticated
  with check (true);

-- ---------- Realtime (so the shop flips without a refresh) ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'store_settings'
  ) then
    alter publication supabase_realtime add table public.store_settings;
  end if;
end $$;

-- ---------- Verify ----------
-- After running, this should return one row with shop_open = true.
select * from public.store_settings;


-- ==================== product_images_policy ====================
-- ============================================================
-- Allow the app to upload/read product images.
-- The browser uses the anon key, so the storage bucket needs
-- policies permitting insert (upload) and select (read).
-- Run in Supabase -> SQL Editor.
-- ============================================================

-- Make sure the bucket exists and is public (read).
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

-- Allow anyone (anon) to READ objects in product-images (public images).
drop policy if exists "product-images public read" on storage.objects;
create policy "product-images public read"
  on storage.objects for select
  using ( bucket_id = 'product-images' );

-- Allow uploads (insert) to product-images.
drop policy if exists "product-images upload" on storage.objects;
create policy "product-images upload"
  on storage.objects for insert
  with check ( bucket_id = 'product-images' );

-- Allow overwrite/update (upsert) to product-images.
drop policy if exists "product-images update" on storage.objects;
create policy "product-images update"
  on storage.objects for update
  using ( bucket_id = 'product-images' );

-- Allow delete in product-images (for replacing images).
drop policy if exists "product-images delete" on storage.objects;
create policy "product-images delete"
  on storage.objects for delete
  using ( bucket_id = 'product-images' );


-- ==================== stock_at_payment ====================
-- ============================================================
-- Deduct stock at PAYMENT (not packaging) + restore on cancel.
-- Idempotent: an order's stock is deducted at most once and
-- restored at most once. Run in Supabase -> SQL Editor.
-- ============================================================

-- 1. Flag so we never deduct/restore the same order twice.
alter table public.whatsapp_orders
  add column if not exists stock_deducted boolean default false;

-- 2. Deduct stock for an order's items — ONCE. Safe to call repeatedly.
create or replace function public.deduct_order_stock(p_order_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_order   public.whatsapp_orders%rowtype;
  v_items   jsonb;
  v_item    jsonb;
  v_pid     uuid;
  v_qty     numeric;
  v_name    text;
begin
  select * into v_order from public.whatsapp_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'order not found');
  end if;

  -- Already deducted -> do nothing (idempotent).
  if coalesce(v_order.stock_deducted, false) then
    return jsonb_build_object('success', true, 'note', 'already deducted');
  end if;

  -- items may be stored as jsonb or as a json string.
  begin
    if jsonb_typeof(v_order.items) is not null then
      v_items := v_order.items;
    else
      v_items := v_order.items::jsonb;
    end if;
  exception when others then
    v_items := (v_order.items #>> '{}')::jsonb;
  end;

  if v_items is null then
    update public.whatsapp_orders set stock_deducted = true where id = p_order_id;
    return jsonb_build_object('success', true, 'note', 'no items');
  end if;

  -- Loop items and decrement product stock. Match by product_id if present,
  -- else by name (website carts may store name only).
  for v_item in select * from jsonb_array_elements(v_items)
  loop
    v_qty  := coalesce((v_item->>'qty')::numeric, (v_item->>'quantity')::numeric, 1);
    v_pid  := null;
    begin v_pid := (v_item->>'productId')::uuid; exception when others then v_pid := null; end;
    v_name := coalesce(v_item->>'name', '');

    if v_pid is not null then
      update public.products
        set quantity = greatest(0, coalesce(quantity,0) - v_qty)
        where id = v_pid;
    elsif v_name <> '' then
      update public.products
        set quantity = greatest(0, coalesce(quantity,0) - v_qty)
        where lower(name) = lower(v_name);
    end if;
  end loop;

  update public.whatsapp_orders set stock_deducted = true where id = p_order_id;
  return jsonb_build_object('success', true, 'note', 'deducted');
end;
$$;

-- 3. Restore stock for an order (cancel/refund) — ONCE.
create or replace function public.restore_order_stock(p_order_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_order public.whatsapp_orders%rowtype;
  v_items jsonb;
  v_item  jsonb;
  v_pid   uuid;
  v_qty   numeric;
  v_name  text;
begin
  select * into v_order from public.whatsapp_orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'order not found');
  end if;

  -- Only restore if it was actually deducted.
  if not coalesce(v_order.stock_deducted, false) then
    return jsonb_build_object('success', true, 'note', 'was not deducted');
  end if;

  begin
    if jsonb_typeof(v_order.items) is not null then v_items := v_order.items;
    else v_items := v_order.items::jsonb; end if;
  exception when others then v_items := (v_order.items #>> '{}')::jsonb; end;

  if v_items is not null then
    for v_item in select * from jsonb_array_elements(v_items)
    loop
      v_qty  := coalesce((v_item->>'qty')::numeric, (v_item->>'quantity')::numeric, 1);
      v_pid  := null;
      begin v_pid := (v_item->>'productId')::uuid; exception when others then v_pid := null; end;
      v_name := coalesce(v_item->>'name', '');
      if v_pid is not null then
        update public.products set quantity = coalesce(quantity,0) + v_qty where id = v_pid;
      elsif v_name <> '' then
        update public.products set quantity = coalesce(quantity,0) + v_qty where lower(name) = lower(v_name);
      end if;
    end loop;
  end if;

  update public.whatsapp_orders set stock_deducted = false where id = p_order_id;
  return jsonb_build_object('success', true, 'note', 'restored');
end;
$$;

-- 4. Backfill: mark orders that are already Paid/Completed as deducted so we
-- don't double-deduct them on the first reconcile after this migration.
-- (Their stock was already taken at packaging under the old flow.)
update public.whatsapp_orders
  set stock_deducted = true
  where status in ('Paid','Completed') and coalesce(stock_deducted,false) = false;


-- ==================== complete_wa_order_no_deduct ====================
-- ============================================================
-- Updated complete_wa_order: packaging no longer deducts stock.
-- Stock is now deducted at PAYMENT (deduct_order_stock). This
-- function still calculates profit and records the sale, but the
-- line that decremented product quantity has been REMOVED so stock
-- is never deducted twice.
-- Run in Supabase -> SQL Editor AFTER running stock_at_payment.sql.
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_wa_order(p_order_id text, p_processed_by text)
 RETURNS json
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_order RECORD;
  v_item JSONB;
  v_prod RECORD;
  v_profit NUMERIC := 0;
  v_sale_id TEXT;
  v_receipt TEXT;
BEGIN
  SELECT * INTO v_order FROM whatsapp_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', 'Order not found'); END IF;
  IF v_order.status = 'Completed' THEN RETURN json_build_object('success', false, 'error', 'Already completed'); END IF;

  -- Calculate profit ONLY. Stock is NOT deducted here anymore — it was already
  -- deducted at payment (deduct_order_stock). Removing the UPDATE prevents
  -- double-deduction.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_order.items) LOOP
    SELECT * INTO v_prod FROM products WHERE lower(name) = lower(v_item->>'name') LIMIT 1;
    IF FOUND THEN
      v_profit := v_profit + (
        COALESCE((v_item->>'price')::NUMERIC, 0) - v_prod.cost_price
      ) * COALESCE((v_item->>'qty')::INTEGER, 0);
    END IF;
  END LOOP;

  v_sale_id := short_id();
  v_receipt := generate_receipt_no();

  INSERT INTO sales (id, receipt_no, date, items, subtotal, discount, total, profit,
    payment, customer, type, cashier, voided)
  VALUES (v_sale_id, v_receipt, now(), v_order.items, v_order.subtotal, 0,
    v_order.total, v_profit, 'Paystack', v_order.customer_phone, 'WhatsApp',
    p_processed_by, false);

  -- Upsert customer
  IF v_order.customer_phone != '' THEN
    INSERT INTO customers (phone, visit_count, total_spent, last_visit)
    VALUES (v_order.customer_phone, 1, v_order.total, now())
    ON CONFLICT (phone) DO UPDATE SET
      visit_count = customers.visit_count + 1,
      total_spent = customers.total_spent + v_order.total,
      last_visit = now();
  END IF;

  UPDATE whatsapp_orders SET
    status = 'Completed', processed_by = p_processed_by, processed_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object('success', true, 'receiptNo', v_receipt, 'saleId', v_sale_id);
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$function$;

