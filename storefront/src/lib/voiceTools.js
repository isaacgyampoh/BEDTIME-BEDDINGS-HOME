/**
 * The only things the voice model is allowed to do.
 *
 * The model never sees the catalogue and never states a price of its own: it
 * calls these, and every answer is built from the products already loaded from
 * Supabase and the cart the website owns. That is what stops it inventing a
 * product, a price or a stock level — the three things a shop cannot afford an
 * assistant to guess at.
 *
 * Each tool returns a plain object that is JSON-stringified back to the model.
 * Side effects (adding to the cart, navigating) are applied through the
 * handlers the app passes in, which are the same functions its own buttons use.
 */
import { matchProducts, parsePhone } from './voiceShop.js'

const missingFields = (c = {}) => ['name', 'phone', 'address'].filter(f => !String(c[f] || '').trim())

const money = (n) => Number(n || 0).toFixed(2)
const priceOf = (p, promoMap = {}) => Number(promoMap[p.id]?.price ?? p.price) || 0
const inStock = (p) => Number(p?.quantity || 0) > 0

/** What the model is told about one product. Deliberately small. */
const brief = (p, promoMap) => ({
  id: p.id,
  name: p.name,
  category: p.category || '',
  price: money(priceOf(p, promoMap)),
  was: promoMap[p.id] ? money(p.price) : undefined,
  on_promotion: !!promoMap[p.id],
  in_stock: inStock(p),
  units_left: Number(p.quantity || 0),
  currency: 'GHS',
})

/** The tool definitions sent in session.update. */
export const toolSchemas = [
  {
    type: 'function', name: 'search_products',
    description: 'Search the shop catalogue. Use for any question about what is available, prices or stock. Never state a product or price that did not come from this.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the shopper asked for, e.g. "duvet set" or "bath towel"' },
        max_price: { type: 'number', description: 'Optional: only items at or below this price in GHS' },
        in_stock_only: { type: 'boolean', description: 'Default true. Out-of-stock items cannot be bought.' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function', name: 'add_to_cart',
    description: 'Add a product to the shopper\'s cart. Use the exact product_id from search_products. Ask which item they mean if it is not clear.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        quantity: { type: 'number', description: 'Default 1' },
      },
      required: ['product_id'],
    },
  },
  {
    type: 'function', name: 'remove_from_cart',
    description: 'Remove a product from the cart by product_id.',
    parameters: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
  },
  {
    type: 'function', name: 'get_cart',
    description: 'What is in the cart now, and the total.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function', name: 'set_delivery_details',
    description: "Save the shopper's name, phone number or delivery place for checkout. Send only the fields they actually gave. A Ghanaian mobile number looks like 0244000000.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string', description: 'Local form, e.g. 0244000000' },
        address: { type: 'string', description: 'Where to deliver, e.g. "Kasoa, near the market"' },
      },
    },
  },
  {
    type: 'function', name: 'get_checkout_state',
    description: 'What has been filled in for checkout and what is still missing.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function', name: 'go_to_checkout',
    description: 'Open the checkout page. This does NOT place an order; the shopper places it themselves on screen.',
    parameters: { type: 'object', properties: {} },
  },
]

/**
 * Run a tool call. `ctx` carries live data and the app's own handlers.
 * Returns { result, results } — result goes back to the model, results are the
 * product cards to show on screen.
 */
export function runTool(name, args = {}, ctx = {}) {
  const { products = [], promoMap = {}, cart = [], onAdd, onRemove, onNavigate } = ctx

  if (name === 'search_products') {
    const wantInStock = args.in_stock_only !== false
    let found = matchProducts(String(args.query || ''), products, { limit: 12 })
    if (wantInStock) found = found.filter(inStock)
    if (Number(args.max_price) > 0) found = found.filter(p => priceOf(p, promoMap) <= Number(args.max_price))
    const shown = found.slice(0, 6)
    return {
      results: shown,
      result: {
        matches: found.length,
        showing: shown.length,
        products: shown.map(p => brief(p, promoMap)),
        note: found.length === 0 ? 'Nothing in the catalogue matches. Suggest a different word; do not invent products.' : undefined,
      },
    }
  }

  if (name === 'add_to_cart') {
    const p = products.find(x => x.id === args.product_id)
    if (!p) return { result: { ok: false, error: 'No such product. Call search_products first and use its product_id.' } }
    if (!inStock(p)) {
      const alt = matchProducts(p.category || p.name, products, { limit: 4 }).filter(x => inStock(x) && x.id !== p.id)
      return { results: alt, result: { ok: false, error: `${p.name} is out of stock.`, alternatives: alt.map(x => brief(x, promoMap)) } }
    }
    const asked = Math.max(1, Math.floor(Number(args.quantity) || 1))
    const qty = Math.min(asked, Number(p.quantity))
    onAdd?.(p, qty)
    return {
      results: [p],
      result: {
        ok: true, added: brief(p, promoMap), quantity: qty,
        capped: qty < asked ? `Only ${qty} left in stock, so ${qty} was added.` : undefined,
      },
    }
  }

  if (name === 'remove_from_cart') {
    const line = cart.find(c => c.id === args.product_id)
    if (!line) return { result: { ok: false, error: 'That is not in the cart.' } }
    onRemove?.(line.id)
    return { result: { ok: true, removed: line.name } }
  }

  if (name === 'get_cart') {
    const total = cart.reduce((a, c) => a + Number(c.price || 0) * Number(c.qty || 0), 0)
    return {
      result: {
        items: cart.map(c => ({ product_id: c.id, name: c.name, quantity: c.qty, price: money(c.price) })),
        item_count: cart.reduce((a, c) => a + Number(c.qty || 0), 0),
        total: money(total), currency: 'GHS',
      },
    }
  }

  if (name === 'set_delivery_details') {
    const { onSetCheckout, checkout = {} } = ctx
    const saved = {}, rejected = {}
    if (args.name && String(args.name).trim().length > 1) saved.name = String(args.name).trim().slice(0, 60)
    if (args.address && String(args.address).trim().length > 2) saved.address = String(args.address).trim().slice(0, 160)
    if (args.phone) {
      const phone = parsePhone(String(args.phone))
      if (phone) saved.phone = phone
      else rejected.phone = 'That is not a Ghanaian mobile number. Ask them to say it again, digit by digit.'
    }
    for (const [field, value] of Object.entries(saved)) onSetCheckout?.(field, value)
    const after = { ...checkout, ...saved }
    return { result: { ok: Object.keys(saved).length > 0, saved, ...rejected, still_missing: missingFields(after) } }
  }

  if (name === 'get_checkout_state') {
    const c = ctx.checkout || {}
    return { result: { name: c.name || null, phone: c.phone || null, address: c.address || null, still_missing: missingFields(c) } }
  }

  if (name === 'go_to_checkout') {
    if (!cart.length) return { result: { ok: false, error: 'The cart is empty, so there is nothing to check out.' } }
    onNavigate?.('checkout')
    return { result: { ok: true, note: 'Checkout is open. The shopper reviews it and presses the button themselves; you must not say the order has been placed.' } }
  }

  return { result: { ok: false, error: `Unknown tool ${name}` } }
}

/** What the assistant is, in its own words. Kept short — it is billed per token. */
export const INSTRUCTIONS = [
  'You are the shop assistant for BEDTIME BEDDINGS & HOME, a bedding and homeware shop in Accra, Ghana. Prices are Ghana cedis (GHS).',
  'Speak briefly and plainly, like a helpful shop assistant — one or two short sentences, then ask what they would like.',
  'You know nothing about the stock except what the tools return. Never invent a product, a price or a stock level. If search_products finds nothing, say so and suggest a different word.',
  'When several products could be meant, ask which one before adding anything.',
  'Never say an order has been placed. You can open checkout; the shopper completes it on screen themselves.',
  'Do not read out card numbers, and never ask for card details, PINs or passwords.',
].join(' ')
