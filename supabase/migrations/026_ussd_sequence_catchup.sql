-- ============================================================================
-- 026: Move ussd_code_seq past the codes already in use
--
-- Codes were assigned client-side with "max + 1" for a long time, which ran
-- ahead of the sequence. Now that both the POS and the storefront let the
-- database assign them, the sequence starts handing out numbers that existing
-- orders already hold — and a duplicate USSD code means a customer dialling
-- *920*141*<code># can pay against somebody else's order.
--
-- Observed on production: highest code in use 50018, sequence returned 50010.
-- ============================================================================

SELECT setval(
  'ussd_code_seq',
  GREATEST(
    (SELECT COALESCE(MAX(ussd_code), 50000) FROM whatsapp_orders),
    (SELECT last_value FROM ussd_code_seq)
  ) + 1,
  false
);

-- No two live orders may share a code.
SELECT ussd_code, count(*) AS orders
  FROM whatsapp_orders
 WHERE ussd_code IS NOT NULL
 GROUP BY ussd_code HAVING count(*) > 1
 ORDER BY ussd_code;

SELECT (SELECT MAX(ussd_code) FROM whatsapp_orders) AS max_in_use,
       (SELECT last_value FROM ussd_code_seq)       AS sequence_now;
