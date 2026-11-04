-- ---------------------------------------------------------------------------
-- 050  One order per payment reference.      *** NOT APPLIED — NEEDS APPROVAL
--
-- THE DEFECT
-- whatsapp_orders.paystack_ref is indexed but not unique, and the webhook
-- creates an order when it finds none carrying the reference. Two deliveries
-- of the same event can therefore both find nothing and both insert: one
-- payment, two orders, stock deducted twice and the customer messaged twice.
--
-- Paystack retries a webhook until it receives a 2xx and may deliver the same
-- event more than once, so this is a matter of timing rather than bad luck.
--
-- The handler has been fixed to look the reference up without `.single()`
-- (which raised an error on more than one match, and the error was discarded,
-- so the first duplicate made every later delivery create another), to refuse
-- an amount that does not settle the order, and to settle only a row that is
-- still unsettled. That closes the sequential case. This file closes the
-- concurrent one, which no amount of application code can.
--
-- WHAT THIS CHANGES, IN DATA
-- Nothing is deleted and no money moves. 33 orders carry paystack_ref = ''
-- (an empty string rather than NULL), which is why a uniqueness check could
-- not simply be added: all 33 would collide with each other. They are set to
-- NULL first, which is what "no reference" should always have meant — and it
-- also repairs `paystack_ref IS NULL` filters, which those 33 rows escape
-- today.
--
-- Checked against production on 4 November 2026: 530 orders carry a
-- reference, and once the empty strings are NULL no two orders share one, so
-- the index can be created without a single conflict.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── STEP 1 ── "No reference" means NULL, not an empty string.
UPDATE whatsapp_orders SET paystack_ref = NULL
 WHERE paystack_ref IS NOT NULL AND btrim(paystack_ref) = '';

-- ── STEP 2 ── One order per reference. Partial, so the many orders that have
--              no reference at all are not competing for a single NULL slot
--              (Postgres permits repeated NULLs in a unique index anyway; the
--              predicate documents the intent and keeps the index small).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_orders_paystack_ref_key
    ON whatsapp_orders (paystack_ref)
 WHERE paystack_ref IS NOT NULL;

-- ── STEP 3 ── Every payment notification, kept whether or not it settled
--              anything.
--
--              Today a failed or mismatched payment leaves no trace: 263
--              orders carry a reference and were never paid, and there is no
--              way to tell which of those were attempted and declined from
--              which were never attempted. That is also the difference
--              between a customer worth chasing and one who has given up.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id            TEXT PRIMARY KEY DEFAULT short_id(),
  order_id      TEXT REFERENCES whatsapp_orders(id) ON DELETE SET NULL,
  order_no      TEXT,
  provider      TEXT NOT NULL,            -- paystack | nalopay | moolre | hubtel
  provider_ref  TEXT,
  event         TEXT,                     -- charge.success, charge.failed, ...
  outcome       TEXT NOT NULL,            -- settled | duplicate | underpaid | failed | review | orphan
  amount_minor  BIGINT,                   -- pesewas, as the provider sent it
  owed_minor    BIGINT,                   -- pesewas the order was for
  detail        TEXT,
  raw           JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_attempts_order_idx   ON payment_attempts (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_ref_idx     ON payment_attempts (provider_ref);
CREATE INDEX IF NOT EXISTS payment_attempts_outcome_idx ON payment_attempts (outcome, created_at DESC);

-- A notification arriving twice must not be logged twice either.
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_event_key
    ON payment_attempts (provider, provider_ref, event)
 WHERE provider_ref IS NOT NULL AND event IS NOT NULL;

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;

-- Only the service role writes here (the webhook), and only signed-in staff
-- read it. It holds amounts and references, so it is not public: this is
-- deliberately NOT given an `anon` policy, unlike the older tables that 043
-- is waiting to close.
DROP POLICY IF EXISTS payment_attempts_select ON payment_attempts;
CREATE POLICY payment_attempts_select ON payment_attempts FOR SELECT TO authenticated USING (true);

COMMIT;

-- ── Verification, to run afterwards ─────────────────────────────────────────
--   SELECT count(*) FROM whatsapp_orders WHERE btrim(COALESCE(paystack_ref,'')) = '' AND paystack_ref IS NOT NULL;  -- 0
--   SELECT count(*) FROM (SELECT paystack_ref FROM whatsapp_orders
--                          WHERE paystack_ref IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x;                        -- 0
--   SELECT count(*) FROM payment_attempts;                                                                          -- 0, it starts empty
