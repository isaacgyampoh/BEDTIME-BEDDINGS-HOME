#!/usr/bin/env node
/**
 * Regression suite for the Paystack webhook hotfix.
 *
 *   PAYSTACK_SECRET_KEY=... FN_URL=http://localhost:8000/ DB=bedtime_hotfix \
 *     node migration-package/scripts/webhook-regression.mjs
 *
 * Covers what the approval asked for: forged callbacks, underpayments,
 * duplicate events, legitimate payments and provider failures — plus the
 * unauthenticated case the hotfix exists to close.
 *
 * It runs against a DISPOSABLE restore. Each case resets the order first, so
 * cases cannot contaminate each other, and asserts the ORDER'S STATE as well
 * as the HTTP response: a handler that answers 200 and changes nothing is a
 * different bug from one that answers 200 and settles.
 */
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const SECRET = process.env.PAYSTACK_SECRET_KEY
const URL_ = process.env.FN_URL || 'http://localhost:8000/'
const DB = process.env.DB || 'bedtime_hotfix'
if (!SECRET) { console.error('PAYSTACK_SECRET_KEY is not set'); process.exit(2) }

const psql = (sql) => execFileSync('psql', ['-At', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim()
const sign = (b) => createHmac('sha512', SECRET).update(b).digest('hex')

const REF = 'hf-ref-770'
const reset = () => psql(`UPDATE whatsapp_orders SET status='Pending', paid_at=NULL WHERE paystack_ref='${REF}'`)
const state = () => psql(`SELECT status||'|'||COALESCE(paid_at::text,'-') FROM whatsapp_orders WHERE paystack_ref='${REF}'`)

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`) }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? '   ' + extra : ''}`) }
}
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

async function post(payload, { sig = 'valid' } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const h = { 'Content-Type': 'application/json' }
  if (sig === 'valid') h['x-paystack-signature'] = sign(body)
  else if (sig === 'forged') h['x-paystack-signature'] = 'f'.repeat(128)
  else if (sig === 'wrongkey') h['x-paystack-signature'] = createHmac('sha512', 'not-the-key').update(body).digest('hex')
  // sig === 'none' sends no header at all
  const r = await fetch(URL_ + '?action=webhook', { method: 'POST', body, headers: h })
  let j = {}; try { j = await r.json() } catch {}
  return { status: r.status, j }
}
const charge = (amount, extra = {}) => ({
  event: 'charge.success',
  data: { reference: REF, amount, currency: 'GHS', status: 'success',
          paid_at: '2026-11-21T12:00:00Z', metadata: {}, ...extra },
})

// ── authentication ──────────────────────────────────────────────────────────
head('Authentication — the hole this closes')
reset()
let r = await post(charge(77000), { sig: 'none' })
ok('an unsigned callback is refused', r.status === 401, `HTTP ${r.status}`)
ok('and the order is untouched', state().startsWith('Pending'), state())

reset()
r = await post(charge(77000), { sig: 'forged' })
ok('a forged signature is refused', r.status === 401, `HTTP ${r.status}`)
ok('and the order is untouched', state().startsWith('Pending'), state())

reset()
r = await post(charge(77000), { sig: 'wrongkey' })
ok('a signature from the wrong key is refused', r.status === 401, `HTTP ${r.status}`)
ok('and the order is untouched', state().startsWith('Pending'), state())

reset()
r = await post('{not json}', { sig: 'valid' })
ok('a signed but unparseable body does not settle', !state().startsWith('Paid'), state())

// ── a legitimate payment ────────────────────────────────────────────────────
head('A legitimate payment must still work')
reset()
r = await post(charge(77000))
ok('the exact amount settles the order', r.status === 200 && r.j.success === true, JSON.stringify(r.j).slice(0, 70))
ok('the order is Paid', state().startsWith('Paid'), state())
ok('dated from the provider, not the clock here', state().includes('12:00:00'), state())

reset()
r = await post(charge(78001))
ok("NaloPay's +1.3% fee still settles (overpayment accepted)", state().startsWith('Paid'), state())

// ── underpayment ────────────────────────────────────────────────────────────
head('Underpayment — the case that gives goods away')
for (const [amt, label] of [[100, 'GHS 1.00 against GHS 770'], [76999, 'one pesewa short'], [0, 'no amount at all']]) {
  reset()
  r = await post(charge(amt))
  ok(`${label} is refused`, state().startsWith('Pending'), `${state()}  ${JSON.stringify(r.j).slice(0, 60)}`)
}

// ── provider failure and currency ───────────────────────────────────────────
head('Provider status and currency')
reset(); r = await post(charge(77000, { status: 'failed' }))
ok('status "failed" does not settle', state().startsWith('Pending'), state())
reset(); r = await post(charge(77000, { status: 'abandoned' }))
ok('status "abandoned" does not settle', state().startsWith('Pending'), state())
reset(); r = await post(charge(77000, { currency: 'NGN' }))
ok('the wrong currency does not settle', state().startsWith('Pending'), state())
reset(); r = await post({ event: 'charge.failed', data: { reference: REF, amount: 77000 } })
ok('a charge.failed event settles nothing', state().startsWith('Pending'), state())
ok('and is acknowledged so the provider stops retrying', r.status === 200, `HTTP ${r.status}`)

// ── duplicates ──────────────────────────────────────────────────────────────
head('Duplicate delivery')
reset()
await post(charge(77000))
const afterFirst = state()
ok('the first delivery settles it', afterFirst.startsWith('Paid'), afterFirst)
await post(charge(77000))
const afterSecond = state()
ok('a redelivery does not change paid_at', afterFirst === afterSecond, `${afterFirst} -> ${afterSecond}`)
await post(charge(77000, { paid_at: '2026-11-22T23:59:00Z' }))
ok('nor does one claiming a later timestamp', state() === afterFirst, `${afterFirst} -> ${state()}`)

// ── an order that should never settle ───────────────────────────────────────
head('An order nobody should be able to settle')
psql(`UPDATE whatsapp_orders SET status='cancelled', paid_at=NULL WHERE paystack_ref='${REF}'`)
await post(charge(77000))
ok('a cancelled order is not settled by a valid callback', !state().startsWith('Paid'), state())
reset()

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) console.log('REGRESSION FAILED — do not deploy.')
process.exit(fail ? 1 : 0)
