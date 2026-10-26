-- ==========================================================================
--  Everything the schema expects a Supabase project to have already.
--
--  Run this FIRST, before 01-schema.sql, on any PostgreSQL that is not a
--  Supabase project — a Render database, a local one, anything. On Supabase
--  itself most of it is already true and every statement is written to be a
--  no-op in that case, so running it there is harmless.
--
--  Three things are only shims, and the comments say so: pg_cron and pg_net
--  are Supabase/managed extensions that a plain PostgreSQL has no equivalent
--  for, and the scheduled SMS reports depend on them. Creating the objects
--  lets the schema load; it does NOT make the scheduled jobs run. Off
--  Supabase, those jobs need a real scheduler (see restore/MIGRATION.md).
-- ==========================================================================

-- The schemas the migrations qualify names with.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;

-- crypt()/gen_salt() hash the staff PINs; uuid_generate_v4() is behind every
-- primary key through short_id().
CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- The migrations call these unqualified.
CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT extensions.uuid_generate_v4() $$;
CREATE OR REPLACE FUNCTION public.crypt(text, text)  RETURNS text LANGUAGE sql AS $$ SELECT extensions.crypt($1, $2) $$;
CREATE OR REPLACE FUNCTION public.gen_salt(text, int) RETURNS text LANGUAGE sql AS $$ SELECT extensions.gen_salt($1, $2) $$;
CREATE OR REPLACE FUNCTION public.gen_salt(text)      RETURNS text LANGUAGE sql AS $$ SELECT extensions.gen_salt($1) $$;

-- PostgREST's roles. Both applications arrive as `anon`; `authenticated` is
-- what a staff session becomes. Off Supabase these are ordinary roles that
-- nothing logs in as yet, but the GRANTs and policies below name them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;
-- Supabase grants these by default and the migrations then revoke selectively.
-- Without the baseline, a REVOKE in a later migration protects nothing.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

-- Supabase Storage's own tables. The product photos live in a bucket called
-- product-images, and 001 creates that bucket row and policies over it. Off
-- Supabase there is no Storage service behind these tables: they exist so the
-- schema loads and so the bucket's intended policies are recorded. Serving the
-- photos needs real object storage — see restore/MIGRATION.md.
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text, owner uuid, public boolean DEFAULT false,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  bucket_id text REFERENCES storage.buckets(id), name text, owner uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(), metadata jsonb);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;

-- Referenced by the RLS policies.
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'anon'::text $$;

-- Realtime publication. 001 adds tables to it; without it 001 stops at its
-- last statement and the whole file looks like it failed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
  THEN CREATE PUBLICATION supabase_realtime; END IF;
END $$;

-- ── Shims, not working features ──────────────────────────────────────────
-- pg_cron drives 17 scheduled jobs: the daily sales SMS, the payment
-- reconciler, the stock warnings. pg_net is how those jobs call the Edge
-- Functions. Neither exists outside a managed Postgres that ships them.
--
-- These stand-ins let the migrations load and record what WOULD have been
-- scheduled in cron.job, so nothing is lost and the list can be read back.
-- They do not run anything. On a platform without pg_cron the jobs must be
-- driven from outside — see restore/MIGRATION.md.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    CREATE SCHEMA IF NOT EXISTS cron;
    CREATE TABLE IF NOT EXISTS cron.job (
      jobid bigserial PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
    CREATE TABLE IF NOT EXISTS cron.job_run_details (
      jobid bigint, runid bigserial, status text, return_message text,
      start_time timestamptz DEFAULT now(), end_time timestamptz);
    EXECUTE $f$ CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
      RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname,schedule,command) VALUES ($1,$2,$3) RETURNING jobid' $f$;
    EXECUTE $f$ CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text)
      RETURNS bigint LANGUAGE sql AS 'INSERT INTO cron.job(jobname,schedule,command) VALUES (NULL,$1,$2) RETURNING jobid' $f$;
    EXECUTE $f$ CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
      RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobname=$1 RETURNING true' $f$;
    EXECUTE $f$ CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint)
      RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid=$1 RETURNING true' $f$;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    CREATE SCHEMA IF NOT EXISTS net;
    CREATE TABLE IF NOT EXISTS net._http_response (
      id bigint, status_code int, content text, created timestamptz DEFAULT now(), error_msg text);
    EXECUTE $f$ CREATE OR REPLACE FUNCTION net.http_post(
      url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
      headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000)
      RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint' $f$;
  END IF;
END $$;
