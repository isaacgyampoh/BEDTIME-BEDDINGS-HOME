-- ============================================================================
-- 022: Social commerce (TikTok + WhatsApp)
--
-- Additive. Nothing in POS, inventory, sales or reporting is altered.
-- `products` stays the single source of truth: these tables reference a
-- product by id and snapshot only what a published post actually said.
--
-- SECURITY NOTE. OAuth tokens live in social_connections and that table is
-- REVOKED from anon entirely — the browser never sees a token. The app reads
-- connection status through social_connections_safe, which cannot expose one.
-- Privileged actions re-verify an admin PIN server-side via is_admin_pin(),
-- the same primitive staff management and deletes already use, because this
-- app authenticates by PIN and has no session token.
-- ============================================================================

SET search_path = public, extensions, pg_temp;

-- ── 1. Connections (one row per platform) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS social_connections (
  id                TEXT PRIMARY KEY DEFAULT short_id(),
  platform          TEXT NOT NULL UNIQUE,          -- 'tiktok'
  status            TEXT NOT NULL DEFAULT 'connected', -- connected|expired|revoked
  account_name      TEXT,
  account_id        TEXT,
  scopes            TEXT,
  access_token      TEXT,                          -- never leaves the server
  refresh_token     TEXT,                          -- never leaves the server
  token_expires_at  TIMESTAMPTZ,
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_by      TEXT,
  last_published_at TIMESTAMPTZ,
  last_error        TEXT
);

ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON social_connections FROM anon, authenticated;

-- The only shape the browser may see. No token columns, by construction.
CREATE OR REPLACE VIEW social_connections_safe
  WITH (security_invoker = false) AS
SELECT platform, status, account_name, connected_at, last_published_at,
       (access_token IS NOT NULL) AS has_token,
       (token_expires_at IS NOT NULL AND token_expires_at < now()) AS token_expired
  FROM social_connections;
GRANT SELECT ON social_connections_safe TO anon, authenticated;

-- ── 2. Posts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS social_posts (
  id                TEXT PRIMARY KEY DEFAULT short_id(),
  platform          TEXT NOT NULL,                 -- tiktok|whatsapp
  status            TEXT NOT NULL DEFAULT 'draft',
    -- draft|ready|scheduled|publishing|published|failed|cancelled|shared
  product_id        TEXT,
  product_name      TEXT,                          -- snapshot of what was promoted
  caption           TEXT,
  hashtags          TEXT,
  media             JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{type,url}]
  unit              TEXT DEFAULT 'retail',         -- retail|wholesale
  unit_price        NUMERIC(10,2),                 -- price actually quoted
  stock_at_creation INTEGER,                       -- stock actually quoted
  source_event      TEXT DEFAULT 'manual',
    -- manual|new_product|price_change|restock|low_stock
  external_post_id  TEXT,                          -- TikTok publish id, when confirmed
  error             TEXT,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  idempotency_key   TEXT UNIQUE,                   -- duplicate protection (§19)
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_at      TIMESTAMPTZ,
  published_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_social_posts_created  ON social_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_product  ON social_posts (product_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_pending  ON social_posts (status, scheduled_at)
  WHERE status IN ('ready','scheduled','publishing');

ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_posts_sel ON social_posts;
DROP POLICY IF EXISTS social_posts_ins ON social_posts;
DROP POLICY IF EXISTS social_posts_upd ON social_posts;
CREATE POLICY social_posts_sel ON social_posts FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY social_posts_ins ON social_posts FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY social_posts_upd ON social_posts FOR UPDATE TO anon, authenticated USING (true);
-- Published history is a record: it is never deleted from the app.
REVOKE DELETE ON social_posts FROM anon, authenticated;

-- ── 3. Automation rules — safe defaults per the brief (§16) ─────────────────
CREATE TABLE IF NOT EXISTS social_automation_rules (
  event               TEXT PRIMARY KEY,   -- new_product|price_change|restock|low_stock|sold_out
  action              TEXT NOT NULL DEFAULT 'draft',   -- off|draft|publish
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          TEXT
);

INSERT INTO social_automation_rules (event, action) VALUES
  ('new_product',  'draft'),
  ('price_change', 'draft'),
  ('restock',      'draft'),
  ('low_stock',    'off'),      -- off by default
  ('sold_out',     'cancel')    -- pull scheduled content instead of promoting
ON CONFLICT (event) DO NOTHING;

ALTER TABLE social_automation_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_rules_sel ON social_automation_rules;
CREATE POLICY social_rules_sel ON social_automation_rules FOR SELECT TO anon, authenticated USING (true);
-- Changing automation is an admin action; it goes through set_social_rule().
REVOKE INSERT, UPDATE, DELETE ON social_automation_rules FROM anon, authenticated;

-- ── 4. Audit log (feature-scoped; the app has no global one) ────────────────
CREATE TABLE IF NOT EXISTS social_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT NOT NULL,
  platform   TEXT,
  product_id TEXT,
  post_id    TEXT,
  actor      TEXT,
  result     TEXT,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_audit_time ON social_audit_log (created_at DESC);

ALTER TABLE social_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS social_audit_sel ON social_audit_log;
DROP POLICY IF EXISTS social_audit_ins ON social_audit_log;
CREATE POLICY social_audit_sel ON social_audit_log FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY social_audit_ins ON social_audit_log FOR INSERT TO anon, authenticated WITH CHECK (true);
REVOKE UPDATE, DELETE ON social_audit_log FROM anon, authenticated;

-- ── 5. Admin-gated automation settings ─────────────────────────────────────
CREATE OR REPLACE FUNCTION set_social_rule(
  p_admin_pin TEXT, p_event TEXT, p_action TEXT, p_threshold INTEGER DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT is_admin_pin(p_admin_pin) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Admin PIN is incorrect');
  END IF;
  IF p_event NOT IN ('new_product','price_change','restock','low_stock','sold_out') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown event');
  END IF;
  IF p_action NOT IN ('off','draft','publish','cancel') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown action');
  END IF;

  UPDATE social_automation_rules
     SET action = p_action,
         low_stock_threshold = COALESCE(p_threshold, low_stock_threshold),
         updated_at = now()
   WHERE event = p_event;

  INSERT INTO social_audit_log (action, result, detail)
  VALUES ('automation_changed', 'ok', p_event || ' -> ' || p_action);

  RETURN jsonb_build_object('success', true);
END;
$$;
GRANT EXECUTE ON FUNCTION set_social_rule(TEXT,TEXT,TEXT,INTEGER) TO anon, authenticated;

-- ── 6. Claim a post for publishing — the idempotency gate (§19) ─────────────
-- Returns the row ONLY if this call is the one that moved it into 'publishing'.
-- A refresh, a retry, a duplicate request or a restarted worker all lose the
-- race and get {claimed:false}, so a confirmed post is never published twice.
CREATE OR REPLACE FUNCTION claim_social_post(p_post_id TEXT)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_row social_posts%ROWTYPE;
BEGIN
  UPDATE social_posts
     SET status = 'publishing', retry_count = retry_count + 1
   WHERE id = p_post_id
     AND published_at IS NULL                 -- never re-publish a confirmed post
     AND external_post_id IS NULL
     AND status IN ('ready','scheduled','failed')
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM social_posts WHERE id = p_post_id;
    RETURN jsonb_build_object('claimed', false,
      'reason', COALESCE(v_row.status, 'not found'),
      'alreadyPublished', v_row.published_at IS NOT NULL);
  END IF;

  RETURN jsonb_build_object('claimed', true, 'post', row_to_json(v_row));
END;
$$;
GRANT EXECUTE ON FUNCTION claim_social_post(TEXT) TO anon, authenticated;

-- ── 7. Sold out: pull scheduled content (§15) ───────────────────────────────
-- Never let a queued post advertise something that is now out of stock.
CREATE OR REPLACE FUNCTION cancel_posts_for_sold_out(p_product_id TEXT)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
DECLARE v_n INTEGER;
BEGIN
  UPDATE social_posts
     SET status = 'cancelled',
         error = 'Cancelled automatically: product went out of stock'
   WHERE product_id = p_product_id
     AND status IN ('ready','scheduled','draft')
     AND published_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n > 0 THEN
    INSERT INTO social_audit_log (action, product_id, result, detail)
    VALUES ('posts_cancelled_sold_out', p_product_id, 'ok', v_n || ' post(s)');
  END IF;
  RETURN jsonb_build_object('success', true, 'cancelled', v_n);
END;
$$;
GRANT EXECUTE ON FUNCTION cancel_posts_for_sold_out(TEXT) TO anon, authenticated;

-- ── 8. Verification ────────────────────────────────────────────────────────
SELECT has_table_privilege('anon','social_connections','SELECT') AS anon_reads_tokens_should_be_false;
SELECT event, action FROM social_automation_rules ORDER BY event;
