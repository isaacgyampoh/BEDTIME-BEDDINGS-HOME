import { suite } from './harness.mjs'
const t = suite('Money, discounts and stock')

const money = n => 'GHS ' + Number(n || 0).toFixed(2)
const num = n => Number(n) || 0

// money() already carries the currency. Interpolating "GHS ${money(x)}" printed
// "GHS GHS 250.00" on receipts and in customer WhatsApp messages.
t.eq('money() includes the currency once', money(250), 'GHS 250.00')
t.ok('no double prefix in a composed message',
  !`Your order is ${money(250)}.`.includes('GHS GHS'))

// A negative discount used to inflate the total above the subtotal.
const total = (sub, d) => sub - Math.min(Math.max(0, num(d)), sub)
t.eq('normal discount applies', total(100, 20), 80)
t.eq('negative discount cannot inflate', total(100, -50), 100)
t.eq('over-discount floors at zero', total(100, 500), 0)
t.eq('blank discount is a no-op', total(100, ''), 100)

// deductStock must return NEW objects: mutating in place left memoised
// components holding an unchanged reference, so stock badges went stale.
const deductStock = (products, cart) => {
  const d = {}
  for (const c of cart) {
    if (c.isBundle && c.bundleItems) for (const bi of c.bundleItems) d[bi.productId] = (d[bi.productId] || 0) + num(bi.qty) * c.qty
    else if (c.productId) d[c.productId] = (d[c.productId] || 0) + c.qty
  }
  return products.map(p => d[p.id] ? { ...p, quantity: Math.max(0, p.quantity - d[p.id]) } : p)
}
const before = [{ id: 'a', quantity: 10 }, { id: 'b', quantity: 3 }, { id: 'c', quantity: 5 }]
const snap = JSON.stringify(before)
const after = deductStock(before, [
  { productId: 'a', qty: 2 },
  { isBundle: true, qty: 2, bundleItems: [{ productId: 'b', qty: 1 }, { productId: 'a', qty: 1 }] },
])
t.eq('a: 10 - 2 - (1x2 bundle)', after[0].quantity, 6)
t.eq('b: 3 - (1x2 bundle)', after[1].quantity, 1)
t.ok('untouched product keeps its identity', after[2] === before[2])
t.ok('changed product is a new object', after[0] !== before[0])
t.eq('originals were not mutated', JSON.stringify(before), snap)
t.eq('never goes negative', deductStock([{ id: 'x', quantity: 1 }], [{ productId: 'x', qty: 9 }])[0].quantity, 0)

// Excel treats a leading = + - @ as a formula; product names are free text.
const csvCell = (v) => {
  const s = String(v ?? '')
  return '"' + (/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"'
}
t.eq('formula prefix neutralised', csvCell('=1+1'), `"'=1+1"`)
t.eq('quotes doubled', csvCell('12" pillow'), '"12"" pillow"')
t.eq('zero is preserved, not blanked', csvCell(0), '"0"')
t.eq('null becomes empty', csvCell(null), '""')
