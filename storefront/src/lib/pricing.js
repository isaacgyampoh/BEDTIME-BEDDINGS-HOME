/**
 * What a line in the cart costs.
 *
 * One definition, because three places have to agree or a customer is charged
 * something other than what they were shown: this cart, the order total the
 * database recomputes in migration 047, and the till. The order of precedence
 * is the shop's, not an invention here:
 *
 *   1. a live promotional price wins outright
 *   2. otherwise the wholesale price — but only when the quantity ordered
 *      across that product's CATEGORY reaches its wholesale minimum, which is
 *      how the shop sells (five towels of any colour, not five of one)
 *   3. otherwise the retail price
 */

/** Total quantity ordered per category — what the wholesale minimum is tested against. */
export function categoryQuantities(cart) {
  const totals = {}
  for (const c of cart || []) {
    if (!c?.category) continue
    totals[c.category] = (totals[c.category] || 0) + Number(c.qty || 0)
  }
  return totals
}

/** The unit price for one cart line, and whether the wholesale rate applied. */
export function unitPrice(line, { promo = null, categoryQty = 0 } = {}) {
  if (promo && Number(promo.price) > 0) return { price: Number(promo.price), isWholesale: false }
  const wp = Number(line?.wp || 0)
  const wm = Number(line?.wm || 0)
  const retail = Number(line?.retailPrice ?? line?.price ?? 0)
  if (wp <= 0 || wm <= 0) return { price: retail, isWholesale: false }
  return categoryQty >= wm ? { price: wp, isWholesale: true } : { price: retail, isWholesale: false }
}

/** Re-price a whole cart. Returns new line objects; the input is untouched. */
export function priceCart(cart, promoMap = {}) {
  const byCategory = categoryQuantities(cart)
  return (cart || []).map(c => {
    const { price, isWholesale } = unitPrice(c, {
      promo: promoMap[c.id],
      categoryQty: byCategory[c.category] || 0,
    })
    return { ...c, price, isWholesale }
  })
}

/** What the order comes to. */
export const cartTotal = (cart) =>
  (cart || []).reduce((sum, c) => sum + Number(c.price || 0) * Number(c.qty || 0), 0)
