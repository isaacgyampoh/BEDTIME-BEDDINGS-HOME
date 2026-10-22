/**
 * Buying something on a phone, through the real UI.
 *
 * Most of this shop's customers arrive on a phone, so the run is at 390x844
 * with an iPhone user agent. Supabase is answered from fixtures.
 *
 * It exists because of what a walkthrough of the live site found: the floating
 * "Shop by voice" pill covered 56% of Add to Cart on every product page, and a
 * tap in the middle of the button opened the voice panel instead of adding the
 * item. Nothing caught it, because nothing had ever tapped that button at
 * phone width.
 *
 * Run with: npm run test:buying
 */
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { intercept, helpers, sleep } = require('./flow.cjs')
const DEV = process.env.SHOP_DEV_URL || 'http://localhost:5174'

let pass = 0, fail = 0
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + l) } else { fail++; console.log('  \x1b[31m✗ ' + l + '\x1b[0m ' + (e || '')) } }
const finish = (code) => { console.log(`\n${pass} passed, ${fail} failed`); app.exit(code ?? (fail ? 1 : 0)) }
setTimeout(() => { ok('finished within 180s', false); finish(2) }, 180000)
process.on('unhandledRejection', (e) => { ok('no unhandled rejection', false, e && e.stack); finish(3) })
app.on('window-all-closed', () => {})

const PRODUCTS = [
  { id: 'a', name: 'Satin Duvet Set', category: 'Duvets', price: 450, quantity: 12, image: null, created_at: '2026-10-05' },
  { id: 'b', name: 'Cotton Bedsheet', category: 'Sheets', price: 320, quantity: 9, image: null, created_at: '2026-10-04' },
]

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 390, height: 844 })
  w.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
  await w.loadURL(DEV)
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)
  net.script = ({ method, path: p }) => {
    if (method !== 'GET') return undefined
    if (p.endsWith('/rest/v1/products')) return PRODUCTS
    if (p.endsWith('/rest/v1/promos')) return []
    if (p.endsWith('/rest/v1/store_settings')) return [{ shop_open: true, closed_message: '' }]
    if (p.startsWith('/rest/v1/')) return []
    return undefined
  }
  await w.loadURL(DEV)
  const h = helpers(w, dbg)
  const js = h.js

  ok('the shop loads on a phone', await h.waitFor(`document.body.innerText.includes('Satin Duvet Set')`, 20000))
  await js(`localStorage.removeItem('etr_buyer'); localStorage.removeItem('etr_cart')`)
  await w.loadURL(DEV)
  await h.waitFor(`document.body.innerText.includes('Satin Duvet Set')`, 20000)

  // ── open a product ───────────────────────────────────────────────────────
  await js(`(() => { const e = document.querySelector('.card-lift'); e.scrollIntoView({ block: 'center' }); e.click() })()`)
  await sleep(1200)
  ok('a product opens', await js(`document.body.innerText.includes('Add to Cart') || document.body.innerText.includes('Buy now')`))

  // ── the buy action is reachable, which is the whole point ────────────────
  const reach = async (label) => js(`(() => {
    const b = [...document.querySelectorAll('button')].filter(x => x.getClientRects().length && new RegExp(${JSON.stringify(label)}, 'i').test(x.innerText)).pop()
    if (!b) return { found: false }
    const r = b.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { found: true, onScreen: r.top >= 0 && r.bottom <= innerHeight, covered: !b.contains(hit), by: hit ? (hit.innerText || hit.tagName).slice(0, 24) : null }
  })()`)

  const buy = await reach('Buy now')
  ok('a Buy now button exists', buy.found)
  ok('it is on screen without scrolling', buy.onScreen, JSON.stringify(buy))
  ok('and nothing is sitting on top of it', !buy.covered, `covered by ${buy.by}`)

  const add = await reach('^Add$|Add to Cart')
  ok('Add is reachable too', add.found && !add.covered, `covered by ${add.by}`)

  // The specific regression: the voice pill must clear the buy bar.
  const gap = await js(`(() => {
    const pill = [...document.querySelectorAll('button')].find(b => /Shop by voice|Ask the shop/i.test(b.innerText))
    const bar = [...document.querySelectorAll('button')].filter(b => /Buy now/i.test(b.innerText)).pop()
    if (!pill || !bar) return null
    const p = pill.getBoundingClientRect(), r = bar.getBoundingClientRect()
    const overlap = Math.max(0, Math.min(p.right, r.right) - Math.max(p.left, r.left)) *
                    (Math.min(p.bottom, r.bottom) > Math.max(p.top, r.top) ? 1 : 0)
    return Math.round(overlap)
  })()`)
  ok('the voice pill does not overlap the buy bar', gap === 0, `overlap ${gap}px`)

  // ── Buy now goes straight to paying ──────────────────────────────────────
  await js(`(() => { const b = [...document.querySelectorAll('button')].filter(x => /Buy now/i.test(x.innerText)).pop(); b.click() })()`)
  await sleep(1200)
  ok('Buy now lands on checkout', await js(`location.hash === '#/checkout'`), await js(`location.hash`))
  ok('with the item already in the order', await js(`document.body.innerText.includes('Satin Duvet Set')`))

  // ── a returning customer does not retype everything ──────────────────────
  const type = async (ph, v) => { await h.type(`input[placeholder="${ph}"], textarea[placeholder="${ph}"]`, v) }
  await type('Full name', 'Ama Mensah')
  await type('Phone number', '0548124978')
  await type('Delivery address (area, landmark)', 'Spintex, near the filling station')
  await sleep(300)
  await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Pay |Place Order/i.test(x.innerText)); b && b.click() })()`)
  await sleep(2500)

  const saved = await js(`localStorage.getItem('etr_buyer')`)
  ok('the buyer is remembered after ordering', !!saved && saved.includes('Ama Mensah'), String(saved))

  // Come back as that customer would, on the same phone.
  await w.loadURL(DEV)
  await h.waitFor(`document.body.innerText.includes('Satin Duvet Set')`, 20000)
  await js(`window.location.hash = '/checkout'`); await sleep(1200)
  const filled = await js(`(() => {
    const v = ph => (document.querySelector('input[placeholder="' + ph + '"], textarea[placeholder="' + ph + '"]') || {}).value
    return { name: v('Full name'), phone: v('Phone number'), addr: v('Delivery address (area, landmark)') }
  })()`)
  ok('their name comes back filled in', filled.name === 'Ama Mensah', JSON.stringify(filled))
  ok('their number too', filled.phone === '0548124978', JSON.stringify(filled))
  ok('and the directions to their house', /Spintex/.test(filled.addr || ''), JSON.stringify(filled))

  finish()
}).catch(e => { ok('ran', false, e && e.stack); finish(4) })
