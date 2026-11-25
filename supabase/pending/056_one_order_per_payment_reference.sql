-- ===========================================================================
-- 056 — One order per payment reference
--
-- Found by the production audit, 25 November 2026: nothing stopped two orders
-- carrying the same payment reference. The settlement path has guards in code
-- (a settled order is not settled twice, and the 23-case webhook regression
-- covers duplicate delivery), but the database itself would have accepted it.
-- Defence in depth for money is worth having in the schema, not only in a
-- function that could be redeployed wrongly.
--
-- WHY A PARTIAL INDEX AND NOT A UNIQUE CONSTRAINT
--
-- 37 orders carry paystack_ref = '' -- the empty string, not NULL -- because
-- they were never given a provider reference at all: walk-ins, cancellations
-- and manually completed orders. A plain UNIQUE would reject the lot, so the
-- index covers only references that actually exist.
--
-- Verified before writing this: 627 real references, 627 distinct. Nothing in
-- the live data violates it, so it applies without a rewrite and without
-- touching a single financial record. The empty strings are left exactly as
-- they are -- normalising them to NULL would be editing history to tidy a
-- column, which is not worth the risk.
--
-- Supersedes the paystack_ref half of the older, unapplied pending/050.
-- ===========================================================================

BEGIN;

-- Refuse if the data has changed since this was checked, rather than failing
-- halfway with a confusing index error.
DO $$
DECLARE dupes bigint;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT paystack_ref FROM whatsapp_orders
    WHERE paystack_ref IS NOT NULL AND btrim(paystack_ref) <> ''
    GROUP BY paystack_ref HAVING count(*) > 1) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION
      'Refusing: % payment reference(s) are already used by more than one order. Investigate those before enforcing uniqueness.',
      dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_orders_paystack_ref_unique
  ON public.whatsapp_orders (paystack_ref)
  WHERE paystack_ref IS NOT NULL AND btrim(paystack_ref) <> '';

COMMIT;

-- Verify:
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'whatsapp_orders_paystack_ref_unique';
--   -- and that inserting a second order with an existing reference now fails.
