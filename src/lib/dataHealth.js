import { num } from './utils'

/**
 * Catalogue data problems that quietly distort the business figures.
 *
 * The one that actually costs you: a product with no cost price records its
 * profit as the FULL selling price, because profit is (price - cost) and cost
 * is zero. Every sale of that item overstates profit by whatever it really
 * cost. Nothing in the POS said so.
 */

export const ISSUES = [
  {
    id: 'noCost',
    label: 'No cost price',
    severity: 'high',
    why: 'Profit is recorded as the full selling price, so reported profit is too high.',
    test: p => num(p.price) > 0 && !num(p.costPrice),
  },
  {
    id: 'belowCost',
    label: 'Selling below cost',
    severity: 'high',
    why: 'Every sale of this item loses money.',
    test: p => num(p.costPrice) > 0 && num(p.price) > 0 && num(p.price) < num(p.costPrice),
  },
  {
    id: 'noPrice',
    label: 'No selling price',
    severity: 'high',
    why: 'Cannot be sold — checkout refuses it.',
    test: p => !num(p.price),
  },
  {
    id: 'wholesaleNotCheaper',
    label: 'Wholesale not cheaper than retail',
    severity: 'medium',
    why: 'Buying more costs the same or more, so the wholesale tier is pointless.',
    test: p => num(p.wholesalePrice) > 0 && num(p.price) > 0 && num(p.wholesalePrice) >= num(p.price),
  },
  {
    id: 'wholesaleNoMin',
    label: 'Wholesale price with no minimum quantity',
    severity: 'medium',
    why: 'The wholesale tier can never trigger.',
    test: p => num(p.wholesalePrice) > 0 && !num(p.wholesaleMinQty),
  },
  {
    id: 'negativeStock',
    label: 'Negative stock',
    severity: 'high',
    why: 'An impossible figure — stock needs a recount.',
    test: p => num(p.quantity) < 0,
  },
  {
    id: 'noCategory',
    label: 'No category',
    severity: 'low',
    why: 'Invisible to the category filters on the POS and the shop.',
    test: p => !String(p.category || '').trim(),
  },
  {
    id: 'noPhoto',
    label: 'No photo',
    severity: 'low',
    why: 'Weak on the storefront, and it cannot be promoted to TikTok.',
    test: p => !String(p.image || '').trim(),
  },
]

/** Count each issue across the catalogue, worst first. */
export function auditProducts(products = []) {
  const rank = { high: 0, medium: 1, low: 2 }
  return ISSUES
    .map(i => ({ ...i, products: products.filter(i.test) }))
    .filter(i => i.products.length > 0)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.products.length - a.products.length)
}

/**
 * How much of a profit figure rests on items whose cost is unknown.
 * Reported profit is overstated by at least this much.
 */
export function unknownCostExposure(sales = []) {
  let value = 0, affected = 0
  for (const s of sales) {
    if (s.voided) continue
    const items = Array.isArray(s.items) ? s.items : []
    const bad = items.filter(i => !num(i.costPrice))
    if (!bad.length) continue
    affected++
    value += bad.reduce((a, i) => a + num(i.lineTotal || num(i.price) * num(i.qty)), 0)
  }
  return { affected, value }
}
