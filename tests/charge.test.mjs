import { suite } from './harness.mjs'
const t = suite('Payment prompt: bound to a real outstanding order')

// nalopay-charge takes an unauthenticated POST, because a customer paying has
// no account. It used to accept any phone and any amount, so it could send a
// mobile-money prompt to any number for any figure, as often as called.
// It now has to match an order that exists and is still owed.
//
// Mirrors the guard in supabase/functions/super-service/index.ts.
const guard = (orderId, amount, ord) => {
  if (!orderId) return 'Order reference required'
  if (!ord) return 'Order not found'
  if (ord.status === 'Cancelled') return 'This order has been cancelled'
  if (ord.status === 'Paid' || ord.status === 'Completed' || ord.paid_at) return 'This order has already been paid'
  if (Math.round(Number(amount) * 100) !== Math.round(Number(ord.total) * 100)) return 'Amount does not match the order'
  return null
}
const open240 = { total: 240, status: 'Pending', paid_at: null }

t.eq('no order reference is refused', guard(null, 240, open240), 'Order reference required')
t.eq('an unknown order is refused', guard('x', 240, null), 'Order not found')
t.eq('a cancelled order is refused', guard('x', 240, { ...open240, status: 'Cancelled' }), 'This order has been cancelled')
t.eq('an already paid order is refused', guard('x', 240, { ...open240, status: 'Paid' }), 'This order has already been paid')
t.eq('paid_at alone is enough to refuse', guard('x', 240, { ...open240, paid_at: '2026-09-01' }), 'This order has already been paid')
t.eq('a completed order is refused', guard('x', 240, { ...open240, status: 'Completed' }), 'This order has already been paid')

// The figure cannot be chosen.
t.eq('a larger amount is refused', guard('x', 2400, open240), 'Amount does not match the order')
t.eq('a smaller amount is refused', guard('x', 1, open240), 'Amount does not match the order')
t.eq('one pesewa over is refused', guard('x', 240.01, open240), 'Amount does not match the order')

// The genuine path still goes through, including the float cases that a
// naive === would have rejected and stopped a real customer paying.
t.eq('the exact amount is allowed', guard('x', 240, open240), null)
t.eq('a string amount is allowed', guard('x', '240', open240), null)
t.eq('240.00 matches 240', guard('x', 240.0, open240), null)
t.eq('0.1+0.2 style drift still matches', guard('x', 0.1 + 0.2, { total: 0.3, status: 'Pending', paid_at: null }), null)
t.eq('a normal two-decimal total matches', guard('x', 1234.56, { total: 1234.56, status: 'Pending', paid_at: null }), null)
