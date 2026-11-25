/**
 * Did a data query fail because the till is not signed in any more?
 *
 * WHY THIS MATTERS MORE THAN IT USED TO
 *
 * Every loader in the store returns [] on error. That is right for a flaky
 * network and wrong for an expired session: the screen then shows an empty
 * till, an empty receipts list and a reports page of zeroes, with nothing
 * said. It is indistinguishable from a quiet day -- which is exactly what was
 * reported on 25 November 2026, where the order counts rendered from one
 * query while the list beneath them came back empty from another.
 *
 * Until migrations 043 and 055 the anonymous key could read sales, customers
 * and orders, so an unauthenticated till still showed data and a missing
 * session went unnoticed. Those reads are closed now, so a lost session shows
 * up as emptiness unless something names it.
 *
 * Deliberately NOT treated as auth failures: network errors, missing columns,
 * and 5xx. Telling a cashier to sign in again when the server is merely down
 * sends them round a loop that cannot help.
 */
const AUTH_CODES = new Set(['PGRST301', '42501', '401'])

export function isAuthFailure(error) {
  if (!error) return false
  const code = String(error.code ?? error.status ?? '')
  if (AUTH_CODES.has(code)) return true
  const msg = String(error.message || '').toLowerCase()
  return msg.includes('jwt') ||
         msg.includes('permission denied') ||
         msg.includes('not authorized') ||
         msg.includes('unauthorized')
}
