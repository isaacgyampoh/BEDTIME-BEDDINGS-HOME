import { suite } from './harness.mjs'
import { planFor, amountSettles, alreadyApplied, settleFields } from '../supabase/functions/_shared/payments.js'
import { statusIs, isPaid, isCancelled, isOutstanding, anyStatus } from '../supabase/functions/_shared/status.js'
const t = suite('Payment notifications: what the webhook does with one')

const ORDER = { id: 'o1', order_no: 'WEB-1', total: 770, status: 'Pending', paid_at: null, paystack_ref: 'ref-1' }

// ── the amount, which was never checked ──────────────────────────────────────
// charge.success carried an amount in pesewas and the order was marked Paid
// whatever it said, so a GHS 1 payment settled a GHS 770 order.
t.eq('the exact amount settles it', amountSettles(ORDER, 77000).ok, true)
t.eq('and is reported as exact', amountSettles(ORDER, 77000).reason, 'exact')
t.eq('one cedi does not settle seven hundred and seventy', amountSettles(ORDER, 100).ok, false)
t.eq('and says it is short', amountSettles(ORDER, 100).reason, 'underpaid')
t.eq('by how much, in pesewas', amountSettles(ORDER, 100).short, 76900)
t.eq('a penny short is still short', amountSettles(ORDER, 76999).ok, false)
t.eq('an overpayment is accepted', amountSettles(ORDER, 80000).ok, true)
t.eq('and flagged as one', amountSettles(ORDER, 80000).reason, 'overpaid')
t.eq('no amount settles nothing', amountSettles(ORDER, 0).ok, false)
t.eq('nor a missing one', amountSettles(ORDER, undefined).ok, false)
t.eq('nor nonsense', amountSettles(ORDER, NaN).ok, false)
t.eq('an order with no total cannot be settled', amountSettles({ total: 0 }, 100).ok, false)
// Floats: 0.07 * 100 is 7.000000000000001 in binary floating point.
t.eq('a price with pesewas compares exactly', amountSettles({ total: 770.07 }, 77007).ok, true)
t.eq('and is not settled by one pesewa less', amountSettles({ total: 770.07 }, 77006).ok, false)

// ── the repeat delivery, which could create a second order ───────────────────
// Paystack retries until it gets a 2xx and can deliver the same event twice.
t.eq('a fresh payment settles the order', planFor({ ref: 'ref-1', paidMinor: 77000, order: ORDER }).action, 'settle')
{
  const settled = { ...ORDER, status: 'Paid', paid_at: '2026-11-01T10:00:00Z' }
  const p = planFor({ ref: 'ref-1', paidMinor: 77000, order: settled })
  t.eq('the same payment arriving again does nothing', p.action, 'noop')
  t.ok('and says why', /already recorded/.test(p.reason))
}
t.eq('a settled order with no reference recorded is still not re-settled',
  planFor({ ref: 'ref-9', paidMinor: 77000, order: { ...ORDER, status: 'Paid', paid_at: '2026-11-01', paystack_ref: null } }).action, 'noop')
t.eq('a Completed order is not settled again',
  planFor({ ref: 'ref-1', paidMinor: 77000, order: { ...ORDER, status: 'Completed' } }).action, 'noop')

// One reference on several orders: choosing one would settle an arbitrary
// order. `.single()` raised an error here and the error was discarded, so the
// handler created yet another order.
{
  const p = planFor({ ref: 'ref-1', paidMinor: 77000, matches: [ORDER, { ...ORDER, id: 'o2', order_no: 'WEB-2' }] })
  t.eq('one reference on two orders is a conflict, not a guess', p.action, 'conflict')
  t.eq('and both are named', p.orders.length, 2)
}

// ── payments that need a person ──────────────────────────────────────────────
t.eq('an underpayment is not settled quietly',
  planFor({ ref: 'ref-1', paidMinor: 100, order: ORDER }).action, 'review')
t.eq('a payment for a cancelled order is not settled',
  planFor({ ref: 'ref-1', paidMinor: 77000, order: { ...ORDER, status: 'Cancelled' } }).action, 'review')
t.eq('nor for one cancelled in lower case',
  planFor({ ref: 'ref-1', paidMinor: 77000, order: { ...ORDER, status: 'cancelled' } }).action, 'review')
t.eq('a payment with no order behind it creates one',
  planFor({ ref: 'new-ref', paidMinor: 77000, matches: [] }).action, 'create')

// ── what gets written ────────────────────────────────────────────────────────
// A successful payment used to create an order with status 'Pending' AND
// paid_at set, putting a paid order in the list the shop chases for money.
t.eq('a settled order is Paid, not Pending', settleFields('2026-11-01T10:00:00Z', 'r').status, 'Paid')
t.eq('dated when the customer paid, not when the retry was processed',
  settleFields('2026-11-01T10:00:00Z', 'r').paid_at, '2026-11-01T10:00:00Z')
t.ok('a provider that sends no timestamp still gets one',
  !!settleFields(null, 'r').paid_at)
t.ok('the reference is recorded', settleFields(null, 'ref-7').paystack_ref === 'ref-7')
t.ok('and nothing is invented when there is none', !('paystack_ref' in settleFields(null, null)))

// ── the status guards in the Edge Functions ──────────────────────────────────
// isCancelled guards the endpoint that sends a mobile-money prompt. The
// lower-case order in production walked straight past `=== 'Cancelled'`, so a
// customer could be charged for goods that were not coming.
t.ok('a lower-case cancelled order is cancelled', isCancelled({ status: 'cancelled' }))
t.ok('as is a capitalised one', isCancelled({ status: 'Cancelled' }))
t.ok('a paid order is not cancelled', !isCancelled({ status: 'Paid' }))
t.ok('a missing order is not cancelled', !isCancelled(null))
t.ok('a lower-case paid order counts as paid', isPaid({ status: 'paid' }))
t.ok('paid_at alone counts as paid', isPaid({ status: 'Pending', paid_at: '2026-11-01' }))
t.ok('an unpaid pending order is outstanding', isOutstanding({ status: 'Pending', paid_at: null }))
t.ok('one already paid is not outstanding', !isOutstanding({ status: 'Pending', paid_at: '2026-11-01' }))
t.ok('a cancelled order is not outstanding', !isOutstanding({ status: 'cancelled' }))
t.eq('the database filter matches either spelling', anyStatus(['Cancelled']), 'status.ilike.Cancelled')
t.ok('an empty status matches nothing', !statusIs('', ['Pending']))
t.ok('nor does a missing one', !statusIs(null, ['Pending']))
