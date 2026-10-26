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
