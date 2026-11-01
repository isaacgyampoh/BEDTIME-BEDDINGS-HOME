/**
 * Which payment reminder an unpaid order is due, and what it should say.
 *
 * Plain JavaScript with no imports so Deno can load it inside the Edge
 * Function and Node can load it in the tests — the decision that costs sales
 * should not be only exercisable by deploying it.
 *
 * WHY THIS EXISTS
 * The reminders were chosen by minute-windows — 5 to 25 minutes after
 * checkout, 30 to 55, 60 to 120 — while the job that evaluates them runs once
 * an hour, at minute 15. So whether a customer was reminded at all depended on
 * where in the hour they happened to check out. Walking every checkout minute
 * against the hourly schedule:
 *
 *   checkout at :00  ->  R1, R3, R4
 *   checkout at :20  ->  R3, R4          (nothing for over an hour)
 *   checkout at :30  ->  R2, R3, R4
 *
 * No customer ever received all four, a quarter of them heard nothing until an
 * hour had passed, and the five-minute nudge — the one that catches someone
 * who simply missed the prompt — reached about a third of them.
 *
 * A threshold is not a window. An order is due the furthest-along reminder it
 * has earned and not yet been sent, whenever the job happens to look.
 */

/** Minutes after checkout at which each reminder becomes due. */
export const DEFAULT_STEPS = [
  { tag: 'R1', afterMinutes: 5 },
  { tag: 'R2', afterMinutes: 20 },
  { tag: 'R3', afterMinutes: 60 },
  { tag: 'R4', afterMinutes: 1440 },
]

/** Read a schedule out of an env string like "5,20,60,1440". */
export function stepsFrom(spec, fallback = DEFAULT_STEPS) {
  const mins = String(spec || '').split(',').map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n >= 0)
  if (!mins.length) return fallback
  return mins.sort((a, b) => a - b).map((afterMinutes, i) => ({ tag: `R${i + 1}`, afterMinutes }))
}

/** Reminders already sent, read from the markers left in the order's notes. */
export const alreadySent = (notes) => {
  const seen = new Set()
  for (const m of String(notes || '').matchAll(/\[(R\d+)\]/g)) seen.add(m[1])
  return seen
}

/**
 * The one reminder to send now, or null.
 *
 * The furthest-along step that is due and unsent wins, and every earlier step
 * is reported as superseded so it can be marked without being sent: catching
 * up by firing four messages at once would be worse than silence.
 */
export function dueReminder(order, now = Date.now(), steps = DEFAULT_STEPS) {
  if (!order || !order.date) return null
  const started = new Date(order.date).getTime()
  if (!Number.isFinite(started)) return null
  const minutes = Math.floor((now - started) / 60000)
  if (minutes < 0) return null

  const sent = alreadySent(order.notes)
  const due = steps.filter(s => minutes >= s.afterMinutes)
  if (!due.length) return null

  const last = due[due.length - 1]
  if (sent.has(last.tag)) return null

  return {
    tag: last.tag,
    minutes,
    // Earlier steps this order never got; marked, not sent.
    superseded: due.slice(0, -1).map(s => s.tag).filter(t => !sent.has(t)),
    isFinal: last === steps[steps.length - 1],
  }
}

/**
 * Is this order one we should be chasing at all?
 *
 * The old check also required a USSD code and skipped the order silently
 * without one — so a customer whose payment never got far enough to be issued
 * a code was never chased, which is exactly the customer most worth chasing.
 * A phone number is the only thing actually needed to send a message.
 */
export function isChaseable(order) {
  if (!order) return false
  if (order.paid_at) return false
  if (!['Pending', 'Awaiting Payment'].includes(String(order.status || ''))) return false
  return !!String(order.customer_phone || '').trim()
}

/**
 * The message itself.
 *
 * It always carries a link back to the order, because "dial this code" assumes
 * the customer can and will use USSD; a link works for everyone and lands them
 * on the page that already shows their items and takes payment. The USSD code
 * stays as a second option when there is one.
 */
export function reminderMessage({ order, tag, payUrl, shopName = 'BEDTIME Home', isFinal = false }) {
  const first = String(order.customer_name || 'there').trim().split(/\s+/)[0] || 'there'
  const amount = `GHS ${Number(order.total || 0).toFixed(2)}`
  const ref = order.order_no ? ` ${order.order_no}` : ''
  const dial = order.ussd_code ? `\nOr dial ${order.ussd_code} to pay by mobile money.` : ''

  const opening = isFinal
    ? `Hi ${first}, last reminder: your ${shopName} order${ref} (${amount}) is still unpaid and will be cancelled soon.`
    : tag === 'R1'
      ? `Hi ${first}, you are almost done. Your ${shopName} order${ref} comes to ${amount}.`
      : `Hi ${first}, your ${shopName} order${ref} (${amount}) is still waiting for payment.`

  return `${opening}\n\nReview it and pay here: ${payUrl}${dial}\n\nThank you.`
}
