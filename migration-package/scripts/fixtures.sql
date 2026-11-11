-- Fixtures for exec-functions.sh. Disposable database only; every id is
-- prefixed so they can never be confused with a real order.
DELETE FROM whatsapp_orders WHERE id LIKE 'fx-%';
INSERT INTO whatsapp_orders (id, order_no, date, customer_name, customer_phone, items, subtotal, total, status, ussd_code, notes, source, paystack_ref, paid_at) VALUES
 ('fx-r1',   'FX-R1',    now() - interval '7 minutes',  'Ama Fixture',   '0548124978','[]'::jsonb,100,100,'Pending',  1001,'','web',NULL,NULL),
 ('fx-r3',   'FX-R3',    now() - interval '90 minutes', 'Esi Fixture',   '0548124970','[]'::jsonb,300,300,'Pending',  1003,'','web',NULL,NULL),
 ('fx-lower','FX-LOWER', now() - interval '90 minutes', 'Lower Fixture', '0548124974','[]'::jsonb,800,800,'pending',  1008,'','web',NULL,NULL),
 ('fx-paid', 'FX-PAID',  now() - interval '90 minutes', 'Paid Fixture',  '0548124975','[]'::jsonb,900,900,'Pending',  1009,'','web',NULL, now() - interval '80 minutes'),
 ('fx-pay1', 'FX-PAY1',  now(),                         'Pay One',       '0548124978','[]'::jsonb,770,770,'Pending',  NULL,'','web','fx-ref-unpaid-1',  NULL),
 ('fx-pay2', 'FX-PAY2',  now(),                         'Pay Two',       '0548124979','[]'::jsonb,500,500,'Paid',     NULL,'','web','fx-ref-settled-2', now()),
 ('fx-pay3', 'FX-PAY3',  now(),                         'Pay Three',     '0548124970','[]'::jsonb,300,300,'cancelled',NULL,'','web','fx-ref-cancelled-3',NULL);
