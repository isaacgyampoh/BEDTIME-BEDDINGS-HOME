import { suite } from './harness.mjs'
import { matchProducts, respond } from '../storefront/src/lib/voiceShop.js'
const t = suite('Voice search: a natural sentence must find real stock')

// The reported failure, verbatim. The shop stocks two mattress toppers, and the
// assistant answered "I could not find that in the shop" — because matching
// required EVERY word to hit and no product contains "let" or "available".
// Names and categories below are the real ones from the catalogue.
const real = [
  { id: 'm1', name: 'Mattress Topper ash (king size)', category: 'Blankets', price: 600, quantity: 6 },
  { id: 'm2', name: 'Mattress Topper Purple (kingsize)', category: 'Blankets', price: 600, quantity: 4 },
  { id: 'b1', name: 'Hotel Standard White double bedsheet', category: 'Bed Sheets', price: 180, quantity: 26 },
  { id: 'b2', name: '7pcs Superkingsize Bedsheets (design 4)', category: 'Bed Sheets', price: 450, quantity: 3 },
  { id: 'a1', name: 'inflatable air bed (single)', category: 'Bed Sheets', price: 390, quantity: 2 },
  { id: 'd1', name: '4pcs Duvet Cover Set (design 1)', category: 'Bed Sheets', price: 320, quantity: 3 },
  { id: 'mat', name: '3in1 Bath Mat Set (gray)', category: 'Mats', price: 120, quantity: 4 },
  { id: 'tw', name: 'Bath size Towel', category: 'Towels & Covers', price: 60, quantity: 7 },
]
const ctx = { products: real, promoMap: {}, cart: [], lastResults: [], checkout: {} }
const names = (q) => matchProducts(q, real).map(p => p.name)

// The exact sentence that failed.
t.eq('"Let me see all the mattress toppers available" finds both toppers',
  names('Let me see all the mattress toppers available').sort(),
  ['Mattress Topper Purple (kingsize)', 'Mattress Topper ash (king size)'])
t.ok('and says it found them', /found 2|Mattress Topper/.test(respond('Let me see all the mattress toppers available', ctx).say))
t.ok('it no longer claims the shop does not stock them',
  !/could not find/i.test(respond('Let me see all the mattress toppers available', ctx).say))

// Filler words must never empty a result set again, however the sentence runs.
for (const phrase of [
  'mattress toppers', 'show me mattress toppers', 'do you have any mattress toppers',
  'I want to see the mattress toppers you have', 'please kindly show me all available mattress toppers',
  'what mattress toppers are there', 'mattress topper',
]) {
  t.ok(`"${phrase}" finds them`, names(phrase).length === 2, names(phrase).join(' | '))
}

// A short fragment must not match a longer word: "mat" is not "mattress".
t.ok('a Bath Mat Set is not a mattress topper', !names('mattress toppers').includes('3in1 Bath Mat Set (gray)'))

// Words said apart may be one word in the catalogue.
t.eq('"bed sheets" leads with actual bedsheets, not an air bed',
  names('What bed sheets are available?')[0], 'Hotel Standard White double bedsheet')
t.ok('the air bed is not first just because it contains "bed"',
  names('What bed sheets are available?')[0] !== 'inflatable air bed (single)')

// A name match beats a category match: everything above is in "Bed Sheets".
t.eq('"duvet covers" returns the duvet covers', names('Do you have duvet covers?'), ['4pcs Duvet Cover Set (design 1)'])
t.eq('"towels" returns the towel', names('show me towels and bedding sets'), ['Bath size Towel'])

// Nothing is invented when the shop genuinely does not stock something.
t.eq('aeroplanes are not sold here', names('show me aeroplanes'), [])
t.ok('and the shopper is told plainly', /could not find/i.test(respond('show me aeroplanes', ctx).say))

// Out of stock is still excluded from what can be bought.
const oos = [{ id: 'x', name: 'Mattress Topper blue', category: 'Blankets', price: 600, quantity: 0 }]
t.eq('an out-of-stock topper is not offered',
  (respond('mattress toppers', { ...ctx, products: oos }).results || []).length, 0)

// Descriptions are searched too, where the shop has filled them in.
const described = [{ id: 'z', name: 'Comfort Layer', category: 'Blankets', description: 'A soft mattress topper for a king bed', price: 500, quantity: 2 }]
t.eq('a product found only by its description still matches',
  matchProducts('mattress topper', described).length, 1)
