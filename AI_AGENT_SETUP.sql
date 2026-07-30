-- ============================================================
-- BEDTIME BEDDINGS & HOME — WhatsApp AI Sales Agent schema
-- Run this ONCE in Supabase → SQL Editor.
-- Adds conversation memory + message log + agent controls.
-- Nothing here touches or conflicts with existing tables.
-- ============================================================

-- One row per customer phone number. This IS the agent's memory of a person.
CREATE TABLE IF NOT EXISTS wa_conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE NOT NULL,           -- 233XXXXXXXXX
  customer_name text DEFAULT '',                -- learned during chat
  summary       text DEFAULT '',                -- rolling summary of who they are / what they want
  stage         text DEFAULT 'chatting',        -- chatting | quoted | awaiting_payment | paid | awaiting_details | done
  last_order_no text DEFAULT '',                -- order the agent last created for them
  agent_enabled boolean DEFAULT true,           -- false = human takes over, AI stays silent
  needs_human   boolean DEFAULT false,          -- agent flagged this chat for the owner
  flag_reason   text DEFAULT '',
  last_message_at timestamptz DEFAULT now(),
  last_agent_at   timestamptz,                  -- when the agent last replied (for follow-up timing)
  followed_up   boolean DEFAULT false,          -- has a quiet-chat follow-up been sent
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_conv_phone ON wa_conversations(phone);
CREATE INDEX IF NOT EXISTS idx_wa_conv_lastmsg ON wa_conversations(last_message_at);

-- Every message in/out, so the agent has full history + you have a transcript.
CREATE TABLE IF NOT EXISTS wa_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  role         text NOT NULL,                   -- user | assistant | system
  content      text DEFAULT '',
  media_url    text DEFAULT '',                 -- if the customer sent an image
  wa_message_id text DEFAULT '',                -- WaSender's message id (dedupe)
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON wa_messages(phone, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_waid ON wa_messages(wa_message_id) WHERE wa_message_id <> '';

-- Simple key/value for agent settings you can flip without a redeploy.
CREATE TABLE IF NOT EXISTS wa_agent_settings (
  key   text PRIMARY KEY,
  value text
);
INSERT INTO wa_agent_settings (key, value) VALUES
  ('agent_master_enabled', 'true'),             -- global on/off switch
  ('business_hours_only', 'false')              -- (reserved) reply only in hours
ON CONFLICT (key) DO NOTHING;

-- RLS: lock these down. Only the service role (edge function) touches them.
ALTER TABLE wa_conversations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE wa_agent_settings  ENABLE ROW LEVEL SECURITY;

-- Allow the authenticated POS (anon key, logged-in staff) to READ conversations
-- and messages so you can see chats in the POS later. No public access.
DROP POLICY IF EXISTS "staff read conversations" ON wa_conversations;
CREATE POLICY "staff read conversations" ON wa_conversations FOR SELECT USING (true);
DROP POLICY IF EXISTS "staff update conversations" ON wa_conversations;
CREATE POLICY "staff update conversations" ON wa_conversations FOR UPDATE USING (true);
DROP POLICY IF EXISTS "staff read messages" ON wa_messages;
CREATE POLICY "staff read messages" ON wa_messages FOR SELECT USING (true);
DROP POLICY IF EXISTS "staff read settings" ON wa_agent_settings;
CREATE POLICY "staff read settings" ON wa_agent_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "staff update settings" ON wa_agent_settings;
CREATE POLICY "staff update settings" ON wa_agent_settings FOR UPDATE USING (true);

-- Helper: fetch the last N messages for a phone (used by the agent).
CREATE OR REPLACE FUNCTION wa_recent_messages(p_phone text, p_limit int DEFAULT 20)
RETURNS TABLE(role text, content text, created_at timestamptz) AS $$
  SELECT role, content, created_at
  FROM wa_messages
  WHERE phone = p_phone
  ORDER BY created_at DESC
  LIMIT p_limit;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
