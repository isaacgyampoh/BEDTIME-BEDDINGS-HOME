/**
 * Saved carts come back from localStorage, written by whatever version of the
 * app was running when they were saved. A browser that has been on the till
 * for months carries carts from versions that no longer exist.
 *
 * One bad item used to take the whole till down: a single `null` in a
 * cashier's saved cart threw inside Navigation and CartDrawer at login, React
 * unmounted everything, and the screen went blank — reproduced by seeding the
 * state. The desktop app, starting with empty storage, never saw it, which is
 * exactly the kind of difference that makes one runtime work and the other not.
 *
 * Anything read back from storage passes through here first. Items that
 * cannot be sold are dropped, not repaired into guesses.
 */

const finite = (v) => Number.isFinite(Number(v))

/** A cart line that can actually be rung up. */
export function isValidLine(c) {
  if (!c || typeof c !== 'object') return false
  if (c.isBundle ? !c.bundleId : !c.productId) return false
  if (!finite(c.qty) || Number(c.qty) < 1) return false
  if (!finite(c.price) || Number(c.price) < 0) return false
  return true
}

export function sanitizeCart(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(isValidLine).map(c => {
    const qty = Math.floor(Number(c.qty))
    const price = Number(c.price)
    return {
      ...c,
      name: typeof c.name === 'string' ? c.name : '',
      qty, price,
      lineTotal: qty * price,
      originalPrice: finite(c.originalPrice) ? Number(c.originalPrice) : price,
    }
  })
}

/** Held carts: keep the ones that still have something sellable in them. */
export function sanitizeHeld(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(h => h && typeof h === 'object')
    .map(h => ({
      ...h,
      id: h.id ?? Date.now() + Math.random(),
      items: sanitizeCart(h.items),
      phone: typeof h.phone === 'string' ? h.phone : '',
      time: typeof h.time === 'string' ? h.time : '',
    }))
    .filter(h => h.items.length > 0)
}

/** Read and sanitise a JSON value from storage without ever throwing. */
export function readStored(key, sanitize, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : sanitize(JSON.parse(raw))
  } catch {
    return fallback
  }
}
