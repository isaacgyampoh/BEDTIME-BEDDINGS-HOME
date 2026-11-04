/**
 * What to do with an incoming payment notification.
 *
 * Plain JavaScript with no imports so Deno can load it in the webhook and Node
 * can load it in the tests. The decision that books money should not be
 * exercisable only by deploying it and sending a real payment.
 *
 * THE THREE FAULTS THIS EXISTS TO FIX
 *
 * 1. A REPEAT DELIVERY COULD CREATE A SECOND ORDER.
 *    Paystack retries a webhook until it gets a 2xx, and can deliver the same
 *    event more than once. The handler looked the reference up with
 *
 *      .eq('paystack_ref', ref).single()
 *
 *    and, finding nothing, created an order. `.single()` raises an error when
 *    the reference matches MORE than one row, and the error was discarded —
 *    so the first duplicate made every later delivery create another one.
 *    `maybeSingle` semantics plus an explicit count fixes the silence;
 *    whatsapp_orders.paystack_ref also needs to be unique, which is staged
 *    for approval because it is a schema change.
 *
 * 2. THE AMOUNT WAS NEVER CHECKED.
 *    `charge.success` arrived with an amount in pesewas and the order was
 *    marked Paid whatever it said. A GHS 1 payment settled a GHS 770 order.
 *    The prompt-sending endpoint was fixed earlier to charge the order's own
 *    total, which closes the common path, but a notification that disagrees
 *    with the order should never be allowed to settle it silently.
 *
 * 3. A SUCCESSFUL PAYMENT CREATED A 'Pending' ORDER.
 *    The create branch set status 'Pending' and paid_at at the same time, so
 *    a paid order sat in the Pending list where the shop chases customers for
 *    money they had already sent.
 */

/** Pesewas, so two floats cannot drift apart. */
const minor = (cedis) => Math.round(Number(cedis || 0) * 100)

/**
 * Does the notified amount settle this order?
 *
 * An overpayment is accepted — the customer has paid at least what was owed,
 * and refusing it would leave real money unbooked — but it is reported so it
 * can be seen. An underpayment is refused: marking an order Paid for less
 * than it costs is how goods leave the shop unpaid for.
 */
export function amountSettles(order, paidMinor) {
  const owed = minor(order && order.total)
  const paid = Number(paidMinor || 0)
  if (!Number.isFinite(paid) || paid <= 0) return { ok: false, reason: 'no amount in the notification', owed, paid }
  if (owed <= 0) return { ok: false, reason: 'the order has no total to settle', owed, paid }
  if (paid < owed) return { ok: false, reason: 'underpaid', owed, paid, short: owed - paid }
  if (paid > owed) return { ok: true, reason: 'overpaid', owed, paid, over: paid - owed }
  return { ok: true, reason: 'exact', owed, paid }
}

const sameStatus = (a, b) => String(a == null ? '' : a).trim().toLowerCase() === String(b).toLowerCase()

/**
 * Has this exact payment already been applied to this order?
 *
 * Settling an order that is already settled must change nothing: not the
 * paid_at (which would move the sale's date), not the stock (which would be
 * deducted twice), and not the customer's SMS (which would arrive again).
 */
export function alreadyApplied(order, ref) {
  if (!order) return false
  const settled = !!order.paid_at || sameStatus(order.status, 'paid') || sameStatus(order.status, 'completed')
  if (!settled) return false
  // No reference recorded: the order is settled, so do not settle it again.
  if (!order.paystack_ref || !ref) return true
  return String(order.paystack_ref) === String(ref)
}

/**
 * What the handler should do with a verified charge.success.
 *
 * `matches` is every order already carrying this reference. More than one is
 * a duplicate that must be reported rather than papered over, because
 * choosing one of them would settle an arbitrary order.
 */
export function planFor({ ref, paidMinor, matches = [], order = null }) {
  if (matches.length > 1) {
    return { action: 'conflict', reason: `${matches.length} orders carry the reference ${ref}`, orders: matches.map(o => o.order_no || o.id) }
  }
  const target = order || matches[0] || null

  if (!target) return { action: 'create', reason: 'no order carries this reference' }

  if (alreadyApplied(target, ref)) {
    return { action: 'noop', reason: 'this payment is already recorded against the order', order: target.order_no || target.id }
  }
  if (sameStatus(target.status, 'cancelled')) {
    return { action: 'review', reason: 'a payment arrived for a cancelled order', order: target.order_no || target.id }
  }
  const money = amountSettles(target, paidMinor)
  if (!money.ok) {
    return { action: 'review', reason: money.reason, order: target.order_no || target.id, owed: money.owed, paid: money.paid }
  }
  return { action: 'settle', reason: money.reason, order: target.order_no || target.id, owed: money.owed, paid: money.paid }
}

/**
 * The fields to write when an order is settled.
 *
 * paid_at comes from the provider, not from the clock here: the sale is dated
 * when the customer paid, not when the notification happened to be processed
 * or retried.
 */
export const settleFields = (providerPaidAt, ref) => ({
  status: 'Paid',
  paid_at: providerPaidAt || new Date().toISOString(),
  ...(ref ? { paystack_ref: ref } : {}),
})
