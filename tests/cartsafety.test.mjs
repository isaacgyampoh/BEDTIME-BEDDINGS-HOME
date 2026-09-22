import { suite } from './harness.mjs'
import { sanitizeCart, sanitizeHeld, isValidLine } from '../src/lib/cartSafety.js'
const t = suite('Saved carts: old data cannot take the till down')

// A single null in a saved cart used to throw in Navigation and CartDrawer at
// login and blank the whole POS (reproduced in tests/e2e). Chrome on the till
// carries carts written by older versions; the desktop app starts empty.
const good = { productId: 'p1', name: 'Duvet', qty: 2, price: 450 }

t.eq('a good line survives', sanitizeCart([good]).length, 1)
t.eq('its line total is recomputed', sanitizeCart([{ ...good, lineTotal: 1 }])[0].lineTotal, 900)
t.eq('null is dropped', sanitizeCart([null, good]).length, 1)
t.eq('a non-array is an empty cart', sanitizeCart('oops').length, 0)
t.eq('undefined is an empty cart', sanitizeCart(undefined).length, 0)
t.eq('a line with no product is dropped', sanitizeCart([{ qty: 1, price: 5 }]).length, 0)
t.eq('zero qty is dropped', sanitizeCart([{ ...good, qty: 0 }]).length, 0)
t.eq('negative price is dropped', sanitizeCart([{ ...good, price: -5 }]).length, 0)
t.eq('NaN qty is dropped', sanitizeCart([{ ...good, qty: 'abc' }]).length, 0)
t.eq('fractional qty is floored, not guessed up', sanitizeCart([{ ...good, qty: 2.7 }])[0].qty, 2)
t.eq('string numbers are read as numbers', sanitizeCart([{ ...good, qty: '3', price: '10' }])[0].lineTotal, 30)
t.eq('a missing name becomes empty, not undefined', sanitizeCart([{ productId: 'p', qty: 1, price: 1 }])[0].name, '')
t.ok('a bundle line needs a bundleId', !isValidLine({ isBundle: true, qty: 1, price: 5 }))
t.ok('a bundle line with one is fine', isValidLine({ isBundle: true, bundleId: 'b', qty: 1, price: 5 }))

t.eq('held carts: one with no items is dropped', sanitizeHeld([{ id: 1 }]).length, 0)
t.eq('held carts: bad items are removed, good kept', sanitizeHeld([{ id: 2, items: [null, good] }])[0].items.length, 1)
t.eq('held carts: a non-array is empty', sanitizeHeld({}).length, 0)
t.ok('held carts: phone and time default to strings', typeof sanitizeHeld([{ items: [good] }])[0].phone === 'string')
