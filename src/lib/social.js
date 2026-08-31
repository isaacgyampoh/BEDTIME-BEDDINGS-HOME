import { getSupabase, callFunction } from './supabase'
import { money, num, SHOP } from './utils'

/**
 * Promotional content generation for TikTok and WhatsApp.
 *
 * Everything here is derived from the live product record — `products` stays
 * the single source of truth. Nothing is duplicated, invented or estimated.
 *
 * Two rules from the brief are enforced structurally rather than by habit:
 *
 *   Stock (§25) — content is always built from the CURRENT quantity, and a
 *   product with none cannot produce "available now" copy at all.
 *
 *   Selling unit (§26) — this system has retail and wholesale prices, not
 *   box/piece. Whichever unit is chosen, its OWN configured price is quoted.
 *   A price is never derived from the other tier.
 */

/** Public storefront product page — the same catalogue the POS writes to. */
export const STOREFRONT = 'https://www.bedtimehome.com'
export const productUrl = (id) => `${STOREFRONT}/#/product/${id}`

export const UNITS = { retail: 'Retail', wholesale: 'Wholesale' }

/**
 * The price for a selling unit, taken straight from the product record.
 * Returns null when that unit is not configured, so the caller must fall back
 * explicitly rather than silently quoting the wrong tier.
 */
export function unitPrice(product, unit) {
  if (!product) return null
  if (unit === 'wholesale') {
    const p = num(product.wholesalePrice)
    return p > 0 ? p : null      // never derived from the retail price
  }
  const p = num(product.price)
  return p > 0 ? p : null
}

/** How the unit reads on a receipt-facing message, e.g. "each (5+)". */
export function unitLabel(product, unit) {
  if (unit !== 'wholesale') return 'each'
  const min = num(product?.wholesaleMinQty)
  return min > 1 ? `each (${min}+)` : 'each (wholesale)'
}

export function availableUnits(product) {
  const out = [{ id: 'retail', label: 'Retail', price: unitPrice(product, 'retail') }]
  const w = unitPrice(product, 'wholesale')
  if (w != null) out.push({ id: 'wholesale', label: 'Wholesale', price: w })
  return out.filter(u => u.price != null)
}

export const stockState = (q) =>
  num(q) <= 0 ? 'out' : num(q) <= 5 ? 'low' : 'in'

/** A product with no stock must never be advertised as available. */
export function canPromote(product) {
  if (!product) return { ok: false, reason: 'No product' }
  if (num(product.quantity) <= 0) {
    return { ok: false, reason: 'Out of stock — cannot promote as available' }
  }
  if (unitPrice(product, 'retail') == null && unitPrice(product, 'wholesale') == null) {
    return { ok: false, reason: 'No price set on this product' }
  }
  return { ok: true }
}

// ── hashtags ────────────────────────────────────────────────────────────────
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')

export function suggestHashtags(product) {
  const tags = ['bedtimebeddings', 'accraghana', 'ghanashopping']
  if (product?.category) tags.push(slug(product.category))
  const words = String(product?.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3)
  for (const w of words.slice(0, 2)) tags.push(slug(w))
  return [...new Set(tags.filter(Boolean))].slice(0, 8).map(t => '#' + t)
}

// ── TikTok caption ──────────────────────────────────────────────────────────
/**
 * Hook / product / call-to-action, per §5. Deterministic and local: no AI key
 * is needed for the feature to work, and the result is always editable.
 * `event` shapes the hook; `previous` carries a REAL prior price from
 * product_price_history and is only ever passed by the price-change path.
 */
export function tiktokCaption(product, { unit = 'retail', event = 'manual', previous = null } = {}) {
  const price = unitPrice(product, unit)
  const qty = num(product.quantity)
  const label = unitLabel(product, unit)

  let hook
  switch (event) {
    case 'new_product':
      hook = `🔥 New in — ${product.name} just landed!`; break
    case 'price_change':
      hook = previous != null && previous > price
        ? `🔥 Price drop! ${product.name} is now ${money(price)} (was ${money(previous)})`
        : `✨ New price on ${product.name}`
      break
    case 'restock':
      hook = `🎉 Back in stock — ${product.name} is available again!`; break
    case 'low_stock':
      hook = `⏳ Only ${qty} left — ${product.name}`; break
    default:
      hook = `🔥 ${product.name} — available now at BEDTIME BEDDINGS & HOME`
  }

  const lines = [hook, '']
  lines.push(`${product.name} — ${money(price)} ${label}`)
  if (product.description) lines.push(product.description.trim())
  if (qty <= 5) lines.push(`Only ${qty} left in stock.`)
  lines.push('')
  lines.push(`📍 ${SHOP.address}`)
  lines.push(`📞 ${SHOP.phone}`)
  lines.push(`🛒 Order: ${productUrl(product.id)}`)
  return lines.join('\n')
}

// ── WhatsApp message ────────────────────────────────────────────────────────
export function whatsappMessage(product, { unit = 'retail', event = 'manual', previous = null } = {}) {
  const price = unitPrice(product, unit)
  const qty = num(product.quantity)
  const label = unitLabel(product, unit)

  const lines = [`🛍️ *${product.name}*`, '']
  if (event === 'price_change' && previous != null && previous > price) {
    lines.push(`💰 Price: *${money(price)}* ${label}  ~${money(previous)}~`)
  } else {
    lines.push(`💰 Price: *${money(price)}* ${label}`)
  }
  lines.push(`📦 Available: ${qty}`)
  if (product.category) lines.push(`🏷️ ${product.category}`)
  if (product.description) { lines.push(''); lines.push(product.description.trim()) }

  lines.push('')
  if (event === 'restock') lines.push('🎉 Back in stock!')
  else if (event === 'new_product') lines.push('🔥 New arrival — available now.')
  else if (qty <= 5) lines.push(`⏳ Only ${qty} left.`)

  lines.push('')
  lines.push(`Order here:`)
  lines.push(productUrl(product.id))
  lines.push('')
  lines.push(`${SHOP.name}`)
  lines.push(`${SHOP.address} · ${SHOP.phone}`)
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}

/** Open WhatsApp with the message ready. Optional recipient. */
export function shareToWhatsApp(message, phone = '') {
  const text = encodeURIComponent(message)
  let wp = String(phone || '').replace(/\D/g, '')
  if (wp && wp.startsWith('0')) wp = '233' + wp.slice(1)
  const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent)
  const base = isMobile ? 'whatsapp://send' : 'https://web.whatsapp.com/send'
  const url = wp ? `${base}?phone=${wp}&text=${text}` : `${base}?text=${text}`
  if (isMobile) window.location.href = url
  else window.open(url, '_blank', 'noopener,noreferrer')
}

// ── persistence ─────────────────────────────────────────────────────────────
/** The most recent real price change, or null. Never fabricated. */
export async function lastPriceChange(productId) {
  const sb = getSupabase()
  const { data } = await sb.from('product_price_history')
    .select('old_price,new_price,changed_at')
    .eq('product_id', productId).order('changed_at', { ascending: false }).limit(1)
  return data?.[0] || null
}

export async function savePost(post) {
  const sb = getSupabase()
  const { data, error } = await sb.from('social_posts').insert(post).select().single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, post: data }
}

export async function updatePost(id, patch) {
  const sb = getSupabase()
  const { error } = await sb.from('social_posts').update(patch).eq('id', id)
  return { ok: !error, error: error?.message }
}

export async function logSocial(entry) {
  try { await getSupabase().from('social_audit_log').insert(entry) } catch {}
}

export async function fetchConnections() {
  const sb = getSupabase()
  const { data } = await sb.from('social_connections_safe').select('*')
  return data || []
}

export async function fetchPosts({ platform, status, productId, limit = 100 } = {}) {
  const sb = getSupabase()
  let q = sb.from('social_posts').select('*').order('created_at', { ascending: false }).limit(limit)
  if (platform) q = q.eq('platform', platform)
  if (status) q = q.eq('status', status)
  if (productId) q = q.eq('product_id', productId)
  const { data } = await q
  return data || []
}

/** Hand a post to the server-side publisher. Tokens never touch the browser. */
export async function publishToTikTok(postId, adminPin) {
  return callFunction('tiktok-publish', { postId, adminPin })
}
