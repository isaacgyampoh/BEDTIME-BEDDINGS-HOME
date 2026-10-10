-- ---------------------------------------------------------------------------
-- 046  The daily reports now go to 0548124978 — exempt it from the SMS cap.
--
-- claim_sms (029) caps a number at 4 messages per 10 minutes and 12 per day.
-- That is right for a customer's phone and wrong for the shop's own line,
-- which receives the scheduled reports and an alert for every online payment.
-- 029 exempted 599084552. Changing the recipient without adding the new number
-- would quietly reintroduce exactly the failure 029 was written to stop: the
-- cap is reached, claim_sms says no, and the owner simply stops being told.
--
-- The old line stays exempt: it still receives the per-order payment alerts,
-- which are a different notification and were not part of this change.
-- Numbers are stored as the last 9 digits, which is how claim_sms matches.
-- ---------------------------------------------------------------------------

INSERT INTO sms_exempt_numbers (phone, label)
VALUES ('548124978', 'Shop / owner line (daily reports from Oct 2026)')
ON CONFLICT (phone) DO UPDATE SET label = EXCLUDED.label;
