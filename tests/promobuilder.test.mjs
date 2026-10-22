import { suite } from './harness.mjs'
import { matchProducts, toItem, applyPercent, applyFixed, validate, summarise, round2, groupProducts, commonName } from '../src/lib/promoBuilder.js'
const t = suite('Admin: building a promotion')

// The shop really does sell one bedsheet in forty colours, each its own row.
const sheets = Array.from({ length: 40 }, (_, i) => ({
  id: `s${i + 1}`, name: `1 Double Bedsheet with 2 pillow cases (color ${i + 1})`,
  category: 'Bedsheets', price: 80,
}))
const products = [
  ...sheets,
  { id: 'd1', name: 'Satin Duvet Set', category: 'Duvets', price: 450 },
  { id: 'p1', name: 'Memory Pillow', category: 'Pillows', price: 90 },
  { id: 'm1', name: 'Mattress Topper', category: 'Toppers', price: 600 },
]

// ── finding what to put in ─────────────────────────────────────────────────
// One search has to reach all forty, or we are back to forty trips through a
// dropdown of 652 products.
t.eq('one search reaches every colour', matchProducts(products, { query: 'bedsheet' }).length, 40)
t.eq('words may be in any order', matchProducts(products, { query: 'pillow double' }).length, 40)
t.eq('and narrow to one colour', matchProducts(products, { query: 'bedsheet color 21' }).length, 1)
t.eq('the category alone works', matchProducts(products, { category: 'Duvets' }).length, 1)
t.eq('category and words together', matchProducts(products, { query: 'topper', category: 'Toppers' }).length, 1)
t.eq('nothing typed is everything', matchProducts(products, {}).length, 43)
t.eq('a word that matches nothing finds nothing', matchProducts(products, { query: 'curtain' }).length, 0)
t.ok('a category search still reads the name', matchProducts(products, { query: 'bedsheets' }).length === 40)

// ── pricing them all at once ───────────────────────────────────────────────
{
  const items = matchProducts(products, { query: 'bedsheet' }).map(toItem)
  t.eq('a product becomes a line with no price yet', items[0].promoPrice, '')
  t.eq('carrying the price it sells at', items[0].originalPrice, 80)

  const pct = applyPercent(items, 20)
  t.eq('20% off 80 is 64', pct[0].promoPrice, 64)
  t.eq('applied to all forty', pct.filter(i => i.promoPrice === 64).length, 40)

  const fixed = applyFixed(items, 75)
  t.eq('or everything at one price', fixed[0].promoPrice, 75)
  t.eq('all forty of them', fixed.filter(i => i.promoPrice === 75).length, 40)

  // Half a pesewa is not money.
  t.eq('prices are rounded to the pesewa', applyPercent([{ productId: 'x', originalPrice: 99.99 }], 33)[0].promoPrice, 66.99)
  t.eq('round2 keeps two places', round2(12.3456), 12.35)

  // Correcting part of a promotion must not disturb prices set by hand.
  const some = applyFixed(pct, 70, new Set(['s1', 's2']))
  t.eq('a correction reaches the ones chosen', some.find(i => i.productId === 's1').promoPrice, 70)
  t.eq('and leaves the others alone', some.find(i => i.productId === 's3').promoPrice, 64)

  // Nonsense is ignored rather than written into prices.
  t.eq('0% changes nothing', applyPercent(items, 0)[0].promoPrice, '')
  t.eq('100% off changes nothing', applyPercent(items, 100)[0].promoPrice, '')
  t.eq('a negative price changes nothing', applyFixed(items, -5)[0].promoPrice, '')
}

// ── refusing to save something wrong ───────────────────────────────────────
{
  const good = { name: 'Black Friday', startDate: '2026-11-25', endDate: '2026-11-30',
                 items: [{ productId: 'a', name: 'Sheet', originalPrice: 80, promoPrice: 75 }] }
  t.eq('a complete promotion has nothing wrong with it', validate(good).length, 0)
  t.ok('a nameless one is refused', validate({ ...good, name: '  ' }).includes('Give the promotion a name'))
  t.ok('so is one with no products', validate({ ...good, items: [] }).includes('Add at least one product'))
  t.ok('ending before it starts is caught', validate({ ...good, endDate: '2026-11-01' })
        .includes('The end date is before the start date'))

  const oneBlank = validate({ ...good, items: [{ productId: 'a', name: 'Sheet', originalPrice: 80, promoPrice: '' }] })
  t.ok('one missing price names the product', oneBlank.some(m => m.includes('Sheet')))
  const manyBlank = validate({ ...good, items: sheets.slice(0, 7).map(toItem) })
  t.ok('seven missing prices are counted, not listed', manyBlank.some(m => m.includes('7 products')))

  // The mistake that reaches a customer's receipt before anyone notices.
  const dearer = validate({ ...good, items: [{ productId: 'a', name: 'Sheet', originalPrice: 80, promoPrice: 95 }] })
  t.ok('a promo price above the normal price is refused', dearer.some(m => m.includes('not cheaper')))
  const same = validate({ ...good, items: [{ productId: 'a', name: 'Sheet', originalPrice: 80, promoPrice: 80 }] })
  t.ok('and so is the same price', same.some(m => m.includes('not cheaper')))
}

// ── saying it in one line instead of forty ─────────────────────────────────
{
  const forty = applyFixed(matchProducts(products, { query: 'bedsheet' }).map(toItem), 75)
  const s = summarise(forty)
  t.eq('counts what is in it', s.count, 40)
  t.ok('sees that every one is the same', s.uniform)
  t.eq('from this price', s.from, 80)
  t.eq('to that one', s.to, 75)
  t.eq('which is 6% off', s.maxPct, 6)

  const mixed = summarise([
    { productId: 'a', originalPrice: 80, promoPrice: 75 },
    { productId: 'b', originalPrice: 450, promoPrice: 270 },
  ])
  t.ok('mixed prices are not called uniform', !mixed.uniform)
  t.eq('and the best saving leads', mixed.maxPct, 40)

  const none = summarise([{ productId: 'a', originalPrice: 80, promoPrice: '' }])
  t.eq('nothing priced yet claims no saving', none.maxPct, 0)
  t.eq('an empty promotion counts nothing', summarise([]).count, 0)
}

// ── forty colours are one row, not forty ───────────────────────────────────
// Products.jsx already asks the shop to tag every colour of a product with the
// same variant group, so that five across colours trigger wholesale. The promo
// picker reads the same tag: one row, one button, forty products.
{
  const tagged = sheets.map(s => ({ ...s, groupTag: 'double-bedsheet-2-cases' }))
  const rows = groupProducts([...tagged,
    { id: 'd1', name: 'Satin Duvet Set', category: 'Duvets', price: 450, groupTag: '' },
    { id: 'p1', name: 'Memory Pillow', category: 'Pillows', price: 90 }])
  t.eq('forty variants and two singles make three rows', rows.length, 3)
  t.eq('the group holds all forty', rows[0].items.length, 40)
  t.eq('and is named by what they share', rows[0].label, '1 Double Bedsheet with 2 pillow cases')
  t.eq('an untagged product is its own row', rows[1].items.length, 1)
  t.eq('named as itself', rows[1].label, 'Satin Duvet Set')
  t.ok('a group keeps its tag', rows[0].tag === 'double-bedsheet-2-cases')
  t.eq('and the row appears where its first member did', rows[0].key, 'g:double-bedsheet-2-cases')

  // Variants at different prices show the range rather than claiming one.
  const mixed = groupProducts([
    { id: 'x1', name: 'Curtain (blue)', price: 120, groupTag: 'curtain' },
    { id: 'x2', name: 'Curtain (gold)', price: 180, groupTag: 'curtain' }])
  t.eq('a group spanning prices reports the floor', mixed[0].priceFrom, 120)
  t.eq('and the ceiling', mixed[0].priceTo, 180)

  t.eq('no products, no rows', groupProducts([]).length, 0)
}

// ── naming a group from its members ────────────────────────────────────────
t.eq('the shared opening is the name',
  commonName(['Sunblock Curtain (color 1)', 'Sunblock Curtain (color 2)']), 'Sunblock Curtain')
t.eq('a dangling bracket is dropped',
  commonName(['Sheet (color 1)', 'Sheet (color 2)']), 'Sheet')
t.eq('one name is its own name', commonName(['Only One']), 'Only One')
t.eq('nothing shared gives nothing', commonName(['Duvet', 'Pillow']), '')
t.eq('too little shared gives nothing', commonName(['A blue', 'A gold']), '')
