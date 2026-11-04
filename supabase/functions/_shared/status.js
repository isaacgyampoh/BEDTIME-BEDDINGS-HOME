/**
 * An order's status, compared without caring how it was capitalised.
 *
 * Plain JavaScript with no imports so Deno can load it inside an Edge Function
 * and Node can load it in the tests.
 *
 * WHY THIS EXISTS
 * Production holds 193 orders with status 'Cancelled' and one with
 * 'cancelled'. Every comparison in this codebase used ===, which made that
 * order invisible to each of them. In the browser that was a counting error.
 * Here it is worse:
 *
 *   if (ord.status === 'Cancelled') return 'This order has been cancelled'
 *
 * is the guard in nalopay-charge that stops a mobile-money prompt being sent
 * for an order the shop has already cancelled. The lower-case order walks
 * straight past it, so a customer could be charged for goods that are not
 * coming.
 *
 * The daily SMS report counts by status the same way, so its figures were
 * short by that order too.
 *
 * Matching case-insensitively is not a tidy-up. It is the difference between
 * a guard that holds for every row in the table and one that holds for most.
 */

/** Does this status match any of these, however either was written? */
export function statusIs(status, wanted) {
  const s = String(status == null ? '' : status).trim().toLowerCase()
  if (!s) return false
  return (Array.isArray(wanted) ? wanted : [wanted])
    .some(w => String(w).trim().toLowerCase() === s)
}

/** Has the shop been paid for this order? */
export const isPaid = (o) =>
  !!o && (statusIs(o.status, ['Paid', 'Completed']) || !!o.paid_at)

/** Has it been cancelled? */
export const isCancelled = (o) => !!o && statusIs(o.status, ['Cancelled'])

/** Is the shop still waiting for the money? */
export const isOutstanding = (o) =>
  !!o && !isPaid(o) && !isCancelled(o) && statusIs(o.status, ['Pending', 'Awaiting Payment'])

/**
 * A PostgREST filter matching any of these statuses, ignoring case.
 * `ilike` with no wildcards is a case-insensitive equality test.
 */
export const anyStatus = (statuses) =>
  statuses.map(v => `status.ilike.${String(v).replace(/([,().])/g, '\\$1')}`).join(',')
