-- ===========================================================================
--  BEDTIME HOME - everything waiting, in one transaction
--
--  Supabase dashboard -> SQL Editor -> New query -> paste this -> Run.
--
--  One transaction: if any part fails, nothing is kept and the database is
--  exactly as it was. Running it twice is safe.
--
--  NOT included, on purpose: 043, 044 and 047. Those move the business tables
--  behind a staff session, and until the super-service Edge Function is
--  deployed and a PIN sign-in is proven, applying them blanks every admin
--  screen. They are staged in supabase/pending/apply-after-sessions.sql.
-- ===========================================================================

BEGIN;


-- --- 048_columns_added_outside_the_history.sql -----------
--     Columns the application uses that no migration created

-- ---------------------------------------------------------------------------
-- 048  Columns that exist in production but that no migration here creates.
--
-- Someone added these straight to the database over time. The application uses
-- every one of them, so production is fine — but this repository could not
-- rebuild production, and that only matters on the day it has to.
--
-- It nearly did matter. On 26 October 2026 the Supabase project was deleted and
-- the shop served an empty catalogue until it was restored. Had it not been
-- restored, the schema rebuilt from these migrations would have come up missing
-- the columns below, and the WhatsApp agent in particular would have failed on
-- its first query — it reads seven columns of wa_conversations that the
-- migration creating that table never defined.
--
-- Found by rebuilding the schema from 001-047 into an empty PostgreSQL and
-- comparing every column the application selects, filters or orders by against
-- what the rebuild actually produced.
--
-- Every statement is ADD COLUMN IF NOT EXISTS, so against production this is a
-- no-op and against a rebuilt database it is the repair. Nothing is dropped,
-- nothing is renamed, and no existing row changes except to gain a default.
-- ---------------------------------------------------------------------------

-- 1. wa_conversations — the WhatsApp agent's state for one chat.
--    022 created it with id, chat_id, customer_name, messages and timestamps.
--    supabase/functions/wa-agent/index.ts and src/pages/WhatsAppChats.jsx need
--    the rest: whose number it is, where the conversation has got to, whether
--    the agent is answering, and whether a person needs to take over.
-- updated_at drifts the OTHER way: 009 creates the table with it, and the
-- 30-day cleanup job deletes rows by it, but it is absent from production —
-- which is how applying this file the first time failed:
--     ERROR: 42703: column "updated_at" does not exist
-- So the cleanup job has been failing there too. Restored first, because the
-- back-fill below reads it.
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT now();

ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS phone           TEXT;
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS stage           TEXT;
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS agent_enabled   BOOLEAN     NOT NULL DEFAULT true;
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS needs_human     BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS followed_up     BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS last_agent_at   TIMESTAMPTZ;

-- The chat list is ordered by last_message_at, and the agent looks a
-- conversation up by phone on every inbound message.
CREATE INDEX IF NOT EXISTS wa_conversations_last_message_idx ON wa_conversations (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS wa_conversations_phone_idx        ON wa_conversations (phone);

-- A conversation that has never been ordered should still sort sensibly.
UPDATE wa_conversations SET last_message_at = COALESCE(last_message_at, updated_at, created_at)
 WHERE last_message_at IS NULL;

-- 2. whatsapp_orders — `source` and `details_filled` are written by the shop
--    front on every web order and read by the delivery pages; `followed_up`
--    stops wa-agent chasing the same unpaid order twice.
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS source         TEXT;
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS details_filled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE whatsapp_orders ADD COLUMN IF NOT EXISTS followed_up    BOOLEAN NOT NULL DEFAULT false;

-- Orders already in the table came from somewhere; 'web' is what the shop
-- front writes and what every existing row predates.
UPDATE whatsapp_orders SET source = 'web' WHERE source IS NULL;

-- The follow-up sweep reads unpaid, un-chased orders.
CREATE INDEX IF NOT EXISTS whatsapp_orders_followup_idx ON whatsapp_orders (followed_up, status);

-- 3. promos — the WhatsApp agent reads a promotion's description when it
--    offers one to a customer (wa-agent/index.ts: select('name,description')).
ALTER TABLE promos ADD COLUMN IF NOT EXISTS description TEXT;


-- --- 042_drop_unused_anon_grants.sql ---------------------
--     Remove public privileges no code path uses

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


-- --- 045_staff_pin_nullable.sql --------------------------
--     Adding a staff member works again (this is the PRINCE fix)

-- ---------------------------------------------------------------------------
-- 045  Adding a staff member has been impossible since 015.
--
-- `staff.pin` is declared NOT NULL (001_schema). 015 moved PINs to a bcrypt
-- `pin_hash` column and left `pin` behind "for the transition", to be cleared
-- per row — but never dropped the NOT NULL. So admin_save_staff's
--
--     INSERT INTO staff (name, role, pin, pin_hash, active)
--     VALUES (btrim(p_name), p_role, NULL, v_hash, p_active)
--
-- violates the constraint and the whole call fails. The admin PIN is checked
-- first and passes, so the screen says "Save failed" with a Postgres message
-- about a null value, which reads like a bug in the form. Nobody has been able
-- to add a staff member since 015 went out.
--
-- The same line sits in verify_pin's upgrade path (hash the PIN, clear the
-- plaintext). It does not bite today only because 015 back-filled pin_hash for
-- every existing row, so that branch is never reached — but any row that ever
-- had a plaintext PIN and no hash could not log in.
--
-- Confirmed against production before writing this: admin_save_staff is
-- reachable and returns "Admin PIN is incorrect" for a wrong PIN, so the
-- function and its grants are fine; the failure is the insert.
-- ---------------------------------------------------------------------------

-- 1. The real credential is pin_hash. `pin` is legacy and must be allowed to
--    be empty, which is what every function already assumes.
ALTER TABLE staff ALTER COLUMN pin DROP NOT NULL;

-- 2. Now that it can be, clear the plaintext PINs 015 had to leave in place.
--    verify_pin and is_admin_pin both prefer pin_hash and only fall back to
--    `pin` when there is no hash, so this removes readable PINs from the table
--    without affecting anyone's ability to sign in.
UPDATE staff SET pin = NULL WHERE pin_hash IS NOT NULL AND pin IS NOT NULL;

-- 3. Stop writing the legacy column on insert, and report a failure as a
--    message the person at the screen can act on instead of a raw SQL error.
CREATE OR REPLACE FUNCTION admin_save_staff(
  p_admin_pin text,
  p_name      text,
  p_role      text,
  p_pin       text DEFAULT NULL,
  p_id        text DEFAULT NULL,
  p_active    boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id   text;
  v_hash text;
BEGIN
  IF NOT is_admin_pin(p_admin_pin) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin PIN is incorrect');
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Name is required');
  END IF;

  IF p_role NOT IN ('Admin', 'Cashier') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Role must be Admin or Cashier');
  END IF;

  IF p_pin IS NOT NULL AND p_pin <> '' THEN
    IF p_pin !~ '^[0-9]{4}$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'PIN must be exactly 4 digits');
    END IF;
    -- Two people sharing a PIN makes verify_pin ambiguous and the audit trail wrong.
    IF EXISTS (
      SELECT 1 FROM staff
       WHERE (p_id IS NULL OR id <> p_id)
         AND ((pin_hash IS NOT NULL AND pin_hash = crypt(p_pin, pin_hash))
              OR (pin IS NOT NULL AND pin = p_pin))
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'That PIN is already used by another staff member');
    END IF;
    v_hash := crypt(p_pin, gen_salt('bf', 10));
  END IF;

  IF p_id IS NULL THEN
    IF v_hash IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'A 4-digit PIN is required for a new staff member');
    END IF;
    -- `pin` is left out entirely rather than written as NULL: the plaintext
    -- column is legacy and nothing should put a value in it again.
    INSERT INTO staff (name, role, pin_hash, active)
    VALUES (btrim(p_name), p_role, v_hash, p_active)
    RETURNING id INTO v_id;
  ELSE
    -- Never demote or deactivate the last remaining admin.
    IF (p_role <> 'Admin' OR p_active = false)
       AND EXISTS (SELECT 1 FROM staff WHERE id = p_id AND role = 'Admin' AND active = true)
       AND (SELECT count(*) FROM staff WHERE role = 'Admin' AND active = true) <= 1 THEN
      RETURN jsonb_build_object('success', false, 'error', 'This is the last active admin');
    END IF;

    UPDATE staff
       SET name     = btrim(p_name),
           role     = p_role,
           active   = p_active,
           pin_hash = COALESCE(v_hash, pin_hash),
           pin      = CASE WHEN v_hash IS NOT NULL THEN NULL ELSE pin END
     WHERE id = p_id
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'That staff member no longer exists');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION WHEN OTHERS THEN
  -- Without this the caller gets a raw Postgres error and the screen shows
  -- something like 'null value in column "pin" violates not-null constraint',
  -- which tells the person at the till nothing they can act on.
  RAISE WARNING 'admin_save_staff failed: % (%)', SQLERRM, SQLSTATE;
  RETURN jsonb_build_object('success', false, 'error', 'Could not save the staff member: ' || SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION admin_save_staff(text, text, text, text, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION admin_save_staff(text, text, text, text, text, boolean) TO anon, authenticated;


-- --- 046_sms_exempt_new_admin_line.sql -------------------
--     Stop the owner's new line hitting the SMS rate cap

-- ---------------------------------------------------------------------------
-- 046  The daily reports now go to 0548124978 — exempt it from the SMS cap.
--
-- claim_sms (029) caps a number at 4 messages per 10 minutes and 12 per day.
-- That is right for a customer's phone and wrong for the shop's own line,
-- which receives the scheduled reports and an alert for every online payment.
-- 029 exempted 599084552. Changing the recipient without adding the new number
-- would quietly reintroduce exactly the failure 029 was written to stop: the
-- cap is reached, claim_sms says no, and the owner simply stops being told.
--
-- The old line stays exempt: it still receives the per-order payment alerts,
-- which are a different notification and were not part of this change.
-- Numbers are stored as the last 9 digits, which is how claim_sms matches.
-- ---------------------------------------------------------------------------

INSERT INTO sms_exempt_numbers (phone, label)
VALUES ('548124978', 'Shop / owner line (daily reports from Oct 2026)')
ON CONFLICT (phone) DO UPDATE SET label = EXCLUDED.label;

COMMIT;
