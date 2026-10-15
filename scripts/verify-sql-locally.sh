#!/usr/bin/env bash
# Replay the whole migration history into a throwaway local database, then apply
# the staged files in supabase/pending/ on top and exercise the paths they touch.
#
# This exists because the alternative is finding out on a live shop. It needs a
# local Postgres (Postgres.app is fine) and touches nothing but its own two
# scratch databases. Usage: ./scripts/verify-sql-locally.sh
set -uo pipefail
PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
DB=bedtime_sql_check
HARNESS="${TMPDIR:-/tmp}/bedtime-sql-harness"
MIG=supabase/migrations
say () { printf '%s\n' "$*"; }

command -v psql >/dev/null || { say "no psql on PATH"; exit 1; }

# ---------------------------------------------------------------- shims
# A plain Postgres has no pg_cron, no pg_net and no supabase_realtime, and keeps
# pgcrypto's crypt()/gen_salt() in a schema the migrations do not name.
mkdir -p "$HARNESS"
cat > "$HARNESS/prelude.sql" <<'SQL'
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE SCHEMA IF NOT EXISTS net;
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;
-- Supabase hands anon and authenticated full rights on everything in `public`
-- and keeps doing so for tables created later. The migrations then take rights
-- away selectively, so without this baseline a REVOKE proves nothing.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT extensions.uuid_generate_v4() $$;
CREATE OR REPLACE FUNCTION public.crypt(text,text)   RETURNS text LANGUAGE sql AS $$ SELECT extensions.crypt($1,$2) $$;
CREATE OR REPLACE FUNCTION public.gen_salt(text,int)  RETURNS text LANGUAGE sql AS $$ SELECT extensions.gen_salt($1,$2) $$;
CREATE OR REPLACE FUNCTION public.gen_salt(text)      RETURNS text LANGUAGE sql AS $$ SELECT extensions.gen_salt($1) $$;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
CREATE TABLE IF NOT EXISTS cron.job_run_details (jobid bigint, runid bigserial, status text, return_message text, start_time timestamptz default now(), end_time timestamptz);
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES ($1,$2,$3) RETURNING jobid $$;
CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES (NULL,$1,$2) RETURNING jobid $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname=$1 RETURNING true $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint)  RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid=$1 RETURNING true $$;
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE TABLE IF NOT EXISTS net._http_response (id bigint, status_code int, content text, created timestamptz default now(), error_msg text);
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'anon'::text $$;
CREATE TABLE IF NOT EXISTS storage.buckets (id text primary key, name text, public boolean default false);
CREATE TABLE IF NOT EXISTS storage.objects (id uuid default extensions.uuid_generate_v4() primary key, bucket_id text, name text, owner uuid, created_at timestamptz default now(), metadata jsonb);
SQL

# pg_cron and pg_net cannot be installed here, so the CREATE EXTENSION lines are
# neutralised in COPIES. The migrations themselves are never edited.
rm -rf "$HARNESS/mig"; mkdir -p "$HARNESS/mig"; cp $MIG/0*.sql "$HARNESS/mig/"
perl -0pi -e 's/CREATE EXTENSION IF NOT EXISTS\s+"?(pg_cron|pg_net)"?[^;]*;/-- [harness] $1 is Supabase-only;/gi' "$HARNESS"/mig/*.sql

dropdb --if-exists "$DB" >/dev/null 2>&1
createdb "$DB" || exit 1
psql -q -d "$DB" -c "ALTER DATABASE $DB SET search_path = public, extensions, cron, net;" >/dev/null
# supabase_realtime must exist BEFORE 001 runs, or 001 dies on its last statement
psql -q -d "$DB" -c "CREATE PUBLICATION supabase_realtime;" >/dev/null 2>&1
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$HARNESS/prelude.sql" >/dev/null || exit 1

# ------------------------------------------------- the history, once, in order
say "== replaying the migration history =="
fail=0
for f in $(ls "$HARNESS"/mig/0*.sql | sort | grep -vE '04[2-7]_'); do
  out=$(psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" 2>&1) || {
    fail=$((fail+1)); printf '   FAIL %-38s %s\n' "$(basename "$f")" "$(echo "$out" | grep -m1 ERROR | cut -c1-90)"; }
done
say "   failures: $fail"
# Nothing may re-run 001 afterwards: its CREATE OR REPLACE would undo 016's
# hardening of record_sale, which is what makes 042 safe.
secdef=$(psql -q -A -t -d "$DB" -c "select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='record_sale'")
say "   record_sale is SECURITY DEFINER: $secdef   <- 042 depends on this"
[ "$secdef" = "t" ] || { say "   ABORT: it is not, so revoking INSERT on sales would break the till"; exit 1; }

# ----------------------------------------------------- apply-now.sql, then use it
say ""
say "== applying supabase/pending/apply-now.sql (042 + 045 + 046) =="
out=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f supabase/pending/apply-now.sql 2>&1) \
  && say "   applied, transaction committed" \
  || { say "   FAILED (rolled back):"; echo "$out" | grep -m3 ERROR | sed 's/^/     /'; exit 1; }

say ""
say "== the till, as anon, after the grant was removed =="
psql -q -A -t -d "$DB" <<'SQL' 2>&1 | sed 's/^/   /'
INSERT INTO products (name, category, price, cost_price, quantity, wholesale_price, wholesale_min_qty)
VALUES ('Harness Duvet','Duvets', 450, 300, 10, 400, 6) ON CONFLICT DO NOTHING;
DELETE FROM staff WHERE name IN ('Harness Admin','New Cashier');
INSERT INTO staff (name, role, pin_hash, active) VALUES ('Harness Admin','Admin', crypt('1234', gen_salt('bf',10)), true);
SET ROLE anon;
DO $$ BEGIN
  BEGIN INSERT INTO sales (total) VALUES (1);
        RAISE NOTICE 'direct INSERT into sales: ALLOWED  <-- wrong';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'direct INSERT into sales: refused (correct)';
            WHEN others THEN RAISE NOTICE 'direct INSERT into sales: refused, %', SQLSTATE; END;
END $$;
SELECT 'record_sale through the function: '||left((record_sale(
  jsonb_build_array(jsonb_build_object('productId',(SELECT id FROM products WHERE name='Harness Duvet'),
                                       'name','Harness Duvet','qty',2,'price',450,'lineTotal',900)),
  'Walk-in', 'Cash', 0, 'Retail', 'Harness Admin'))::text, 90);
SELECT 'adding a staff member: '||(admin_save_staff('1234','New Cashier','Cashier','5678'))::text;
SELECT 'the shop can still read the catalogue: '||count(*)::text||' product(s)' FROM products;
RESET ROLE;
SELECT 'sales rows recorded: '||count(*) FROM sales;
SELECT 'stock after selling 2 of 10: '||quantity FROM products WHERE name='Harness Duvet';
SELECT 'new SMS line exempt from the cap: '||coalesce((SELECT phone FROM sms_exempt_numbers WHERE phone='548124978'),'MISSING');
SQL

# ------------------------------------- apply-after-sessions.sql, then use it
say ""
say "== applying supabase/pending/apply-after-sessions.sql (043 + 044 + 047) =="
out=$(psql -d "$DB" -v ON_ERROR_STOP=1 -f supabase/pending/apply-after-sessions.sql 2>&1) \
  && say "   applied, transaction committed" \
  || { say "   FAILED (rolled back):"; echo "$out" | grep -m3 ERROR | sed 's/^/     /'; exit 1; }

say ""
say "== is the data exposure actually closed? =="
psql -q -A -t -d "$DB" <<'SQL' 2>&1 | sed 's/^/   /'
-- Something to find, so that "no rows" means closed rather than empty.
INSERT INTO customers (phone) VALUES ('0240000000') ON CONFLICT DO NOTHING;
INSERT INTO expenses (description, amount, date) VALUES ('Harness rent', 500, CURRENT_DATE);
INSERT INTO whatsapp_orders (order_no, customer_name, customer_phone, items, subtotal, total, status)
VALUES ('WEB-HARNESSSEED','Ama','0548124978','[]'::jsonb, 100, 100, 'Pending');
DO $$
DECLARE t text; owner_rows int; anon_rows int;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales','customers','expenses','whatsapp_orders','invoices','products'] LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO owner_rows;   -- as the owner, RLS does not apply
    SET LOCAL ROLE anon;
    BEGIN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO anon_rows;
    EXCEPTION WHEN insufficient_privilege THEN anon_rows := -1;
    END;
    RESET ROLE;
    RAISE NOTICE '% owner sees %, the public key sees %  %', rpad(t,16), owner_rows,
      CASE WHEN anon_rows < 0 THEN 'no access' ELSE anon_rows::text END,
      CASE WHEN t = 'products' THEN CASE WHEN anon_rows = owner_rows THEN '(correct, it is a shop)' ELSE '<-- THE SHOP IS BROKEN' END
           WHEN anon_rows <= 0 THEN '(closed)'
           ELSE '<-- STILL EXPOSED' END;
  END LOOP;
END $$;
SQL

say ""
say "== can the public still forge a promotion and reprice the catalogue? =="
psql -q -A -t -d "$DB" <<'SQL' 2>&1 | sed 's/^/   /'
SET ROLE anon;
DO $$ BEGIN
  BEGIN
    INSERT INTO promos (name, active, start_date, end_date, items)
    VALUES ('Forged', true, CURRENT_DATE, CURRENT_DATE, '[]'::jsonb);
    RAISE NOTICE 'inserting a promotion: ALLOWED  <-- a 1-cedi duvet is purchasable';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'inserting a promotion: refused (correct)';
            WHEN others THEN RAISE NOTICE 'inserting a promotion: refused, %', SQLSTATE; END;
  BEGIN
    UPDATE products SET price = 1 WHERE name = 'Harness Duvet';
    IF FOUND THEN RAISE NOTICE 'rewriting a product price: ALLOWED  <-- wrong';
    ELSE RAISE NOTICE 'rewriting a product price: no rows (closed)'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'rewriting a product price: refused (correct)';
            WHEN others THEN RAISE NOTICE 'rewriting a product price: refused, %', SQLSTATE; END;
END $$;
SQL

say ""
say "== 047: the order total is the database's figure, not the browser's =="
psql -q -A -t -d "$DB" <<'SQL' 2>&1 | sed 's/^/   /'
-- A live promotion on the duvet: 450 retail becomes 300 today.
INSERT INTO promos (name, active, start_date, end_date, items)
VALUES ('Harness Black Friday', true, CURRENT_DATE - 1, CURRENT_DATE + 1,
        jsonb_build_array(jsonb_build_object('productId',(SELECT id FROM products WHERE name='Harness Duvet'),'promoPrice',300)));
SET ROLE anon;
-- 1. an honest order: the browser sends nothing, the server prices it
SELECT '1. server prices 2 x promo 300 -> '||left((public_order_create(jsonb_build_object(
  'order_no','WEB-HARNESS1','customer_name','Ama','customer_phone','0548124978',
  'items', jsonb_build_array(jsonb_build_object('productId',(SELECT id FROM products WHERE name='Harness Duvet'),'qty',2))
)))::text, 150);
-- 2. the attack 047 exists to stop: claim a 2-cedi total for 600 of goods
SELECT '2. a forged total of 2.00 -> '||left((public_order_create(jsonb_build_object(
  'order_no','WEB-HARNESS2','customer_name','Ama','customer_phone','0548124978','total',2,
  'items', jsonb_build_array(jsonb_build_object('productId',(SELECT id FROM products WHERE name='Harness Duvet'),'qty',2))
)))::text, 170);
-- 3. more than exists in the shop
SELECT '3. ordering 99 of 10 in stock -> '||left((public_order_create(jsonb_build_object(
  'order_no','WEB-HARNESS3','customer_name','Ama','customer_phone','0548124978',
  'items', jsonb_build_array(jsonb_build_object('productId',(SELECT id FROM products WHERE name='Harness Duvet'),'qty',99))
)))::text, 150);
-- 4. tracking cannot be used to sweep the table
SELECT '4. tracking on a 3-character query -> '||jsonb_array_length(public_order_track('WEB'))||' rows';
SELECT '5. tracking with the real order number -> '||jsonb_array_length(public_order_track('WEB-HARNESS1'))||' row(s)';
RESET ROLE;
SELECT '6. what was actually stored for H-1: total '||total||' (2 x 300 = 600)' FROM whatsapp_orders WHERE order_no='WEB-HARNESS1';
SQL

say ""
say "== cleaning up =="
dropdb --if-exists "$DB" >/dev/null 2>&1 && say "   scratch database dropped"
