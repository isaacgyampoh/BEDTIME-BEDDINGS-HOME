-- ===========================================================================
-- 053 — Retire the WhatsApp AI agent's own tables
--
-- WHAT THIS TOUCHES: wa_conversations and wa_messages. Nothing else.
--
-- WHY IT IS SAFE
--
-- Both tables are EMPTY (0 rows each, checked 24 November 2026) and carry no
-- business history. They occupy 56 kB and 32 kB of empty structure.
--
-- Verified before writing this, against production:
--   * no cron job references hyper-service, wa-agent or whatsapp-bot
--     (all 16 active jobs are SMS/report/reminder/tiktok jobs)
--   * no database function or trigger mentions the agent, WaSender or OpenAI
--   * no trigger exists on either table
--   * the hyper-service deployment has been deleted; its endpoint returns 404
--
-- WHAT THIS MUST NOT TOUCH
--
-- whatsapp_orders is NOT an agent table despite the name. It holds 656 rows
-- and is the live orders table: USSD, NaloPay settlement, payment
-- reconciliation and the admin WhatsApp Orders page all read it. It stays.
--
-- Customer records, product images and order data are untouched here.
--
-- APPLYING THIS IS OPTIONAL
--
-- Hosted Supabase is being retired in favour of the Contabo instance, and the
-- Bedtime schema built there simply does not include these two tables -- so
-- the retirement completes itself at cutover without a destructive drop on
-- the live system. Apply this only if you want them gone from Supabase before
-- then. DROP TABLE cannot be undone; the empty structure costs nothing.
-- ===========================================================================

BEGIN;

-- Refuse to run if either table has gained rows since this was written.
DO $$
DECLARE c bigint;
BEGIN
  SELECT count(*) INTO c FROM wa_conversations;
  IF c > 0 THEN
    RAISE EXCEPTION 'wa_conversations has % rows -- refusing. It was empty when 053 was written; something is writing to it.', c;
  END IF;
  SELECT count(*) INTO c FROM wa_messages;
  IF c > 0 THEN
    RAISE EXCEPTION 'wa_messages has % rows -- refusing. It was empty when 053 was written; something is writing to it.', c;
  END IF;
END $$;

DROP POLICY IF EXISTS "staff read conversations"   ON wa_conversations;
DROP POLICY IF EXISTS "staff update conversations" ON wa_conversations;
DROP POLICY IF EXISTS "staff read messages"        ON wa_messages;

DROP TABLE IF EXISTS wa_messages;
DROP TABLE IF EXISTS wa_conversations;

COMMIT;

-- Afterwards, whatsapp_orders must still be present with its rows intact:
--   SELECT count(*) FROM whatsapp_orders;   -- expect 656 or more
