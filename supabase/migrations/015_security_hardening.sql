-- ============================================================================
-- 015: SECURITY HARDENING
--
-- Run this in the Supabase SQL Editor. It is written to be idempotent and
-- login-safe: verify_pin keeps accepting existing plaintext PINs and upgrades
-- each one to a hash on first successful login, so nobody is locked out.
--
-- DEPLOY ORDER: run this migration FIRST, then deploy the updated frontend.
--
-- What this fixes
--   1. The anon key (public, shipped in the browser bundle) could
--      `select pin from staff` and read every PIN in plaintext, which is a
--      full admin takeover of the POS.
--   2. PINs were stored in plaintext.
--   3. verify_pin had no throttling — a 4-digit PIN is 10,000 guesses.
--   4. add_staff_secure / update_staff_secure were SECURITY DEFINER and
--      callable by anon: anyone could create themselves an Admin account.
--   5. SECURITY DEFINER functions had no fixed search_path (privilege
--      escalation vector; also flagged by Supabase's own linter).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Supabase installs extensions into the `extensions` schema, not `public`, so
-- crypt()/gen_salt() are NOT on the default search_path. Put `extensions` on
-- the path for this migration's own statements, and on every function below
-- that touches them.
SET search_path = public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. Stop exposing the staff table (and its pin column) to the anon key.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "staff_select" ON staff;
DROP POLICY IF EXISTS "staff_insert" ON staff;
DROP POLICY IF EXISTS "staff_update" ON staff;
DROP POLICY IF EXISTS "staff_delete" ON staff;

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON staff FROM anon, authenticated;

-- The app reads staff through this view, which cannot expose `pin`.
CREATE OR REPLACE VIEW staff_safe
  WITH (security_invoker = false) AS
SELECT id, name, role, active FROM staff;

GRANT SELECT ON staff_safe TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Hash the PINs. `pin` is kept for the transition and cleared per-row as
--    each PIN is upgraded (see verify_pin below).
-- ---------------------------------------------------------------------------
ALTER TABLE staff ADD COLUMN IF NOT EXISTS pin_hash TEXT;

UPDATE staff
   SET pin_hash = crypt(pin, gen_salt('bf', 10))
 WHERE pin_hash IS NULL
   AND pin IS NOT NULL
   AND pin <> '';

-- ---------------------------------------------------------------------------
-- 3. Failed-attempt throttling for PIN login.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pin_attempts (
  id          BIGSERIAL PRIMARY KEY,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  succeeded   BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pin_attempts_time ON pin_attempts(attempted_at DESC);

ALTER TABLE pin_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pin_attempts FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. verify_pin: hash-aware, self-upgrading, throttled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_pin(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_staff   record;
  v_recent  integer;
BEGIN
  IF p_pin IS NULL OR p_pin !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  -- Lock out after 10 failures in 5 minutes. Tuned so a real cashier fumbling
  -- their PIN is never affected, but 10,000-guess enumeration is not viable.
  SELECT count(*) INTO v_recent
    FROM pin_attempts
   WHERE succeeded = false
     AND attempted_at > now() - interval '5 minutes';

  IF v_recent >= 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Too many attempts. Wait a few minutes and try again.');
  END IF;

  -- Preferred path: bcrypt comparison.
  SELECT id, name, role INTO v_staff
    FROM staff
   WHERE active = true
     AND pin_hash IS NOT NULL
     AND pin_hash = crypt(p_pin, pin_hash)
   LIMIT 1;

  -- Transitional path: a row whose PIN has not been hashed yet. Hash it now
  -- and clear the plaintext, so the estate converts itself as people log in.
  IF v_staff.id IS NULL THEN
    SELECT id, name, role INTO v_staff
      FROM staff
     WHERE active = true
       AND pin_hash IS NULL
       AND pin = p_pin
     LIMIT 1;

    IF v_staff.id IS NOT NULL THEN
      UPDATE staff
         SET pin_hash = crypt(p_pin, gen_salt('bf', 10)),
             pin = NULL
       WHERE id = v_staff.id;
    END IF;
  END IF;

  INSERT INTO pin_attempts (succeeded) VALUES (v_staff.id IS NOT NULL);

  -- Keep the throttle table from growing without bound.
  DELETE FROM pin_attempts WHERE attempted_at < now() - interval '1 day';

  IF v_staff.id IS NULL THEN
    RETURN jsonb_build_object('success', false);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'id',      v_staff.id,
    'name',    v_staff.name,
    'role',    v_staff.role
  );
END;
$$;

REVOKE ALL ON FUNCTION verify_pin(text) FROM public;
GRANT EXECUTE ON FUNCTION verify_pin(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Staff management now requires proof of an admin PIN.
--
--    The old add_staff_secure / update_staff_secure were SECURITY DEFINER and
--    executable by anon with no authorisation at all, so anyone holding the
--    (public) anon key could insert themselves an Admin row. The app has no
--    session concept, so authorisation is proven by passing a valid admin PIN
--    with the call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_admin_pin(p_pin text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM staff
     WHERE active = true
       AND role = 'Admin'
       AND (
         (pin_hash IS NOT NULL AND pin_hash = crypt(p_pin, pin_hash))
         OR (pin_hash IS NULL AND pin = p_pin)
       )
  );
$$;
REVOKE ALL ON FUNCTION is_admin_pin(text) FROM public, anon, authenticated;

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
         AND ((pin_hash IS NOT NULL AND pin_hash = crypt(p_pin, pin_hash)) OR pin = p_pin)
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'That PIN is already used by another staff member');
    END IF;
    v_hash := crypt(p_pin, gen_salt('bf', 10));
  END IF;

  IF p_id IS NULL THEN
    IF v_hash IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'A 4-digit PIN is required for a new staff member');
    END IF;
    INSERT INTO staff (name, role, pin, pin_hash, active)
    VALUES (btrim(p_name), p_role, NULL, v_hash, p_active)
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
      RETURN jsonb_build_object('success', false, 'error', 'Staff member not found');
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION admin_delete_staff(p_admin_pin text, p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT is_admin_pin(p_admin_pin) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin PIN is incorrect');
  END IF;

  IF EXISTS (SELECT 1 FROM staff WHERE id = p_id AND role = 'Admin' AND active = true)
     AND (SELECT count(*) FROM staff WHERE role = 'Admin' AND active = true) <= 1 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot delete the last active admin');
  END IF;

  DELETE FROM staff WHERE id = p_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION admin_save_staff(text, text, text, text, text, boolean) FROM public;
REVOKE ALL ON FUNCTION admin_delete_staff(text, text) FROM public;
GRANT EXECUTE ON FUNCTION admin_save_staff(text, text, text, text, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_staff(text, text) TO anon, authenticated;

-- Retire the unauthenticated predecessors.
DROP FUNCTION IF EXISTS add_staff_secure(text, text, text, boolean);
DROP FUNCTION IF EXISTS update_staff_secure(uuid, text, text, text, boolean);
DROP FUNCTION IF EXISTS update_staff_secure(text, text, text, text, boolean);

-- ---------------------------------------------------------------------------
-- 6. Pin a search_path on the remaining SECURITY DEFINER functions.
--    Without it, a caller-controlled search_path can shadow the objects these
--    functions reference and run arbitrary code as the function owner.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef                                   -- SECURITY DEFINER
       AND NOT EXISTS (                                  -- no search_path set
         SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
          WHERE c LIKE 'search_path=%'
       )
       AND p.proname <> 'call_edge'                       -- 018 pins its own
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, extensions, pg_temp', fn.sig);
    RAISE NOTICE 'Pinned search_path on %', fn.sig;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Verification — all three should come back clean.
-- ---------------------------------------------------------------------------
-- (a) anon must NOT be able to read the staff table:
SELECT has_table_privilege('anon', 'staff', 'SELECT') AS anon_can_read_staff_should_be_false;

-- (b) every active staff member should end up with a hash (plaintext rows
--     convert on their next login):
SELECT count(*) FILTER (WHERE pin_hash IS NOT NULL) AS hashed,
       count(*) FILTER (WHERE pin_hash IS NULL)     AS not_yet_hashed
  FROM staff WHERE active = true;

-- (c) no SECURITY DEFINER function left without a pinned search_path:
SELECT count(*) AS unpinned_security_definer_should_be_zero
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%');
