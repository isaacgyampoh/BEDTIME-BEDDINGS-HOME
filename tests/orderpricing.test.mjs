import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from './harness.mjs'
import { priceCart, unitPrice, categoryQuantities, cartTotal } from '../storefront/src/lib/pricing.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const t = suite('Online order pricing: one rule, three places')

// public_order_create used to store the subtotal and total the browser sent.
// An order for a 450-cedi duvet could claim a total of 1.00, and nothing
// downstream would notice: the payment prompt checks the amount against the
// ORDER, and the order's figure came from the same request. 047 recomputes it
// in the database using the rule below — so the rule has to be exactly the one
// the customer was shown, or honest wholesale orders start getting refused.
// (tests/pricing.test.mjs covers the same question for the till's record_sale.)

const towel = { id: 't', category: 'Towels', retailPrice: 60, wp: 45, wm: 5, qty: 1 }
const duvet = { id: 'd', category: 'Beddings', retailPrice: 450, wp: 400, wm: 3, qty: 1 }

t.eq('one towel is retail', unitPrice({ ...towel }, { categoryQty: 1 }).price, 60)
t.eq('five towels reach the wholesale minimum', unitPrice({ ...towel }, { categoryQty: 5 }).price, 45)
t.ok('and are marked as wholesale', unitPrice({ ...towel }, { categoryQty: 5 }).isWholesale)
t.eq('four do not', unitPrice({ ...towel }, { categoryQty: 4 }).price, 60)
t.eq('a promotion beats the wholesale price', unitPrice({ ...towel }, { promo: { price: 30 }, categoryQty: 9 }).price, 30)
t.ok('and is not called wholesale', !unitPrice({ ...towel }, { promo: { price: 30 }, categoryQty: 9 }).isWholesale)
t.eq('no wholesale price means retail', unitPrice({ ...towel, wp: 0 }, { categoryQty: 50 }).price, 60)
t.eq('no minimum means retail', unitPrice({ ...towel, wm: 0 }, { categoryQty: 50 }).price, 60)

// The minimum counts the CATEGORY, not the single product — five towels of
// mixed colours qualify, which is how the shop actually sells.
const mixed = [
  { ...towel, id: 'yellow', qty: 3 },
  { ...towel, id: 'blue', qty: 2 },
  { ...duvet, qty: 1 },
]
t.eq('quantities are counted per category', categoryQuantities(mixed), { Towels: 5, Beddings: 1 })
const priced = priceCart(mixed, {})
t.eq('both towel lines get the wholesale rate', priced.filter(c => c.category === 'Towels').map(c => c.price), [45, 45])
t.eq('the duvet does not, with only one', priced.find(c => c.category === 'Beddings').price, 450)
t.eq('the order total follows', cartTotal(priced), 45 * 5 + 450)
t.eq('a promotion applies per product, not per category',
  priceCart(mixed, { yellow: { price: 25 } }).map(c => c.price), [25, 45, 450])
t.eq('an empty cart costs nothing', cartTotal(priceCart([], {})), 0)
t.ok('re-pricing does not mutate the cart', mixed[0].price === undefined)

// The database function must implement this same rule, so the two cannot
// quietly drift apart.
const sql = readFileSync(join(root, 'supabase/migrations/047_order_total_computed_server_side.sql'), 'utf8')
t.ok('047 recomputes rather than trusting the request', /SUM\(unit \* qty\)/.test(sql))
t.ok('047 prefers a live promotion', /COALESCE\(\s*j\.promo/.test(sql))
t.ok('047 tests the wholesale minimum against the category total',
  /SUM\(j\.qty\) OVER \(PARTITION BY j\.category\) >= j\.wm/.test(sql))
t.ok('047 falls back to retail', /j\.retail/.test(sql))
t.ok('047 counts a promotion only while it is running',
  /start_date <= CURRENT_DATE/.test(sql) && /end_date\s+>= CURRENT_DATE/.test(sql))
t.ok('047 refuses an order for more than is in stock', /has only/.test(sql))
t.ok('047 refuses rather than silently repricing', /Prices have changed/.test(sql))
t.ok('047 stores its own figure, not the one sent', /v_total, v_total/.test(sql))
