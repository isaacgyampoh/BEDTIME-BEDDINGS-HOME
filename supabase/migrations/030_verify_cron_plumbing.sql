-- ============================================================================
-- 030: Prove the cron plumbing actually reaches the function
--
-- The jobs are scheduled and the endpoint delivers when called by hand, but
-- those are two different things: pg_net has to be enabled and able to reach
-- the function from inside the database. Fire one real report through exactly
-- the path cron uses, so a delivered SMS confirms the whole chain.
-- ============================================================================

SELECT private.call_edge('/sms-reports?type=test');

-- Give pg_net a moment, then show what came back.
SELECT pg_sleep(4);

SELECT status_code, left(COALESCE(content, ''), 120) AS response
  FROM net._http_response ORDER BY created DESC LIMIT 3;
