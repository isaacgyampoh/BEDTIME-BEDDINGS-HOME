import { suite } from './harness.mjs'
const t = suite('Client / server pricing parity')

// record_sale recomputes prices server-side and REJECTS a cart that disagrees.
// If the two sides ever diverge, real sales get refused at the till — so the
// two implementations are checked against each other here.
const TODAY = '2026-08-31'
const num = n => Number(n) || 0

// POS.jsx getPrice()
const clientPrice = (p, promos, mode) => {
  const map = {}
  for (const pr of promos) {
    if (!pr.active || pr.startDate > TODAY || pr.endDate < TODAY) continue
    for (const it of pr.items) {
      const v = num(it.promoPrice)
      if (v > 0 && (!map[it.productId] || v < map[it.productId])) map[it.productId] = v
    }
  }
  return map[p.id] || (mode === 'wholesale' && p.wholesalePrice > 0 ? p.wholesalePrice : p.price)
}
// product_effective_price() in SQL
const serverPrice = (p, promos, type) => {
  const c = []
  for (const pr of promos) {
    if (pr.active !== true) continue
    if (!((pr.startDate ?? '0000-01-01') <= TODAY)) continue
    if (!((pr.endDate ?? '9999-12-31') >= TODAY)) continue
    for (const it of pr.items) if (it.productId === p.id && num(it.promoPrice) > 0) c.push(num(it.promoPrice))
  }
  if (c.length) return Math.min(...c)
  if (type === 'Wholesale' && num(p.wholesalePrice) > 0) return p.wholesalePrice
  return p.price
}

const P = { id: 'p1', price: 100, wholesalePrice: 80 }
const promo = (o) => ({ active: true, startDate: null, endDate: null, items: [{ productId: 'p1', promoPrice: 70 }], ...o })

for (const [name, promos, mode, type] of [
  ['no promos, retail', [], 'retail', 'Retail'],
  ['no promos, wholesale', [], 'wholesale', 'Wholesale'],
  ['active promo beats retail', [promo({ startDate: '2026-08-01', endDate: '2026-09-30' })], 'retail', 'Retail'],
  ['active promo beats wholesale', [promo({ startDate: '2026-08-01', endDate: '2026-09-30' })], 'wholesale', 'Wholesale'],
  ['expired promo ignored', [promo({ startDate: '2026-01-01', endDate: '2026-02-01' })], 'retail', 'Retail'],
  ['future promo ignored', [promo({ startDate: '2026-12-01', endDate: '2026-12-31' })], 'retail', 'Retail'],
  ['inactive promo ignored', [promo({ active: false })], 'retail', 'Retail'],
  // NULL dates mean unbounded on BOTH sides. Getting this wrong rejected real sales.
  ['NULL dates are unbounded', [promo({})], 'retail', 'Retail'],
  ['NULL start only', [promo({ endDate: '2026-09-30' })], 'retail', 'Retail'],
  ['NULL end only', [promo({ startDate: '2026-08-01' })], 'retail', 'Retail'],
  ['lowest of two promos wins', [promo({ items: [{ productId: 'p1', promoPrice: 75 }] }), promo({ items: [{ productId: 'p1', promoPrice: 60 }] })], 'retail', 'Retail'],
  ['zero promoPrice ignored', [promo({ items: [{ productId: 'p1', promoPrice: 0 }] })], 'retail', 'Retail'],
  ['promo for another product', [promo({ items: [{ productId: 'zz', promoPrice: 10 }] })], 'wholesale', 'Wholesale'],
]) {
  const c = clientPrice(P, promos, mode), s = serverPrice(P, promos, type)
  t.ok(`${name} (client ${c} / server ${s})`, c === s)
}
const P2 = { id: 'p1', price: 100, wholesalePrice: 0 }
t.ok('wholesale mode with no wholesale price', clientPrice(P2, [], 'wholesale') === serverPrice(P2, [], 'Wholesale'))

const rejects = (client, server) => Math.abs(client - server) > 0.01
t.ok('matching totals accepted', !rejects(200, 200))
t.ok('rounding noise accepted', !rejects(200, 200.004))
t.ok('price changed is rejected', rejects(200, 180))
t.ok('tampered cheap total rejected', rejects(1, 200))
