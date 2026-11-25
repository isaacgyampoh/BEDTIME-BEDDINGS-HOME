/**
 * The two decisions in a staff sign-in, kept pure so they can be tested
 * without pulling supabase-js into Node.
 *
 * Both of them have already been got wrong in production, in ways that looked
 * like anything except an authentication problem.
 */

/**
 * What does `staff-login`'s reply actually tell us about the PIN?
 *
 * Only a reply that carries `success: false` is a verdict on the PIN. Anything
 * else -- a router that does not know this action because the function has not
 * been deployed, a gateway error, an HTML error page -- is an infrastructure
 * failure, and the caller must fall back to verify_pin rather than tell a
 * cashier their correct PIN is wrong. The router's own "unknown action" reply
 * has no `success` key at all, which is exactly the case this separates.
 *
 * @returns {'accepted'|'rejected'|'infrastructure'}
 */
export function classifyStaffLogin(res) {
  if (res && res.success === true && res.session) return 'accepted'
  if (res && typeof res.success === 'boolean' && res.success === false) return 'rejected'
  return 'infrastructure'
}

/**
 * Did a session actually end up in storage?
 *
 * `setSession()` does not simply store what it is handed: it fetches
 * GET /auth/v1/user to populate the session, and discards the session if that
 * call fails. On the self-hosted platform that call was blocked by CORS for
 * eleven hours after cutover -- GoTrue answers a preflight naming any request
 * header with a bare 204 and no Access-Control-* headers -- so `staff-login`
 * minted 44 real sessions and the browser kept none of them.
 *
 * Reporting success there put the till on the public anon key: reports at
 * GHS 0.00, no receipts, 480 denials on whatsapp_orders, and no error anywhere,
 * because PostgREST answers an RLS-denied SELECT with 200 and zero rows.
 *
 * So never infer a session from the call that was supposed to create one. Read
 * it back.
 */
export function sessionLanded(getSessionResult) {
  return !!getSessionResult?.data?.session?.access_token
}
