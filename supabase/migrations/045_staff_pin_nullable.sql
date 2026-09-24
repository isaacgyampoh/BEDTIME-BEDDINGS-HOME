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
