import { suite } from './harness.mjs'
import {
  isLive, buildPromoMap, discountPct, promoHeading, promoEndsAt, promoFirst, orderPromoFirst,
  promoSavings, isPromoOver, promoIds,
} from '../storefront/src/lib/promo.js'
const t = suite('Shop front: Black Friday promotion')

const TODAY = '2026-10-10'
const bf = {
  name: 'Black Friday Deals', active: true, start_date: '2026-10-09', end_date: '2026-10-11',
  items: [
    { productId: 'a', promoPrice: 95 },     // from 120 → -21%
    { productId: 'b', promoPrice: 300 },    // from 320 → -6%
  ],
}
const products = [
  { id: 'a', name: 'Dish set', price: 120 },
  { id: 'b', name: 'Dinner set', price: 320 },
  { id: 'c', name: 'Pillow', price: 50 },     // not in the promo
  { id: 'd', name: 'Duvet', price: 450 },     // not in the promo
]

// ── when a promo counts ────────────────────────────────────────────────────
// The site used `new Date(end_date) < now`, so a promo vanished at midnight ON
// its last day while the till was still selling it. Both ends count now, the
// same rule the till and the admin promo list use.
t.ok('live on the first day', isLive(bf, '2026-10-09'))
t.ok('live in the middle', isLive(bf, TODAY))
t.ok('LIVE ON THE LAST DAY', isLive(bf, '2026-10-11'))
t.ok('over the day after', !isLive(bf, '2026-10-12'))
t.ok('not yet on the day before', !isLive(bf, '2026-10-08'))
t.ok('an inactive promo never shows', !isLive({ ...bf, active: false }, TODAY))
t.ok('no end date means it runs on', isLive({ ...bf, end_date: null }, '2027-01-01'))
t.ok('no start date means it has begun', isLive({ ...bf, start_date: null }, TODAY))
t.ok('a timestamp end date still works', isLive({ ...bf, end_date: '2026-10-11T00:00:00+00:00' }, '2026-10-11'))

// ── which products are in it ───────────────────────────────────────────────
const { map, active } = buildPromoMap([bf], TODAY)
t.eq('only the promo products are mapped', Object.keys(map).sort(), ['a', 'b'])
t.eq('at the promotional price', map.a.price, 95)
t.eq('one live promo', active.length, 1)
t.eq('an expired promo contributes nothing', Object.keys(buildPromoMap([{ ...bf, end_date: '2026-10-01' }], TODAY).map).length, 0)
t.eq('a future promo contributes nothing', Object.keys(buildPromoMap([{ ...bf, start_date: '2026-12-01' }], TODAY).map).length, 0)
t.eq('items stored as a JSON string still parse', Object.keys(buildPromoMap([{ ...bf, items: JSON.stringify(bf.items) }], TODAY).map).length, 2)
t.eq('malformed items are skipped, not thrown', Object.keys(buildPromoMap([{ ...bf, items: '{not json' }], TODAY).map).length, 0)
t.eq('a zero price is not a promotion', Object.keys(buildPromoMap([{ ...bf, items: [{ productId: 'a', promoPrice: 0 }] }], TODAY).map).length, 0)
t.eq('in two live promos, the cheaper wins',
  buildPromoMap([bf, { ...bf, name: 'Clearance', items: [{ productId: 'a', promoPrice: 80 }] }], TODAY).map.a.price, 80)

// ── the section ────────────────────────────────────────────────────────────
const promoted = promoFirst(products, map)
t.eq('the section holds ONLY promo products', promoted.map(p => p.id), ['a', 'b'])
t.ok('no normal product appears in it', !promoted.some(p => p.id === 'c' || p.id === 'd'))
t.eq('biggest saving leads', promoted[0].id, 'a')
t.eq('nothing live means no section at all', promoFirst(products, buildPromoMap([], TODAY).map).length, 0)

t.eq('the heading is what the shop called it', promoHeading([bf]), 'Black Friday Deals')
t.eq('a bare name gets "Deals" added', promoHeading([{ name: 'Black Friday' }]), 'Black Friday Deals')
t.eq('"Easter Sale" is left alone', promoHeading([{ name: 'Easter Sale' }]), 'Easter Sale')
t.eq('two promos get a neutral heading', promoHeading([bf, { name: 'Clearance' }]), 'Deals')
t.eq('no promo, no heading to show', promoHeading([]), 'Deals')

// The countdown must run to the END of the last day, not its midnight start.
t.eq('countdown targets the end of the last day', promoEndsAt([bf]), '2026-10-11T23:59:59+00:00')
t.eq('the latest end date wins', promoEndsAt([bf, { end_date: '2026-10-20' }]), '2026-10-20T23:59:59+00:00')
t.eq('no end date, no countdown', promoEndsAt([{ name: 'x' }]), null)

// ── the rest of the catalogue ──────────────────────────────────────────────
const ordered = orderPromoFirst(products, map)
t.eq('promo products come first in the grid', ordered.map(p => p.id), ['a', 'b', 'c', 'd'])
t.eq('every product is still there', ordered.length, products.length)
t.eq('normal products keep their own order', ordered.slice(2).map(p => p.id), ['c', 'd'])
t.eq('a filtered list is re-ordered, not re-filtered',
  orderPromoFirst(products.filter(p => p.id === 'c' || p.id === 'b'), map).map(p => p.id), ['b', 'c'])
t.eq('with no promo the order is untouched', orderPromoFirst(products, {}).map(p => p.id), ['a', 'b', 'c', 'd'])

// ── what the badge claims ──────────────────────────────────────────────────
t.eq('120 → 95 is 21% off', discountPct(120, 95), 21)
t.eq('320 → 300 is 6% off', discountPct(320, 300), 6)
t.eq('a "promo" price that is higher claims nothing', discountPct(100, 120), 0)
t.eq('an equal price claims nothing', discountPct(100, 100), 0)
t.eq('a missing original claims nothing', discountPct(0, 50), 0)

// ── what the promotion is worth ────────────────────────────────────────────
// "12 items" says nothing a shopper can weigh. The biggest saving and the
// cedis kept are what the heading needs.
{
  const map = buildPromoMap([bf], TODAY).map
  const s = promoSavings(products, map)
  t.eq('counts only the discounted products', s.count, 2)
  t.eq('reports the biggest saving', s.maxPct, 21)
  t.eq('adds up what is kept, in cedis', s.totalSaved, 45)   // 120-95 + 320-300
  const none = promoSavings(products, {})
  t.eq('nothing live, nothing claimed', none.count, 0)
  t.eq('and no percentage invented', none.maxPct, 0)
}

// ── the countdown runs on Ghana's clock, not the viewer's ──────────────────
// Without the offset, `new Date('2026-10-11T23:59:59')` is read in whatever
// timezone the browser sits in: a customer in London saw the sale end an hour
// early, one in New York saw five hours that did not exist.
{
  const ends = promoEndsAt([bf])
  t.eq('ends at the close of the last day, in UTC+0', ends, '2026-10-11T23:59:59+00:00')
  t.eq('which is an unambiguous instant', new Date(ends).toISOString(), '2026-10-11T23:59:59.000Z')
  t.eq('no promo, no countdown', promoEndsAt([]), null)
}

// ── a tab left open past the end ───────────────────────────────────────────
// The promos are read once on load. Left open overnight the page kept showing
// yesterday's prices, and public_order_create refused the order with "prices
// have changed" — correct, and baffling beside a label still saying 300.
{
  const ends = promoEndsAt([bf])
  t.ok('still running during the sale', !isPromoOver(ends, Date.parse('2026-10-11T12:00:00Z')))
  t.ok('still running in its last second', !isPromoOver(ends, Date.parse('2026-10-11T23:59:58Z')))
  t.ok('over once the last day closes', isPromoOver(ends, Date.parse('2026-10-12T00:00:01Z')))
  t.ok('no end date is not an expiry', !isPromoOver(null, Date.now()))
  t.ok('a date that makes no sense does not expire everything', !isPromoOver('not a date', Date.now()))
}

// ── which products the promotion already showed ────────────────────────────
// The homepage printed the same discounted duvet twice: once in the promotion,
// once in New arrivals a scroll below.
{
  const map = buildPromoMap([bf], TODAY).map
  const shown = promoIds(products, map)
  t.eq('knows the two it showed', shown.size, 2)
  t.ok('the discounted ones', shown.has('a') && shown.has('b'))
  t.ok('and not the rest', !shown.has('c') && !shown.has('d'))
  const rest = products.filter(p => !shown.has(p.id))
  t.eq('so New arrivals has the others', rest.map(p => p.id).join(','), 'c,d')
}
