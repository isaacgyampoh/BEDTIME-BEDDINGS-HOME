import { suite } from './harness.mjs'
import { runTool, toolSchemas, INSTRUCTIONS } from '../storefront/src/lib/voiceTools.js'
const t = suite('Voice tools: the only things the model may do')

const products = [
  { id: 'd1', name: '6pcs Kingsize Duvet set', category: 'Beddings', price: 450, quantity: 4 },
  { id: 'd2', name: '4pcs Duvet set (double)', category: 'Beddings', price: 320, quantity: 1 },
  { id: 't1', name: 'Bath Towel (yellow)', category: 'Towels', price: 60, quantity: 0 },
  { id: 't2', name: 'Bath Towel (blue)', category: 'Towels', price: 60, quantity: 5 },
]
const promoMap = { d1: { price: 400, name: 'Black Friday Deals' } }
const mk = (cart = []) => {
  const calls = []
  const ctx = {
    products, promoMap, cart,
    onAdd: (p, q) => calls.push(['add', p.id, q]),
    onRemove: (id) => calls.push(['remove', id]),
    onNavigate: (d) => calls.push(['nav', d]),
  }
  return { ctx, calls }
}

// The model is given tools, not the catalogue — it cannot answer from memory.
t.ok('the tools cover search, cart and checkout',
  ['search_products', 'add_to_cart', 'remove_from_cart', 'get_cart', 'go_to_checkout']
    .every(n => toolSchemas.some(s => s.name === n)))
t.ok('there is no tool that writes arbitrary data',
  toolSchemas.every(s => !/sql|query|exec|admin|price|order/i.test(s.name)))
t.ok('the instructions forbid inventing products', /never invent a product/i.test(INSTRUCTIONS))
t.ok('and forbid claiming an order was placed', /never say an order has been placed/i.test(INSTRUCTIONS))
t.ok('and forbid asking for card details', /card details, PINs or passwords/i.test(INSTRUCTIONS))

// search
const { ctx } = mk()
const s1 = runTool('search_products', { query: 'duvet' }, ctx)
t.eq('search returns only matching products', s1.result.products.map(p => p.id).sort(), ['d1', 'd2'])
t.eq('it reports the real price', s1.result.products.find(p => p.id === 'd2').price, '320.00')
t.eq('a promotional item is quoted at the promo price', s1.result.products.find(p => p.id === 'd1').price, '400.00')
t.eq('with the original shown as well', s1.result.products.find(p => p.id === 'd1').was, '450.00')
t.ok('out of stock is excluded by default',
  !runTool('search_products', { query: 'bath towel' }, ctx).result.products.some(p => p.id === 't1'))
t.ok('a max price filters', runTool('search_products', { query: 'duvet', max_price: 350 }, ctx).result.products.every(p => Number(p.price) <= 350))
t.ok('no match tells the model not to invent', /do not invent/i.test(runTool('search_products', { query: 'laptop' }, ctx).result.note || ''))
t.eq('cards are returned for the screen', s1.results.length, 2)

// add
{
  const { ctx, calls } = mk()
  const r = runTool('add_to_cart', { product_id: 'd1', quantity: 2 }, ctx)
  t.ok('adding uses the app\'s own cart function', r.result.ok && calls[0][0] === 'add' && calls[0][1] === 'd1')
  t.eq('with the asked quantity', calls[0][2], 2)
  t.eq('an unknown id is refused', runTool('add_to_cart', { product_id: 'nope' }, ctx).result.ok, false)
  t.ok('and the model is told to search first', /search_products/.test(runTool('add_to_cart', { product_id: 'nope' }, ctx).result.error))
}
{
  const { ctx, calls } = mk()
  const r = runTool('add_to_cart', { product_id: 'd2', quantity: 9 }, ctx)
  t.eq('quantity is capped at the stock on hand', calls[0][2], 1)
  t.ok('and the cap is explained to the model', /Only 1 left/.test(r.result.capped || ''))
}
{
  const { ctx, calls } = mk()
  const r = runTool('add_to_cart', { product_id: 't1' }, ctx)
  t.eq('an out-of-stock item is never added', calls.length, 0)
  t.ok('a real alternative is offered instead', r.result.alternatives.some(a => a.id === 't2'))
}

// cart
{
  const cart = [{ id: 'd1', name: '6pcs Kingsize Duvet set', price: 400, qty: 2 }]
  const { ctx, calls } = mk(cart)
  const c = runTool('get_cart', {}, ctx)
  t.eq('the cart total is the real one', c.result.total, '800.00')
  t.eq('in cedis', c.result.currency, 'GHS')
  t.eq('removing calls the app', runTool('remove_from_cart', { product_id: 'd1' }, ctx).result.ok && calls[0][0], 'remove')
  t.eq('removing something not in the cart is refused', runTool('remove_from_cart', { product_id: 'zz' }, ctx).result.ok, false)
}

// checkout
{
  const { ctx, calls } = mk([{ id: 'd1', name: 'x', price: 400, qty: 1 }])
  const r = runTool('go_to_checkout', {}, ctx)
  t.eq('checkout opens the page', calls.find(c => c[0] === 'nav')[1], 'checkout')
  t.ok('and the model is told it must not claim the order is placed', /must not say the order has been placed/i.test(r.result.note))
  const empty = mk()
  t.eq('an empty cart cannot check out', runTool('go_to_checkout', {}, empty.ctx).result.ok, false)
  t.eq('and nothing is navigated', empty.calls.length, 0)
}

// malformed arguments must not throw
t.ok('a missing query is handled', !!runTool('search_products', {}, mk().ctx).result)
t.ok('an unknown tool is refused', runTool('do_something_else', {}, mk().ctx).result.ok === false)
