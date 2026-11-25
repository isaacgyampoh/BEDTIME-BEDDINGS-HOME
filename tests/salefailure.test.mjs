import { suite } from './harness.mjs'
import { saleFailureMessage } from '../src/lib/saleFailure.js'

const t = suite('A sale that was not recorded never reads like a glitch')

/**
 * This POS has no offline sale queue: record_sale is a round trip, and if it
 * does not come back the sale does not exist. That is deliberate -- queueing
 * sales locally would let two tills each sell the last unit -- but it puts all
 * the weight on the message, because the cashier reading it is standing in
 * front of a customer holding the goods.
 *
 * The old text was `Error: ` + whatever the engine said: "Load failed" in
 * Safari, "Failed to fetch" in Chrome. Both read like something to dismiss.
 */

const says = (msg, ...bits) => bits.every(b => msg.toLowerCase().includes(b.toLowerCase()))

// --- it must always say the sale did NOT happen ---------------------------
const cases = [
  ['offline', new Error('Load failed'), false],
  ['Safari network failure', new Error('Load failed'), true],
  ['Chrome network failure', new Error('Failed to fetch'), true],
  ['Firefox network failure', new Error('NetworkError when attempting to fetch resource'), true],
  ['a timeout', new Error('The operation timed out'), true],
  ['an aborted request', new Error('The user aborted a request'), true],
  ['an unknown server fault', new Error('500 Internal Server Error'), true],
  ['no message at all', new Error(''), true],
  ['a non-Error value', 'something odd', true],
]

for (const [name, err, online] of cases) {
  const msg = saleFailureMessage(err, online)
  t.ok(`${name}: says the sale was NOT saved`, says(msg, 'NOT saved'))
  t.ok(`${name}: tells the cashier the cart is kept`, says(msg, 'cart is kept'))
}

// --- and it must never imply success --------------------------------------
for (const [name, err, online] of cases) {
  const msg = saleFailureMessage(err, online).toLowerCase()
  t.ok(`${name}: never says done/success/complete`,
    !/\b(done|success|successful|completed|saved successfully)\b/.test(msg))
}

// --- the offline case is named plainly, not as a browser error ------------
t.ok('offline is reported as no internet, not "Load failed"',
  says(saleFailureMessage(new Error('Load failed'), false), 'No internet') &&
  !saleFailureMessage(new Error('Load failed'), false).includes('Load failed'))

t.ok('an online network failure blames the server, not the connection',
  says(saleFailureMessage(new Error('Failed to fetch'), true), 'Could not reach the server'))

// --- a real server message is still passed through, so faults stay visible -
t.ok('an unrecognised fault keeps its original text',
  saleFailureMessage(new Error('insufficient stock for SKU 12'), true).includes('insufficient stock for SKU 12'))
