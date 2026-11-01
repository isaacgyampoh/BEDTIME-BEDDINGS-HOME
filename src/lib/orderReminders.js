/**
 * What the automated payment chaser has already done to an order.
 *
 * The reminder job records what it has sent by leaving [R1]..[R4] markers in
 * the order's notes — see supabase/functions/_shared/reminders.js. That is the
 * only record there is, and nothing in the POS ever showed it, so staff could
 * not tell an order that had been chased four times from one nobody had
 * touched, and would chase it again by hand.
 */

/** Which reminders have been sent, in order. */
export function remindersSent(notes) {
  const seen = []
  for (const m of String(notes || '').matchAll(/\[(R\d+)\]/g)) if (!seen.includes(m[1])) seen.push(m[1])
  return seen.sort()
}

/** Is this order still waiting for money? */
export function isAwaitingPayment(order) {
  if (!order) return false
  if (order.paidAt || order.paid_at) return false
  return ['Pending', 'Awaiting Payment'].includes(String(order.status || ''))
}

/** How long it has been waiting, in words. */
export function waitingFor(order, now = Date.now()) {
  const started = new Date(order?.date).getTime()
  if (!Number.isFinite(started)) return ''
  const mins = Math.floor((now - started) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hr`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** One line for the card: chased or not, and for how long it has waited. */
export function chaseSummary(order, now = Date.now()) {
  if (!isAwaitingPayment(order)) return null
  const sent = remindersSent(order.notes)
  const waited = waitingFor(order, now)
  return {
    sent,
    count: sent.length,
    waited,
    text: sent.length
      ? `${sent.length} reminder${sent.length === 1 ? '' : 's'} sent · waiting ${waited}`
      : `No reminder sent yet · waiting ${waited}`,
  }
}
