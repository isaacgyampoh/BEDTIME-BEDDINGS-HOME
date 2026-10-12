import { suite } from './harness.mjs'
import { respond, matchProducts, parseQty, parseReference, clean } from '../storefront/src/lib/voiceShop.js'
const t = suite('Voice shopping: understanding a shopper')

// A catalogue shaped like the real one: flat products, no variants, Ghana cedis.
const products = [
  { id: 'd1', name: '6pcs Kingsize Duvet set', category: 'Beddings', price: 450, quantity: 4 },
  { id: 'd2', name: '4pcs Duvet set (double)', category: 'Beddings', price: 320, quantity: 2 },
  { id: 'b1', name: 'Cotton Bedsheet 4pcs', category: 'Beddings', price: 240, quantity: 6 },
  { id: 't1', name: 'Bath Towel (yellow)', category: 'Towels', price: 60, quantity: 0 },
  { id: 't2', name: 'Bath Towel (blue)', category: 'Towels', price: 60, quantity: 5 },
  { id: 'k1', name: '16pcs Ceramic Dinner Set', category: 'Kitchenware', price: 290, quantity: 3 },
]
const promoMap = { d1: { price: 400, name: 'Black Friday Deals' } }
const base = { products, promoMap, cart: [], lastResults: [] }
const ask = (text, extra = {}) => respond(text, { ...base, ...extra })

// ── finding things ─────────────────────────────────────────────────────────
t.eq('"show me duvets" finds only duvets', ask('show me duvets').results.map(p => p.id).sort(), ['d1', 'd2'])
t.ok('it does not return the whole catalogue', ask('show me duvets').results.length < products.length)
t.ok('out-of-stock items are not offered', !ask('show me bath towels').results.some(p => p.id === 't1'))
t.ok('a word that matches nothing says so', /could not find/i.test(ask('show me laptops').say))
t.ok('a near-miss does not match: bedsheet is not a duvet',
  !matchProducts('duvet', products).some(p => p.id === 'b1'))
t.eq('a two-word phrase matches the right thing', matchProducts('dinner set', products).map(p => p.id), ['k1'])
t.ok('plurals work', matchProducts('towels', products).length === 2)

// Counting: listings, in-stock listings and units are different numbers and
// the assistant must not blur them.
const count = ask('how many duvets do you have')
t.ok('counts listings and units separately', /2 items match/.test(count.say) && /6 units/.test(count.say), count.say)
t.ok('counting excludes out of stock from "in stock"', /1 in stock/.test(ask('how many bath towels do you have').say),
  ask('how many bath towels do you have').say)

// ── comparing ──────────────────────────────────────────────────────────────
const shown = ask('show me duvets')
const cheapest = ask('which one is cheapest', { lastResults: shown.lastResults })
t.ok('cheapest compares the items just shown', /4pcs Duvet set/.test(cheapest.say), cheapest.say)
t.ok('cheapest uses the promotional price when there is one',
  /400\.00/.test(respond('cheapest', { ...base, lastResults: [products[0]] }).say),
  respond('cheapest', { ...base, lastResults: [products[0]] }).say)
t.ok('most expensive is the other end', /Kingsize/.test(ask('most expensive', { lastResults: shown.lastResults }).say))
t.ok('comparing with nothing shown asks for a search first', /search for something/i.test(ask('which is cheapest').say))

// ── adding ─────────────────────────────────────────────────────────────────
const one = ask('show me the ceramic dinner set')
const add = respond('add it to my cart', { ...base, lastResults: one.lastResults })
t.eq('"add it" adds the item just shown', add.action.kind + ':' + add.action.product.id, 'add:k1')
t.eq('one by default', add.action.qty, 1)
t.eq('"add two" adds two', respond('add two', { ...base, lastResults: one.lastResults }).action.qty, 2)
t.eq('digits work as well', respond('add 3', { ...base, lastResults: one.lastResults }).action.qty, 3)
t.ok('the spoken confirmation quotes the real price', /290\.00/.test(add.say), add.say)
t.ok('adding by name works without anything shown', respond('add the cotton bedsheet', base).action.product.id === 'b1')

// Ambiguity must be asked about, never guessed.
const ambiguous = respond('add one', { ...base, lastResults: shown.lastResults })
t.eq('two candidates: it asks which', ambiguous.action, null)
t.ok('and names the choices', /which one/i.test(ambiguous.say), ambiguous.say)
t.eq('"the second one" resolves the reference',
  parseReference('the second one', shown.lastResults).id, shown.lastResults[1].id)
t.eq('a distinguishing word resolves it', parseReference('the blue one', [products[3], products[4]]).id, 't2')

// Stock is respected, and an alternative offered.
const oos = respond('add the yellow bath towel', base)
t.eq('an out-of-stock item is not added', oos.action, null)
t.ok('and the shopper is told, with a real alternative', /out of stock/i.test(oos.say) && /blue/i.test(oos.say), oos.say)
t.eq('quantity is capped at the stock on hand',
  respond('add 10', { ...base, lastResults: [products[1]] }).action.qty, 2)

// ── the cart ───────────────────────────────────────────────────────────────
const cart = [{ id: 'k1', name: '16pcs Ceramic Dinner Set', price: 290, qty: 2 }]
t.ok('it reads the real cart back', /2 16pcs Ceramic Dinner Set/.test(respond('what is in my cart', { ...base, cart }).say))
t.ok('and the real total', /580\.00/.test(respond('how much is my cart', { ...base, cart }).say))
t.eq('an empty cart is said plainly', respond('what is in my cart', base).say, 'Your cart is empty.')
t.eq('remove takes the item out', respond('remove the dinner set', { ...base, cart }).action, { kind: 'remove', id: 'k1' })
t.eq('clear empties it', respond('clear my cart', { ...base, cart }).action.kind, 'clearCart')

// ── checkout ───────────────────────────────────────────────────────────────
const co = respond('checkout', { ...base, cart })
t.eq('checkout navigates', co.action, { kind: 'navigate', page: 'checkout' })
t.ok('it never claims the order is placed', !/order (is )?placed|confirmed|bought/i.test(co.say), co.say)
t.ok('it hands over to the on-screen button', /press the button/i.test(co.say))
t.eq('checkout with an empty cart does nothing', respond('checkout', base).action, null)

// ── small things that matter ───────────────────────────────────────────────
t.eq('punctuation and case do not matter', clean('Show me, DUVETS!'), 'show me duvets')
t.eq('words for numbers', parseQty('add two please'), 2)
t.eq('no number means one', parseQty('add it'), 1)
t.ok('silence is handled', /did not catch/i.test(respond('', base).say))
t.ok('help explains what to say', /show me/i.test(respond('help', base).say))

// ── giving details for delivery ────────────────────────────────────────────
import { parsePhone, parseMaxPrice } from '../storefront/src/lib/voiceShop.js'
const t2 = suite('Voice shopping: finishing an order')

// Speech recognition returns "zero two four..." far more often than digits, so
// a digits-only reading would reject most spoken numbers.
t2.eq('a spoken number becomes a real one', parsePhone('my number is zero two four four zero zero one one two two'), '0244001122')
t2.eq('digits work too', parsePhone('0244001122'), '0244001122')
t2.eq('the international form is accepted', parsePhone('233244001122'), '0244001122')
t2.eq('a short number is refused, not guessed', parsePhone('my number is one two three'), null)
t2.eq('a landline-looking number is refused', parsePhone('0304001122'), null)

const name = respond('my name is ama mensah', base)
t2.eq('a name is captured', name.action, { kind: 'setCheckout', field: 'name', value: 'Ama Mensah' })
t2.ok('and the shopper is told what is still needed', /still need/.test(name.say), name.say)
t2.eq('a phone is captured', respond('my phone is zero two four four zero zero one one two two', base).action.value, '0244001122')
t2.ok('an unclear number asks again rather than saving rubbish',
  respond('my number is one two', base).action === null && /say it again/i.test(respond('my number is one two', base).say))
t2.eq('a delivery place keeps its capitals — it goes on a delivery label',
  respond('deliver to Kasoa near the market', base).action.value, 'Kasoa near the market')
t2.eq('"I live in" works too', respond('I live in East Legon, Accra', base).action.value, 'East Legon, Accra')
t2.ok('with everything filled it says so',
  /have everything/i.test(respond('what do you need', { ...base, checkout: { name: 'A', phone: '0244001122', address: 'Kasoa' } }).say))
t2.ok('"my name is" is not treated as a product search', respond('my name is ama', base).results === null)

// ── browsing like a person ─────────────────────────────────────────────────
t2.eq('"under 300" is understood', parseMaxPrice('show me duvets under 300'), 300)
t2.ok('and applied', respond('show me beddings under 300', base).results.every(p => p.price <= 300))
t2.ok('nothing under the limit offers the cheapest instead',
  /cheapest is/i.test(respond('show me beddings under 10', base).say), respond('show me beddings under 10', base).say)
t2.ok('"what is on offer" lists only promotional items',
  respond('what is on offer', base).results.every(p => !!promoMap[p.id]))
t2.ok('and quotes the saving', /down to .* from /.test(respond('any black friday deals', base).say))
t2.ok('no promotion says so plainly',
  /no promotion/i.test(respond('what is on offer', { ...base, promoMap: {} }).say))
t2.ok('"what do you sell" names real categories',
  /Beddings/.test(respond('what do you sell', base).say))

// ── changing your mind ─────────────────────────────────────────────────────
const cartOne = [{ id: 'b1', name: 'Cotton Bedsheet 4pcs', price: 240, qty: 1 }]
t2.eq('"make it three" changes the quantity',
  respond('make it three', { ...base, cart: cartOne }).action, { kind: 'setQty', id: 'b1', qty: 3 })
t2.ok('capped by stock', respond('make it 99', { ...base, cart: cartOne }).action.qty === 6)
t2.ok('with two items it asks which',
  /which item/i.test(respond('make it two', { ...base, cart: [...cartOne, { id: 'd1', name: 'Duvet', price: 450, qty: 1 }] }).say))
