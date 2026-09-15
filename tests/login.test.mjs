import { suite } from './harness.mjs'
const t = suite('PIN login: session exchange and fallback')

// startStaffSession() decides, from one JSON body, whether the server has
// judged the PIN or whether something is simply unavailable. Getting this
// wrong is not cosmetic: treating "I do not know that action" as a wrong PIN
// shows the cashier a router error and refuses to fall back, which locks the
// till out of the system entirely. That shipped once — this is the guard.
//
// Mirrors the branch in src/lib/supabase.js. A real rejection must carry an
// explicit boolean `success: false`; anything else means fall back.
const verdict = (res) => {
  if (res?.success && res?.session) return { ok: true, error: null }
  const rejected = typeof res?.success === 'boolean' && res.success === false
  return { ok: false, error: rejected ? (res.error || 'Incorrect PIN') : null }
}
const fallsBack = (res) => { const v = verdict(res); return !v.ok && v.error === null }

// The exact body the deployed router returns for an action it does not know.
// If the function has not been deployed yet, every login takes this path.
t.ok('undeployed action falls back',
  fallsBack({ error: 'Use ?action=initialize, charge, verify, ussd, webhook, report, remind, or resend-sms' }))

t.ok('network failure (null) falls back', fallsBack(null))
t.ok('undefined falls back', fallsBack(undefined))
t.ok('empty object falls back', fallsBack({}))
t.ok('gateway 500 shape falls back', fallsBack({ message: 'Internal Server Error' }))
t.ok('an HTML error page parsed to nothing falls back', fallsBack({ 0: '<' }))
t.ok('success:true but no session falls back', fallsBack({ success: true }))

// A real verdict must NOT fall back — retrying against verify_pin would spend
// a second attempt against the throttle for one wrong entry.
t.eq('wrong PIN is reported, not retried', verdict({ success: false, error: 'Incorrect PIN' }).error, 'Incorrect PIN')
t.eq('throttle message is passed through',
  verdict({ success: false, error: 'Too many attempts. Wait 60 seconds.' }).error,
  'Too many attempts. Wait 60 seconds.')
t.eq('success:false with no message still reads as a rejection',
  verdict({ success: false }).error, 'Incorrect PIN')
t.ok('a rejection never falls back', !fallsBack({ success: false, error: 'Incorrect PIN' }))

// The happy path.
const good = { success: true, id: 's1', name: 'Ama', role: 'Admin', session: { access_token: 'a', refresh_token: 'r' } }
t.ok('a session is accepted', verdict(good).ok)
t.eq('an accepted session reports no error', verdict(good).error, null)
