/**
 * How many orders are in each state — asked of the database, not counted from
 * whatever happens to be in memory.
 *
 * THE BUG THIS EXISTS TO FIX
 * Every headline figure was computed by filtering the `waOrders` array:
 *
 *   const paid = waOrders.filter(o => o.status === 'Paid').length
 *
 * That array is not the orders. It is the newest N of them, and N depended on
 * which code path had last filled it — 200 on the initial load, 500 after a
 * refresh. Eight tables were loaded with two different limits that way. So the
 * same figure read 53, then 42, then 23 across restarts: each number was an
 * honest count of a different, truncated, moving window.
 *
 * Counting in the database costs one tiny request per figure — `head: true`
 * transfers no rows at all, only the Content-Range header — and the answer
 * does not depend on what the app happens to have loaded.
 *
 * The definitions live here and nowhere else, so the dashboard, the orders
 * screen and the navigation badge cannot drift apart.
 */

/** What each figure means, in one place. */
export const ORDER_STATES = {
  pending:   { label: 'Pending',   statuses: ['Pending', 'Awaiting Payment'] },
  paid:      { label: 'Paid',      statuses: ['Paid'] },
  completed: { label: 'Completed', statuses: ['Completed'] },
  cancelled: { label: 'Cancelled', statuses: ['Cancelled'] },
}

/** An order still owing money. The same rule the reminder job uses. */
export const AWAITING_PAYMENT = ['Pending', 'Awaiting Payment']

const EMPTY = { pending: null, paid: null, completed: null, cancelled: null, awaiting: null, total: null }

/**
 * Count rows matching a filter without fetching them.
 *
 * Returns null — not 0 — when the query fails. A zero means "none"; null means
 * "not known", and the screen can say so instead of showing a confident wrong
 * figure. Silently returning 0 on error is how an outage looked like a quiet
 * day's trading.
 */
export async function countWhere(sb, table, apply) {
  try {
    let query = sb.from(table).select('id', { count: 'exact', head: true })
    if (apply) query = apply(query)
    const { count, error } = await query
    if (error) { console.warn(`[counts] ${table} failed:`, error.message); return null }
    return typeof count === 'number' ? count : null
  } catch (e) {
    console.warn(`[counts] ${table} threw:`, e)
    return null
  }
}

/**
 * Every order figure the POS shows, counted in the database.
 *
 * One request per figure, each transferring no rows. They run together, and a
 * figure that fails comes back null rather than poisoning the rest.
 */
export async function orderCounts(sb) {
  if (!sb) return { ...EMPTY }
  const [pending, paid, completed, cancelled, awaiting, total] = await Promise.all([
    countWhere(sb, 'whatsapp_orders', q => q.in('status', ORDER_STATES.pending.statuses)),
    countWhere(sb, 'whatsapp_orders', q => q.in('status', ORDER_STATES.paid.statuses)),
    countWhere(sb, 'whatsapp_orders', q => q.in('status', ORDER_STATES.completed.statuses)),
    countWhere(sb, 'whatsapp_orders', q => q.in('status', ORDER_STATES.cancelled.statuses)),
    countWhere(sb, 'whatsapp_orders', q => q.in('status', AWAITING_PAYMENT).is('paid_at', null)),
    countWhere(sb, 'whatsapp_orders', null),
  ])
  return { pending, paid, completed, cancelled, awaiting, total }
}

/**
 * A figure for the screen.
 *
 * Prefers the counted answer. Falls back to counting what is loaded only when
 * the count is not known, and says which it is, so a screen can show "53" and
 * "53 (of those loaded)" differently instead of presenting a partial count as
 * fact.
 */
export function figure(counted, loadedFallback) {
  if (typeof counted === 'number') return { value: counted, exact: true }
  if (typeof loadedFallback === 'number') return { value: loadedFallback, exact: false }
  return { value: null, exact: false }
}
