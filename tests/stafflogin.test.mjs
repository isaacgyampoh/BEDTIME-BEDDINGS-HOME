import { suite } from './harness.mjs'
import { classifyStaffLogin, sessionLanded } from '../src/lib/staffLogin.js'

const t = suite('A sign-in that minted no session cannot pass as a real one')

/**
 * The bug these pin down cost Bedtime a trading day.
 *
 * GoTrue answers a CORS preflight naming any request header with a bare 204
 * and no Access-Control-* headers, so supabase-js could not GET /auth/v1/user
 * and setSession() discarded every session it was handed. staff-login minted
 * 44 real sessions server-side; the browser kept none. Login fell back to a
 * bare verify_pin and signed the cashier into a till running on the public
 * anon key -- reports at GHS 0.00, no receipts, 480 denials on
 * whatsapp_orders, and nothing raising an error, because PostgREST answers an
 * RLS-denied SELECT with 200 and zero rows.
 */

// --- what the reply says about the PIN -------------------------------------
t.eq('a session in hand is acceptance', 'accepted',
  classifyStaffLogin({ success: true, session: { access_token: 'a', refresh_token: 'r' } }))

t.eq('success:false is a real verdict on the PIN', 'rejected',
  classifyStaffLogin({ success: false, error: 'Incorrect PIN' }))

// The router's "unknown action" reply has no `success` key. Treating that as a
// wrong PIN tells a cashier their correct PIN is wrong, every time, forever.
t.eq('an unknown action is infrastructure, not a wrong PIN', 'infrastructure',
  classifyStaffLogin({ error: 'Use ?action=initialize, charge, verify, ussd...' }))

t.eq('an HTML error page is infrastructure', 'infrastructure', classifyStaffLogin(null))
t.eq('an empty reply is infrastructure', 'infrastructure', classifyStaffLogin({}))
t.eq('a gateway 5xx shape is infrastructure', 'infrastructure',
  classifyStaffLogin({ message: 'Bad Gateway' }))

// success:true but no session is NOT acceptance -- there is nothing to store.
t.eq('success without a session is not acceptance', 'infrastructure',
  classifyStaffLogin({ success: true }))

// --- did the session actually land? ----------------------------------------
t.ok('a stored session with a token has landed',
  sessionLanded({ data: { session: { access_token: 'abc' } } }))

t.ok('setSession reporting no error but storing nothing has NOT landed',
  !sessionLanded({ data: { session: null } }))

t.ok('an empty data envelope has not landed', !sessionLanded({ data: {} }))
t.ok('a session object with no access token has not landed',
  !sessionLanded({ data: { session: { refresh_token: 'r' } } }))
t.ok('an undefined result has not landed', !sessionLanded(undefined))
t.ok('an error-shaped result has not landed',
  !sessionLanded({ data: null, error: { message: 'Failed to fetch' } }))
