/**
 * Understanding what a shopper said, over the real catalogue.
 *
 * Deliberately deterministic: every answer here comes from the products and
 * prices already loaded from Supabase, never from a language model and never
 * invented. That keeps the assistant honest about stock and price, works with
 * no API key and no per-conversation cost, and runs when the shop's internet is
 * poor. The shape — utterance in, a structured action out — is the same shape a
 * model's tool call would take, so swapping in the server agent later changes
 * who produces the action, not what the app does with it.
 *
 * Nothing here touches the DOM, the network or the cart; the caller applies the
 * action. That is what makes it testable.
 */

const STOP = new Set(['a','an','the','i','me','my','we','you','your','is','are','was','do','does','did','to','for','of','in','on','at','and','or','please','can','could','would','want','need','like','have','has','show','find','get','give','buy','looking','look','any','some','got','there','that','this','it','them','they','with','pls','abeg'])

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, couple: 2, pair: 2, dozen: 12 }
const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1 }

export const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
const tokens = (s) => clean(s).split(' ').filter(Boolean).map(singular)
const content = (s) => tokens(s).filter(w => !STOP.has(w) && w.length > 1)

/** A quantity said in words or digits: "add two", "add 3". */
export function parseQty(text) {
  const t = clean(text)
  const digit = t.match(/\b(\d{1,2})\b/)
  if (digit) { const n = Number(digit[1]); if (n >= 1 && n <= 99) return n }
  for (const [w, n] of Object.entries(WORD_NUM)) if (new RegExp(`\\b${w}\\b`).test(t) && w !== 'a' && w !== 'an') return n
  return 1
}

/**
 * Products matching what was said, best first.
 *
 * Every content word must appear somewhere in the product's name or category,
 * so "ceramic bowl" cannot match a duvet. Ranking prefers a whole-phrase hit,
 * then more matched words, then the shorter name — "dinner set" should lead
 * with the plain one, not the longest title that happens to contain it.
 */
export function matchProducts(utterance, products, { limit = 8 } = {}) {
  const want = content(utterance)
  if (!want.length) return []
  const phrase = want.join(' ')
  const scored = []
  for (const p of products || []) {
    const hay = tokens(`${p.name || ''} ${p.category || ''}`)
    const haySet = new Set(hay)
    const hit = want.filter(w => haySet.has(w) || hay.some(h => h.startsWith(w) || w.startsWith(h)))
    if (hit.length !== want.length) continue
    const whole = tokens(`${p.name} ${p.category}`).join(' ').includes(phrase) ? 1 : 0
    scored.push({ p, whole, hits: hit.length, len: String(p.name || '').length })
  }
  scored.sort((a, b) => (b.whole - a.whole) || (b.hits - a.hits) || (a.len - b.len))
  return scored.slice(0, limit).map(x => x.p)
}

/** Which item of the last results was meant: "the second one", "the last one". */
export function parseReference(utterance, results) {
  const t = clean(utterance)
  if (!results?.length) return null
  for (const [word, n] of Object.entries(ORDINAL)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return n === -1 ? results[results.length - 1] : (results[n - 1] || null)
  }
  const num = t.match(/\bnumber\s+(\d{1,2})\b/)
  if (num) return results[Number(num[1]) - 1] || null
  // "the yellow one" — a word from the utterance that tells two results apart.
  const words = content(t).filter(w => !['one','item','product','thing'].includes(w))
  if (words.length) {
    const narrowed = results.filter(p => { const hay = tokens(`${p.name} ${p.category}`); return words.every(w => hay.some(h => h.startsWith(w))) })
    if (narrowed.length === 1) return narrowed[0]
  }
  if (/\b(it|that|this|the one)\b/.test(t) && results.length === 1) return results[0]
  return null
}

const priceOf = (p, promoMap = {}) => Number(promoMap[p.id]?.price ?? p.price) || 0
const inStock = (p) => Number(p?.quantity || 0) > 0
const money = (n) => `GHS ${Number(n || 0).toFixed(2)}`
const listNames = (ps) => ps.map(p => p.name).join(', ')

/**
 * The one entry point: what was said plus what is on screen, in — a reply to
 * speak, products to show, and at most one action for the caller to apply.
 *
 * ctx: { products, promoMap, cart, lastResults }
 * action: { kind: 'add'|'remove'|'setQty'|'navigate'|'clearCart', ... }
 */
export function respond(utterance, ctx = {}) {
  const { products = [], promoMap = {}, cart = [], lastResults = [] } = ctx
  const t = clean(utterance)
  const none = { say: '', results: null, action: null, lastResults }
  if (!t) return { ...none, say: 'I did not catch that. Please say it again.' }

  const cartTotal = cart.reduce((a, c) => a + Number(c.price || 0) * Number(c.qty || 0), 0)
  const cartCount = cart.reduce((a, c) => a + Number(c.qty || 0), 0)

  if (/\b(help|what can you do|how does this work)\b/.test(t)) {
    return { ...none, say: 'Say what you are looking for, for example "show me duvets". Then say "add it to my cart", or ask "how much is my cart". Say "checkout" when you are ready.' }
  }

  if (/\b(cart|basket)\b/.test(t) && !/\b(add|remove|take|delete|clear|empty)\b/.test(t)) {
    if (!cart.length) return { ...none, say: 'Your cart is empty.' }
    return { ...none, say: `You have ${cartCount} item${cartCount === 1 ? '' : 's'}: ${cart.map(c => `${c.qty} ${c.name}`).join(', ')}. Total ${money(cartTotal)}.` }
  }

  if (/\b(how much|total|cost)\b/.test(t) && !content(t).some(w => !['how','much','total','cost','my','cart'].includes(w))) {
    return { ...none, say: cart.length ? `Your cart comes to ${money(cartTotal)}.` : 'Your cart is empty.' }
  }

  if (/\b(clear|empty)\b.*\b(cart|basket)\b/.test(t)) {
    return { ...none, say: cart.length ? 'Cart cleared.' : 'Your cart is already empty.', action: cart.length ? { kind: 'clearCart' } : null }
  }

  if (/\b(checkout|check out|pay|place (the |my )?order|buy now)\b/.test(t)) {
    if (!cart.length) return { ...none, say: 'Your cart is empty, so there is nothing to check out yet.' }
    return { ...none, say: `Taking you to checkout. ${cartCount} item${cartCount === 1 ? '' : 's'}, ${money(cartTotal)}. Check the details on screen, then press the button to place your order.`, action: { kind: 'navigate', page: 'checkout' } }
  }

  // "how many duvets do you have" — listings and stock are different numbers.
  if (/\bhow many\b/.test(t)) {
    const found = matchProducts(t.replace(/how many|do you have|are there|in stock/g, ' '), products, { limit: 50 })
    if (!found.length) return { ...none, say: 'I could not find that in the shop.' }
    const available = found.filter(inStock)
    const units = available.reduce((a, p) => a + Number(p.quantity || 0), 0)
    return {
      ...none,
      results: available.slice(0, 8),
      lastResults: available.slice(0, 8),
      say: `${found.length} ${found.length === 1 ? 'item matches' : 'items match'} that, ${available.length} in stock right now, ${units} unit${units === 1 ? '' : 's'} altogether.`,
    }
  }

  if (/\b(cheapest|lowest|least expensive|most affordable)\b/.test(t) || /\b(dearest|most expensive|highest)\b/.test(t)) {
    const pool = (lastResults.length ? lastResults : matchProducts(t, products, { limit: 50 })).filter(inStock)
    if (!pool.length) return { ...none, say: 'Search for something first, then I can compare the prices.' }
    const cheapest = /\b(cheapest|lowest|least|affordable)\b/.test(t)
    const sorted = [...pool].sort((a, b) => priceOf(a, promoMap) - priceOf(b, promoMap))
    const pick = cheapest ? sorted[0] : sorted[sorted.length - 1]
    return { ...none, results: [pick], lastResults: [pick], say: `The ${cheapest ? 'cheapest' : 'most expensive'} is ${pick.name} at ${money(priceOf(pick, promoMap))}.` }
  }

  if (/\b(remove|delete|take out|take off)\b/.test(t)) {
    if (!cart.length) return { ...none, say: 'Your cart is empty.' }
    const target = matchProducts(t.replace(/remove|delete|take out|take off|from my cart/g, ' '), cart, { limit: 1 })[0]
      || (cart.length === 1 ? cart[0] : null)
    if (!target) return { ...none, say: `Which one should I remove? You have ${listNames(cart)}.` }
    return { ...none, say: `Removed ${target.name}.`, action: { kind: 'remove', id: target.id } }
  }

  if (/\badd\b|\bput\b.*\bcart\b|\bi(ll| will)? take\b/.test(t)) {
    const qty = parseQty(t)
    const spoken = t.replace(/\b(add|put|into?|my|cart|basket|please|i(ll| will)? take)\b/g, ' ')
    let target = parseReference(spoken, lastResults)
    if (!target) target = matchProducts(spoken, products, { limit: 2 })[0] || null
    if (!target && lastResults.length === 1) target = lastResults[0]
    if (!target) {
      if (lastResults.length > 1) return { ...none, say: `Which one? ${listNames(lastResults.slice(0, 4))}.`, results: lastResults }
      return { ...none, say: 'Tell me what to add, for example "add the duvet set".' }
    }
    if (!inStock(target)) {
      const alt = matchProducts(target.category || target.name, products, { limit: 4 }).filter(p => inStock(p) && p.id !== target.id)
      return { ...none, results: alt, lastResults: alt, say: alt.length ? `${target.name} is out of stock. Similar in stock: ${listNames(alt.slice(0, 3))}.` : `${target.name} is out of stock at the moment.` }
    }
    const capped = Math.min(qty, Number(target.quantity || 0))
    const short = capped < qty
    return {
      ...none,
      results: [target],
      lastResults: [target],
      say: `Added ${capped} ${target.name} at ${money(priceOf(target, promoMap))}${short ? `. Only ${capped} left in stock` : ''}.`,
      action: { kind: 'add', product: target, qty: capped },
    }
  }

  // Anything else is treated as a search over the real catalogue.
  const found = matchProducts(t, products, { limit: 8 })
  const available = found.filter(inStock)
  if (!available.length) {
    return { ...none, say: found.length ? 'I found that, but it is out of stock right now.' : 'I could not find that in the shop. Try another word, like "duvet" or "towel".' }
  }
  const head = available[0]
  return {
    ...none,
    results: available,
    lastResults: available,
    say: available.length === 1
      ? `${head.name}, ${money(priceOf(head, promoMap))}. Say "add it" to put it in your cart.`
      : `I found ${available.length}. ${listNames(available.slice(0, 3))}. Say "add" with the name, or ask for the cheapest.`,
  }
}
