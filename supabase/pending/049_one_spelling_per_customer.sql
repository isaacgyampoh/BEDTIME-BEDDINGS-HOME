-- ---------------------------------------------------------------------------
-- 049  One customer row per person.          *** NOT APPLIED — NEEDS APPROVAL
--
-- THE DEFECT
-- customers.phone is UNIQUE on the string exactly as it was typed, and every
-- write uses it as the conflict target:
--
--   INSERT INTO customers (phone, visit_count, total_spent, last_visit)
--   VALUES (v_order.customer_phone, 1, v_order.total, v_when)
--   ON CONFLICT (phone) DO UPDATE SET visit_count = visit_count + 1, ...
--
-- So '0553071224' and '553071224' are two different customers. Production
-- (4 November 2026) holds 982 customer rows for 946 real people: 537 rows are
-- stored with the leading zero, 444 without and 1 as +233. Thirty-six people
-- have their visit count and lifetime spend split across two records.
--
-- 0548124978 is really 11 visits and GHS 4,437. It reads as 8 visits /
-- GHS 2,905 in one row and 3 visits / GHS 1,532 in another, so the shop's
-- best customers do not look like its best customers.
--
-- WHAT THIS CHANGES, IN MONEY
-- Nothing is created or destroyed. The table's lifetime spend is GHS 527,110
-- before and GHS 527,110 after; GHS 60,755 of it moves onto the surviving
-- rows. 36 rows are deleted after their figures have been added to the row
-- that is kept. Sales, orders and receipts are not touched at all — this file
-- only reshapes the customers table, which is a summary of them.
--
-- The client-side half is already live: every write now normalises the number
-- first (src/lib/phone.js), so no new duplicate can be created. This file
-- merges what was already split and stops it at the database level too.
--
-- BEFORE RUNNING ANYTHING: take a backup you have restored from at least once.
-- Then run STEP 0 alone and read it. Steps 1-5 are the change.
-- ---------------------------------------------------------------------------

-- ── STEP 0 ── Dry run. Changes nothing. Run this first and check the figures
--              against what you expect before going further.
--
--   SELECT gh_phone(phone) AS line, count(*) AS rows_now,
--          string_agg(phone || ' (' || visit_count || 'v, GHS ' || total_spent || ')', '  +  ') AS split_as,
--          sum(visit_count) AS combined_visits, sum(total_spent) AS combined_spend
--     FROM customers
--    GROUP BY gh_phone(phone)
--   HAVING count(*) > 1
--    ORDER BY sum(total_spent) DESC;
--
-- (gh_phone is created by STEP 1, so run STEP 1 before STEP 0.)

BEGIN;

-- ── STEP 1 ── One definition of a Ghanaian number, matching src/lib/phone.js.
--              IMMUTABLE so it can be used in an index.
CREATE OR REPLACE FUNCTION gh_phone(raw TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(d) = 9 THEN '0' || d
    ELSE btrim(COALESCE(raw, ''))      -- not a Ghanaian mobile: leave it alone
  END
  FROM (
    SELECT regexp_replace(
             regexp_replace(regexp_replace(COALESCE(raw, ''), '\D', '', 'g'),
                            '^(00233|233)', ''),
             '^0', '') AS d
  ) s;
$$;

-- ── STEP 2 ── Add every duplicate's figures into the row that is kept.
--              The row kept is the lowest id, so the choice is deterministic
--              and re-running this file is harmless.
--
--              NOTE ON ORDER: this step deliberately does NOT touch `phone`.
--              An earlier version normalised it here and failed outright:
--
--                ERROR: duplicate key value violates unique constraint
--                       "customers_phone_key"
--                DETAIL: Key (phone)=(0556882609) already exists.
--
--              because setting the survivor's number to its normalised form
--              collides with the duplicate that has not been deleted yet.
--              The number is normalised in STEP 4, once the other row is
--              gone. Found by running this file against a local copy of the
--              real 982 rows; the whole file is one transaction, so the
--              failure left that table exactly as it was.
WITH grouped AS (
  SELECT gh_phone(phone) AS line,
         min(id)                AS keep_id,
         sum(visit_count)       AS visits,
         sum(total_spent)       AS spent,
         max(last_visit)        AS seen
    FROM customers
   GROUP BY gh_phone(phone)
  HAVING count(*) > 1
)
UPDATE customers c
   SET visit_count = g.visits,
       total_spent = g.spent,
       last_visit  = g.seen
  FROM grouped g
 WHERE c.id = g.keep_id;

-- ── STEP 3 ── Remove the rows whose figures have just been folded in.
--              Nothing references customers.id, so no row elsewhere is
--              orphaned by this; sales and orders carry the phone as text.
DELETE FROM customers c
 USING (
   SELECT gh_phone(phone) AS line, min(id) AS keep_id
     FROM customers GROUP BY gh_phone(phone) HAVING count(*) > 1
 ) g
 WHERE gh_phone(c.phone) = g.line AND c.id <> g.keep_id;

-- ── STEP 4 ── Store every remaining number in the one form, so the existing
--              UNIQUE(phone) constraint starts doing the job it looks like it
--              is already doing. Rows that are not Ghanaian mobiles are
--              returned unchanged by gh_phone and so are left as they are.
UPDATE customers SET phone = gh_phone(phone) WHERE phone <> gh_phone(phone);

-- ── STEP 5 ── Normalise on the way in, whatever the caller passes.
--
--              THIS STEP IS NOT OPTIONAL, AND IT MUST COME BEFORE STEP 6.
--              process_wa_order inserts the order's phone as it was stored:
--
--                INSERT INTO customers (phone, ...) VALUES (v_order.customer_phone, ...)
--                ON CONFLICT (phone) DO UPDATE SET visit_count = visit_count + 1, ...
--
--              Five unprocessed orders still hold a number in another form —
--              '+233546959204', '050 292 0852' — and one of them is PAID. With
--              the unique index of STEP 6 but without this trigger, inserting
--              '+233546959204' when '0546959204' already exists raises a
--              uniqueness error on customers_line_key, which ON CONFLICT
--              (phone) does not arbitrate and therefore does not catch. The
--              whole of process_wa_order would abort: the cashier could not
--              book a sale the customer had already paid for.
--
--              Normalising in a BEFORE trigger makes the inserted value equal
--              the stored one, so ON CONFLICT (phone) finds the existing row
--              and increments it as intended. BEFORE INSERT triggers fire
--              ahead of conflict detection, which is what makes this work;
--              verified against a local copy of the real table rather than
--              assumed.
CREATE OR REPLACE FUNCTION customers_normalise_phone() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone := gh_phone(NEW.phone);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_normalise_phone_trg ON customers;
CREATE TRIGGER customers_normalise_phone_trg
  BEFORE INSERT OR UPDATE OF phone ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_normalise_phone();

-- ── STEP 6 ── Make the rule hold even if a future write forgets. The column
--              is already UNIQUE; this enforces uniqueness of the LINE, which
--              is the thing that should be unique.
CREATE UNIQUE INDEX IF NOT EXISTS customers_line_key ON customers (gh_phone(phone));

COMMIT;

-- ── Verification, to run afterwards ─────────────────────────────────────────
--   SELECT count(*) FROM customers;                         -- expect 946
--   SELECT sum(total_spent) FROM customers;                 -- expect 527110.00
--   SELECT count(*) FROM (SELECT gh_phone(phone) FROM customers
--                          GROUP BY 1 HAVING count(*) > 1) x;  -- expect 0
