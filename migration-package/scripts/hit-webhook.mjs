/** Exercise the payment webhook as Paystack would, with correctly signed bodies. */
import { createHmac } from 'node:crypto'
// From the environment, and it MUST match what the function was started with.
// It was hardcoded, the runner passed a different value, every request came
// back 401 "invalid signature", and because this script asserted nothing the
// suite still printed "all checks passed". A harness that cannot fail is
// worse than no harness.
const SECRET = process.env.PAYSTACK_SECRET_KEY
if (!SECRET) { console.error('  PAYSTACK_SECRET_KEY is not set'); process.exit(2) }
const URL_ = process.env.FN_URL || 'http://localhost:8000/'
const sign = (b) => createHmac('sha512', SECRET).update(b).digest('hex')

let failures = 0
/** @param expect one of: refused | review | duplicate | settled | received */
async function post(label, payload, { badSig = false, noSig = false, expect } = {}) {
  const body = JSON.stringify(payload)
  const headers = { 'Content-Type': 'application/json' }
  if (!noSig) headers['x-paystack-signature'] = badSig ? 'f'.repeat(128) : sign(body)
  const r = await fetch(URL_, { method: 'POST', body, headers })
  let j; try { j = await r.json() } catch { j = {} }
  const verdict = j.review ? `review: ${j.review.reason}`
    : j.duplicate ? 'duplicate, nothing changed'
    : j.success ? `settled ${j.order || ''} (${j.settled || ''})`
    : j.error ? `refused: ${j.error}`
    : j.received ? 'received' : JSON.stringify(j).slice(0, 70)
  const kind = j.review ? 'review' : j.duplicate ? 'duplicate'
            : j.success ? 'settled' : j.error ? 'refused'
            : j.received ? 'received' : 'unknown'
  const good = !expect || kind === expect
  if (!good) failures++
  console.log(`  ${good ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label.padEnd(42)} HTTP ${r.status}  ${verdict}${good ? '' : `   EXPECTED ${expect}`}`)
  return { status: r.status, json: j, kind }
}

const charge = (ref, amountMinor) => ({
  event: 'charge.success',
  data: { reference: ref, amount: amountMinor, paid_at: '2026-11-10T20:00:00Z',
          customer: { phone: '0548124978', first_name: 'Pay' }, metadata: {} },
})

console.log('\nSIGNATURE')
await post('no signature at all',            charge('fx-ref-unpaid-1', 77000), { noSig: true, expect: 'refused' })
await post('a wrong signature',              charge('fx-ref-unpaid-1', 77000), { badSig: true, expect: 'refused' })
await post('an event that is not a charge',  { event: 'charge.failed', data: { reference: 'x' } }, { expect: 'received' })

console.log('\nAMOUNT')
await post('GHS 1 against a GHS 770 order',  charge('fx-ref-unpaid-1', 100), { expect: 'review' })
await post('GHS 769.99 — a pesewa short',    charge('fx-ref-unpaid-1', 76999), { expect: 'review' })
await post('a payment for a cancelled order',charge('fx-ref-cancelled-3', 30000), { expect: 'review' })
await post('an order already settled',       charge('fx-ref-settled-2', 50000), { expect: 'duplicate' })

console.log('\nTHE CORRECT AMOUNT, THEN THE SAME EVENT AGAIN')
await post('GHS 770 exactly',                charge('fx-ref-unpaid-1', 77000), { expect: 'settled' })
await post('the identical event, redelivered',charge('fx-ref-unpaid-1', 77000), { expect: 'duplicate' })
await post('and again',                      charge('fx-ref-unpaid-1', 77000), { expect: 'duplicate' })

if (failures) { console.error(`\n  ${failures} webhook case(s) did not behave as expected`); process.exit(1) }
