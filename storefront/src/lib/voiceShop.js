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

// Words that are how people talk, not what they are shopping for. The list is
// a help, not the safety net — matchProducts no longer demands that every word
// hits, so an unlisted filler word can no longer empty the results.
const STOP = new Set(['a','an','the','i','me','my','we','us','you','your','is','are','was','be','do','does','did','to','for','of','in','on','at','and','or','please','can','could','would','will','want','need','like','have','has','had','show','see','find','get','give','buy','bring','looking','look','let','all','available','there','here','any','some','got','that','this','these','those','it','them','they','with','pls','abeg','kindly','now','today','just','also','well','ok','okay','hi','hello','hey','what','which','how','about','your','whats','much','many','other','another','one','ones','please','still','maybe','new'])

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, couple: 2, pair: 2, dozen: 12 }
const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1 }

export const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)
const tokens = (s) => clean(s).split(' ').filter(Boolean).map(singular)
const content = (s) => tokens(s).filter(w => !STOP.has(w) && w.length > 1)

const DIGIT_WORD = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', double: 'x2', triple: 'x3' }

/**
 * A phone number as a person says it out loud.
 *
 * Speech recognition hands back "zero two four four double zero" far more often
 * than "0244400000", so a digits-only reading would reject most spoken numbers.
 * Returns the local 0XXXXXXXXX form, or null if what was said is not a Ghanaian
 * mobile number — guessing at a delivery phone number is worse than asking again.
 */
export function parsePhone(text) {
  const words = clean(text).split(' ')
  let out = ''
  let repeat = 0
  for (const w of words) {
    if (/^\d+$/.test(w)) { out += repeat ? w.repeat(repeat) : w; repeat = 0; continue }
    const d = DIGIT_WORD[w]
    if (!d) { repeat = 0; continue }
    if (d.startsWith('x')) { repeat = Number(d.slice(1)); continue }
    out += repeat ? d.repeat(repeat) : d
    repeat = 0
  }
  let n = out.replace(/\D/g, '')
  if (n.startsWith('233')) n = '0' + n.slice(3)
  if (n.length === 9 && /^[25]/.test(n)) n = '0' + n
  // Ghanaian mobile numbers are 02X and 05X. 03X is a landline, which cannot
  // take a mobile-money prompt or the delivery SMS, so it is not a number we
  // can accept for an order.
  return /^0[25]\d{8}$/.test(n) ? n : null
}

/** "under 300", "less than 500", "cheaper than 250". */
export function parseMaxPrice(text) {
  const m = clean(text).match(/\b(under|below|less than|cheaper than|up to|maximum|max)\b[^\d]{0,12}(\d+)/)
  return m ? Number(m[2]) : null
}

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

  // Counts how many of the shopper's words a piece of text covers. Two words
  // said apart may be one word in the catalogue — "bed sheets" is written
  // "Bedsheet" — so a joined pair counts as covering both. Without this, a
  // bedsheet scored the same as an inflatable air bed, which also contains
  // "bed", and the air bed came first.
  const countHits = (text) => {
    const hay = tokens(text || '')
    const set = new Set(hay)
    // Prefixes only count when the shorter side is a real word. Without the
    // length floor "mat" matched "mattress", and a Bath Mat Set outranked the
    // mattress toppers someone actually asked for.
    const matches = (w) => set.has(w) || hay.some(h =>
      (h.startsWith(w) && w.length >= 4) || (w.startsWith(h) && h.length >= 4))
    let n = 0
    for (let i = 0; i < want.length; i++) {
      const joined = i + 1 < want.length ? singular(want[i] + want[i + 1]) : null
      if (joined && matches(joined)) { n += 2; i++; continue }
      if (matches(want[i])) n += 1
    }
    return n
  }

  const scored = []
  for (const p of products || []) {
    const nameHits = countHits(p.name)
    const catHits = countHits(p.category)
    const descHits = countHits(p.description)
    const hits = Math.max(nameHits, catHits, descHits)
    if (!hits) continue
    scored.push({
      p, nameHits, total: nameHits + catHits + descHits,
      whole: `${p.name} ${p.category}`.toLowerCase().includes(phrase) ? 1 : 0,
      len: String(p.name || '').length,
    })
  }
  if (!scored.length) return []

  // Two rules, in order.
  //
  // 1. What is in the NAME beats what is only in the category. Asked for bed
  //    sheets, a shopper means products called bedsheets, not everything filed
  //    under "Bed Sheets" — which is how an air bed led those results.
  // 2. All of what they said beats some of it. "Let me see all the mattress
  //    toppers available" used to find nothing at all, because every word had
  //    to hit and no product contains "let" or "available", so a category the
  //    shop genuinely stocks was reported as not carried. Partial matches are
  //    now a fallback instead of an empty answer.
  const bestName = Math.max(...scored.map(x => x.nameHits))
  const tier = bestName > 0 ? scored.filter(x => x.nameHits === bestName) : scored
  const bestTotal = Math.max(...tier.map(x => x.total))

  return tier
    .filter(x => x.total === bestTotal)
    .sort((a, b) => (b.whole - a.whole) || (a.len - b.len))
    .slice(0, limit)
    .map(x => x.p)
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

/** What checkout still needs, said the way a shop assistant would say it. */
function missingLine(c = {}) {
  const missing = []
  if (!String(c.name || '').trim()) missing.push('your name')
  if (!String(c.phone || '').trim()) missing.push('your phone number')
  if (!String(c.address || '').trim()) missing.push('where to deliver')
  if (!missing.length) return 'I have everything. Say "checkout" when you are ready.'
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0]
  return `I still need ${list}.`
}

/**
 * The one entry point: what was said plus what is on screen, in — a reply to
 * speak, products to show, and at most one action for the caller to apply.
 *
 * ctx: { products, promoMap, cart, lastResults, checkout }
 * action: { kind: 'add'|'remove'|'setQty'|'navigate'|'clearCart', ... }
 */
export function respond(utterance, ctx = {}) {
  const { products = [], promoMap = {}, cart = [], lastResults = [], checkout = {} } = ctx
  const t = clean(utterance)
  const raw = String(utterance || '').trim()
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

  // Giving details for delivery — checked before anything else, so "my name
  // is Ama" is never mistaken for a product search.
  const nameSaid = raw.match(/\b(?:my name is|i am|i'm|this is)\b\s+(.{2,40})$/i)
  if (nameSaid) {
    const name = nameSaid[1].replace(/[.,!?]+$/, '').toLowerCase().replace(/\b(please|thanks|thank you)\b/g, '').trim()
      .split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    return { ...none, say: `Thank you ${name}. ${missingLine({ ...checkout, name })}`, action: { kind: 'setCheckout', field: 'name', value: name } }
  }
  if (/\b(number|phone|mobile|contact|momo)\b/.test(t) && /\d|zero|one|two|three|four|five|six|seven|eight|nine/.test(t)) {
    const phone = parsePhone(t)
    if (!phone) return { ...none, say: 'I did not get that number. Please say it again, digit by digit.' }
    return { ...none, say: `Got it, ${phone}. ${missingLine({ ...checkout, phone })}`, action: { kind: 'setCheckout', field: 'phone', value: phone } }
  }
  // Matched on the words as spoken, not the normalised copy: an address goes
  // on the delivery label, and "kasoa near the market" reads like a mistake.
  const placeSaid = raw.match(/\b(?:deliver(?:y)? to|send (?:it )?to|i live (?:at|in)|my address is|address is|location is)\b\s+(.{2,80})$/i)
  if (placeSaid) {
    const where = placeSaid[1].replace(/[.,!?]+$/, '').trim()
    return { ...none, say: `Delivery to ${where}. ${missingLine({ ...checkout, address: where })}`, action: { kind: 'setCheckout', field: 'address', value: where } }
  }
  if (/\bwhat (do you need|else do you need|is missing)\b/.test(t) || /\bmy details\b/.test(t)) {
    return { ...none, say: missingLine(checkout) }
  }

  if (/\b(checkout|check out|pay|place (the |my )?order|buy now)\b/.test(t)) {
    if (!cart.length) return { ...none, say: 'Your cart is empty, so there is nothing to check out yet.' }
    return { ...none, say: `Taking you to checkout. ${cartCount} item${cartCount === 1 ? '' : 's'}, ${money(cartTotal)}. Check the details on screen, then press the button to place your order.`, action: { kind: 'navigate', page: 'checkout' } }
  }

  if (/\b(offer|promo|promotion|deal|discount|sale|black friday)\b/.test(t)) {
    const onOffer = products.filter(p => promoMap[p.id] && inStock(p))
      .sort((a, b) => (Number(b.price) - priceOf(b, promoMap)) - (Number(a.price) - priceOf(a, promoMap)))
    if (!onOffer.length) return { ...none, say: 'There is no promotion running at the moment.' }
    const top = onOffer[0]
    return {
      ...none, results: onOffer.slice(0, 8), lastResults: onOffer.slice(0, 8),
      say: `${onOffer.length} item${onOffer.length === 1 ? ' is' : 's are'} on offer. ${top.name} is down to ${money(priceOf(top, promoMap))} from ${money(top.price)}.`,
    }
  }

  if (/\b(what do you sell|what have you got|categories|what kind)\b/.test(t)) {
    const cats = [...new Set(products.filter(inStock).map(p => (p.category || '').trim()).filter(Boolean))]
    if (!cats.length) return { ...none, say: 'The shop list is still loading. Try again in a moment.' }
    return { ...none, say: `We have ${cats.slice(0, 6).join(', ')}${cats.length > 6 ? ' and more' : ''}. Which would you like to see?` }
  }

  const changeQty = t.match(/\b(?:make it|change (?:it )?to|let it be)\b\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/)
  if (changeQty && cart.length) {
    const qty = parseQty(changeQty[1])
    const line = lastResults.length === 1 ? cart.find(c => c.id === lastResults[0].id) : (cart.length === 1 ? cart[0] : null)
    if (!line) return { ...none, say: `Which item should be ${qty}? You have ${listNames(cart)}.` }
    const stock = Number(products.find(p => p.id === line.id)?.quantity ?? qty)
    const capped = Math.min(qty, stock || qty)
    return { ...none, say: `${line.name} set to ${capped}.${capped < qty ? ` Only ${capped} in stock.` : ''}`, action: { kind: 'setQty', id: line.id, qty: capped } }
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
  const maxPrice = parseMaxPrice(t)
  const found = matchProducts(t.replace(/\b(under|below|less than|cheaper than|up to|maximum|max)\b[^\d]{0,12}\d+/, ' '), products, { limit: 24 })
  let available = found.filter(inStock)
  if (maxPrice) {
    const within = available.filter(p => priceOf(p, promoMap) <= maxPrice)
    if (!within.length) {
      const cheapest = [...available].sort((a, b) => priceOf(a, promoMap) - priceOf(b, promoMap))[0]
      return cheapest
        ? { ...none, results: [cheapest], lastResults: [cheapest], say: `Nothing under ${money(maxPrice)}. The cheapest is ${cheapest.name} at ${money(priceOf(cheapest, promoMap))}.` }
        : { ...none, say: `I could not find that under ${money(maxPrice)}.` }
    }
    available = within
  }
  available = available.slice(0, 8)
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
