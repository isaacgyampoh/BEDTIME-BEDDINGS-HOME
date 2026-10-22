/**
 * Putting a promotion together.
 *
 * The shop sells one bedsheet in forty colours, each its own product. Setting
 * up Black Friday meant finding each of the forty in a dropdown of 652 and
 * typing 75 next to it, forty times. These are the pieces that let it be done
 * by searching once, ticking what matches and saying "20% off".
 *
 * Prices are money, so they are rounded to the pesewa and never below zero.
 */

/** Two decimal places, the way cedis are written. */
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Products matching what was typed, within a category.
 *
 * Every word has to appear somewhere in the name or the category, so "bedsheet
 * 21" finds "1 Double Bedsheet with 2 pillow cases (color 21)" and nothing
 * else, and the order of the words does not matter.
 */
export function matchProducts(products, { query = '', category = 'all' } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  return (products || []).filter(p => {
    if (category !== 'all' && p.category !== category) return false
    if (!words.length) return true
    const hay = `${p.name || ''} ${p.category || ''}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
}

/** A product as a promo line, with no price decided yet. */
export function toItem(p) {
  return { productId: p.id, name: p.name, originalPrice: Number(p.price) || 0, promoPrice: '' }
}

/**
 * Take a percentage off every line.
 *
 * `only` limits it to a set of product ids, so a correction can be applied to
 * part of the promotion without disturbing prices already set by hand.
 */
export function applyPercent(items, pct, only = null) {
  const off = Number(pct)
  if (!(off > 0) || off >= 100) return items || []
  return (items || []).map(it => {
    if (only && !only.has(it.productId)) return it
    const was = Number(it.originalPrice) || 0
    return { ...it, promoPrice: was > 0 ? round2(was * (1 - off / 100)) : it.promoPrice }
  })
}

/** Put every line at the same price — the usual shape of these promotions. */
export function applyFixed(items, price, only = null) {
  const p = Number(price)
  if (!(p > 0)) return items || []
  return (items || []).map(it => (only && !only.has(it.productId)) ? it : { ...it, promoPrice: round2(p) })
}

/**
 * What is wrong with the promotion, in the words the person would use.
 * Empty means it can be saved.
 */
export function validate({ name, startDate, endDate, items }) {
  const problems = []
  if (!String(name || '').trim()) problems.push('Give the promotion a name')
  if (!startDate) problems.push('Choose a start date')
  if (!endDate) problems.push('Choose an end date')
  if (startDate && endDate && endDate < startDate) problems.push('The end date is before the start date')
  if (!items?.length) problems.push('Add at least one product')

  const unpriced = (items || []).filter(it => !(Number(it.promoPrice) > 0))
  if (unpriced.length === 1) problems.push(`Set a promo price for ${unpriced[0].name}`)
  else if (unpriced.length > 1) problems.push(`${unpriced.length} products still have no promo price`)

  // A "promotion" that charges more is the kind of mistake that reaches a
  // customer's receipt before anyone notices.
  const dearer = (items || []).filter(it =>
    Number(it.promoPrice) > 0 && Number(it.originalPrice) > 0 && Number(it.promoPrice) >= Number(it.originalPrice))
  if (dearer.length === 1) problems.push(`${dearer[0].name} is not cheaper than its normal price`)
  else if (dearer.length > 1) problems.push(`${dearer.length} products are not cheaper than their normal price`)

  return problems
}

/**
 * The promotion in one line, for the list.
 *
 * Forty colours of the same bedsheet at the same price is one fact, not forty
 * rows: "40 items · GHS 80.00 → GHS 75.00". Mixed prices fall back to the
 * range and the best saving.
 */
export function summarise(items) {
  const list = (items || []).filter(it => Number(it.promoPrice) > 0)
  if (!list.length) return { count: (items || []).length, uniform: false, maxPct: 0 }

  const prices = list.map(it => Number(it.promoPrice))
  const olds = list.map(it => Number(it.originalPrice) || 0)
  const uniform = new Set(prices).size === 1 && new Set(olds).size === 1
  const maxPct = list.reduce((best, it) => {
    const was = Number(it.originalPrice) || 0, now = Number(it.promoPrice)
    return was > now && was > 0 ? Math.max(best, Math.round((1 - now / was) * 100)) : best
  }, 0)

  return {
    count: list.length,
    uniform,
    from: uniform ? olds[0] : Math.min(...olds),
    to: uniform ? prices[0] : Math.min(...prices),
    maxPct,
  }
}

/**
 * The picker's rows: variants of one product collapse into a single row.
 *
 * Products.jsx asks the shop to give "every colour/type of the same product the
 * SAME group", which is how five across colours trigger the wholesale price.
 * That same tag is what turns forty rows of
 * "1 Double Bedsheet with 2 pillow cases (color 31)" into one row saying
 * "1 Double Bedsheet with 2 pillow cases · 40 colours", with one button that
 * puts the lot into the promotion.
 *
 * Products with no group stay as themselves. Order follows the products given,
 * so a group appears where its first member did.
 */
export function groupProducts(products) {
  const rows = [], byTag = new Map()
  for (const p of products || []) {
    const tag = (p.groupTag || '').trim().toLowerCase()
    if (!tag) { rows.push({ key: `p:${p.id}`, tag: '', label: p.name, items: [p], image: p.image || '' }); continue }
    let row = byTag.get(tag)
    if (!row) { row = { key: `g:${tag}`, tag, label: '', items: [], image: '' }; byTag.set(tag, row); rows.push(row) }
    row.items.push(p)
    if (!row.image && p.image) row.image = p.image
  }
  for (const row of rows) {
    if (!row.tag) { row.priceFrom = row.priceTo = Number(row.items[0].price) || 0; continue }
    const prices = row.items.map(p => Number(p.price) || 0)
    row.priceFrom = Math.min(...prices)
    row.priceTo = Math.max(...prices)
    row.label = commonName(row.items.map(p => p.name)) || row.tag
  }
  return rows
}

/**
 * What a set of variant names have in common, so the row reads
 * "1 Double Bedsheet with 2 pillow cases" rather than the tag the shop typed.
 * Falls back to nothing when the names share no sensible opening.
 */
export function commonName(names) {
  if (!names?.length) return ''
  if (names.length === 1) return names[0]
  const words = names.map(n => String(n).trim().split(/\s+/))
  const out = []
  for (let i = 0; i < words[0].length; i++) {
    const w = words[0][i]
    if (!words.every(ws => ws[i] === w)) break
    out.push(w)
  }
  // "1 Double Bedsheet with 2 pillow cases (color" — drop a dangling bracket.
  while (out.length && /^[([{]/.test(out[out.length - 1])) out.pop()
  const label = out.join(' ').replace(/[\s([{,-]+$/, '')
  return label.length >= 3 ? label : ''
}
