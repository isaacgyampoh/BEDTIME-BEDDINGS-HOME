/**
 * Which products are in a live promotion, and in what order to show them.
 *
 * The source of truth is the `promos` table the shop edits in the admin app:
 * a name, a start and end date, an active flag, and the list of products with
 * their promotional price. Nothing here is hardcoded, so the next campaign is
 * set up in the admin screen and appears on the site by itself.
 *
 * Dates are plain YYYY-MM-DD strings compared as strings, and BOTH ends count
 * — the same rule the till (src/pages/POS.jsx) and the admin promo list use.
 * The site used to do `new Date(end_date) < now`, which dropped a promo at
 * midnight ON its last day while the counter was still selling it. Ghana keeps
 * UTC+0 all year, so the ISO date is already the local trading day.
 */

/** Today in Ghana, as the YYYY-MM-DD the promo dates are written in. */
export const todayISO = () => new Date().toISOString().slice(0, 10)

/** Whole-percent saving, or 0 when there is nothing real to claim. */
export function discountPct(original, promoPrice) {
  const o = Number(original), p = Number(promoPrice)
  if (!(o > 0) || !(p > 0) || p >= o) return 0
  return Math.round((1 - p / o) * 100)
}

/** Is this promo row running today? */
export function isLive(promo, today = todayISO()) {
  if (!promo || promo.active === false) return false
  const from = (promo.start_date || '').slice(0, 10)
  const to = (promo.end_date || '').slice(0, 10)
  if (from && from > today) return false      // not started
  if (to && to < today) return false          // finished — the last day counts
  return true
}

/**
 * Live promos and the product -> { price, name } map they produce.
 * A product in more than one live promo gets the cheapest price.
 */
export function buildPromoMap(rows, today = todayISO()) {
  const map = {}, active = []
  for (const p of rows || []) {
    if (!isLive(p, today)) continue
    let items
    try { items = typeof p.items === 'string' ? JSON.parse(p.items) : p.items }
    catch { continue }
    if (!Array.isArray(items)) continue
    active.push(p)
    for (const it of items) {
      const pid = it?.productId || it?.product_id || it?.id
      const pp = Number(it?.promoPrice ?? it?.promo_price ?? it?.price ?? 0)
      if (pid && pp > 0 && (!map[pid] || pp < map[pid].price)) map[pid] = { price: pp, name: p.name }
    }
  }
  return { map, active }
}

/** Heading for the promo section, taken from what the shop called the promo. */
export function promoHeading(promos) {
  const names = [...new Set((promos || []).map(p => (p?.name || '').trim()).filter(Boolean))]
  if (names.length !== 1) return 'Deals'
  return /\b(deals?|offers?|sale)\b/i.test(names[0]) ? names[0] : `${names[0]} Deals`
}

/**
 * The moment the countdown should reach zero: the END of the last day, not its
 * midnight start, because the last day is a trading day like any other.
 */
export function promoEndsAt(promos) {
  const ends = (promos || []).map(p => (p?.end_date || '').slice(0, 10)).filter(Boolean).sort()
  return ends.length ? `${ends[ends.length - 1]}T23:59:59` : null
}

/** Only the products in a live promo, biggest saving first. */
export function promoFirst(products, map) {
  return (products || [])
    .filter(p => map[p.id])
    .sort((a, b) => discountPct(b.price, map[b.id].price) - discountPct(a.price, map[a.id].price))
}

/**
 * Re-order a list so promotional products lead, biggest saving first, with
 * everything else keeping the order it already had. Which products are in the
 * list is not changed — a category filter or a search still decides that.
 */
export function orderPromoFirst(products, map) {
  const saving = (p) => map[p.id] ? Math.max(discountPct(p.price, map[p.id].price), 1) : 0
  return (products || [])
    .map((p, i) => ({ p, i, s: saving(p) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.p)
}
