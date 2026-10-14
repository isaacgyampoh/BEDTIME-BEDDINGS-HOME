-- ===========================================================================
--  APPLY NOW  —  safe with the system exactly as it is deployed today
--
--  Paste the whole file into the Supabase dashboard SQL Editor and run it, or
--  let Claude run it once the Supabase connector is authorised. It is one
--  transaction: if any statement fails, nothing is kept.
--
--  Contents, in dependency order:
--    042  removes public privileges no code path uses (verified: nothing in
--         src/, storefront/src/ or supabase/functions/ inserts into `sales`
--         or deletes a customer or an order)
--    045  makes adding a staff member possible again
--    046  stops the new owner line hitting the SMS rate cap
--
--  NOT in this file: 043, 044 and 047. Each of them moves tables to
--  `authenticated`, and staff still arrive as `anon` because nobody has signed
--  in through the new staff-login function yet. Applying them today blanks the
--  admin screens. They are staged in apply-after-sessions.sql.
-- ===========================================================================

BEGIN;



-- ─── 042_drop_unused_anon_grants.sql ───────────────────────────────────────

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


-- ─── 045_staff_pin_nullable.sql ────────────────────────────────────────────

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


-- ─── 046_sms_exempt_new_admin_line.sql ─────────────────────────────────────

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
