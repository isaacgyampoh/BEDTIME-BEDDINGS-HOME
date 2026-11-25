import { suite } from './harness.mjs'
import { isAuthFailure } from '../src/lib/authFailure.js'

const t = suite('A lost session is reported, not rendered as an empty shop')

/**
 * Every loader returns [] on error. That is right for a flaky network and
 * wrong for an expired session: the till then shows no orders, no receipts
 * and zeroed reports, which is indistinguishable from a quiet day.
 *
 * It only became visible once migrations 043 and 055 closed anonymous reads.
 * Before them an unauthenticated till still showed data, so a missing session
 * went unnoticed. These cases are the difference between the two.
 */
t.ok('PostgREST JWT rejection', isAuthFailure({ code: 'PGRST301' }))
t.ok('insufficient privilege', isAuthFailure({ code: '42501' }))
t.ok('a bare 401 status', isAuthFailure({ status: 401 }))
t.ok('permission denied text', isAuthFailure({ message: 'permission denied for table whatsapp_orders' }))
t.ok('expired JWT text', isAuthFailure({ message: 'JWT expired' }))
t.ok('unauthorized text', isAuthFailure({ message: 'Unauthorized' }))

t.ok('a network timeout is NOT an auth failure', !isAuthFailure({ message: 'fetch failed' }))
t.ok('a missing column is NOT an auth failure', !isAuthFailure({ code: '42703', message: 'column does not exist' }))
t.ok('a 500 is NOT an auth failure', !isAuthFailure({ status: 500, message: 'internal error' }))
t.ok('no error at all is not a failure', !isAuthFailure(null))
t.ok('undefined is not a failure', !isAuthFailure(undefined))
