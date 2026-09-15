import { suite } from './harness.mjs'
const t = suite('Catalogue data health')
const num = n => Number(n) || 0

const T = {
  noCost:   p => num(p.price) > 0 && !num(p.costPrice),
  belowCost:p => num(p.costPrice) > 0 && num(p.price) > 0 && num(p.price) < num(p.costPrice),
  noPrice:  p => !num(p.price),
  wsNot:    p => num(p.wholesalePrice) > 0 && num(p.price) > 0 && num(p.wholesalePrice) >= num(p.price),
  wsNoMin:  p => num(p.wholesalePrice) > 0 && !num(p.wholesaleMinQty),
  negStock: p => num(p.quantity) < 0,
}
const ok = { price:100, costPrice:60, wholesalePrice:80, wholesaleMinQty:5, quantity:3, category:'x', image:'y' }

t.ok('healthy product raises nothing', !Object.values(T).some(f => f({ ...ok })))
t.ok('missing cost flagged',      T.noCost({ ...ok, costPrice: 0 }))
t.ok('zero price is not "no cost"', !T.noCost({ ...ok, price: 0, costPrice: 0 }))
t.ok('below cost flagged',        T.belowCost({ ...ok, price: 50 }))
t.ok('equal to cost is not below',!T.belowCost({ ...ok, price: 60 }))
t.ok('no price flagged',          T.noPrice({ ...ok, price: 0 }))
t.ok('wholesale >= retail flagged', T.wsNot({ ...ok, wholesalePrice: 100 }))
t.ok('wholesale above retail flagged', T.wsNot({ ...ok, wholesalePrice: 120 }))
t.ok('cheaper wholesale is fine',  !T.wsNot({ ...ok }))
t.ok('wholesale with no minimum flagged', T.wsNoMin({ ...ok, wholesaleMinQty: 0 }))
t.ok('no wholesale price raises neither', !T.wsNot({ ...ok, wholesalePrice: 0 }) && !T.wsNoMin({ ...ok, wholesalePrice: 0 }))
t.ok('negative stock flagged',    T.negStock({ ...ok, quantity: -2 }))
t.ok('zero stock is not negative',!T.negStock({ ...ok, quantity: 0 }))

// The exposure figure must count only the zero-cost LINES, not whole sales.
const exposure = (sales) => {
  let value = 0, affected = 0
  for (const s of sales) {
    if (s.voided) continue
    const bad = (s.items || []).filter(i => !num(i.costPrice))
    if (!bad.length) continue
    affected++
    value += bad.reduce((a, i) => a + num(i.lineTotal || num(i.price) * num(i.qty)), 0)
  }
  return { affected, value }
}
const mixed = [{ voided:false, items:[{costPrice:5,lineTotal:50},{costPrice:0,lineTotal:80}] }]
t.eq('counts only the unknown-cost line', exposure(mixed).value, 80)
t.eq('counts the sale once', exposure(mixed).affected, 1)
t.eq('voided sales excluded', exposure([{ voided:true, items:[{costPrice:0,lineTotal:999}] }]).value, 0)
t.eq('falls back to price x qty', exposure([{ voided:false, items:[{costPrice:0,price:20,qty:3}] }]).value, 60)
