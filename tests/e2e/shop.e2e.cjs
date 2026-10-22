/**
 * The promotion on the shop front, through the real UI in a real browser.
 *
 * Supabase is answered from fixtures, so the run is about what the page does
 * with a promotion, not about the network: a sale with two of four products in
 * it, one of them nearly sold out.
 *
 * Run with: npm run test:shop   (starts the storefront's Vite if it is not up)
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

// ── the shop, as the fixtures describe it ──────────────────────────────────
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)
const PRODUCTS = [
  { id: 'a', name: 'Satin Duvet Set', category: 'Duvets',  price: 450, quantity: 12, image: null, created_at: '2026-10-05' },
  { id: 'b', name: 'Cotton Bedsheet', category: 'Sheets',  price: 320, quantity: 3,  image: null, created_at: '2026-10-04' },
  { id: 'c', name: 'Memory Pillow',   category: 'Pillows', price: 90,  quantity: 40, image: null, created_at: '2026-10-03' },
  { id: 'd', name: 'Mattress Topper', category: 'Toppers', price: 600, quantity: 8,  image: null, created_at: '2026-10-02' },
]
const PROMO = {
  id: 'p1', name: 'Black Friday', active: true,
  start_date: iso(-1), end_date: iso(2),
  items: [
    { productId: 'a', promoPrice: 270 },   // 450 -> -40%, the biggest saving
    { productId: 'b', promoPrice: 288 },   // 320 -> -10%
  ],
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1366, height: 900 })
  await w.loadURL(DEV)
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)
  net.script = ({ method, path: p }) => {
    if (method !== 'GET') return undefined
    if (p.endsWith('/rest/v1/products')) return PRODUCTS
    if (p.endsWith('/rest/v1/promos')) return [PROMO]
    if (p.endsWith('/rest/v1/store_settings')) return [{ shop_open: true, closed_message: '' }]
    if (p.startsWith('/rest/v1/')) return []
    return undefined
  }
  await w.loadURL(DEV)
  const h = helpers(w, dbg)
  const js = h.js
  const text = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.innerText : null })()`)
  const loaded = await h.waitFor(`document.body.innerText.includes('Satin Duvet Set')`, 20000)
  ok('the shop front loads with its catalogue', loaded)
  if (!loaded) return finish(1)

  // ── the promotion leads the page ─────────────────────────────────────────
  const section = () => js(`(() => {
    const h2 = [...document.querySelectorAll('h2')].find(e => /Black Friday/i.test(e.innerText))
    return h2 ? h2.closest('section').innerText : null
  })()`)
  const sec = await section()
  ok('the promotion has its own section, named as the shop named it', !!sec && /Black Friday/.test(sec), sec)
  ok('with the two products that are in it', !!sec && sec.includes('Satin Duvet Set') && sec.includes('Cotton Bedsheet'))
  ok('and nothing that is not', !!sec && !sec.includes('Memory Pillow') && !sec.includes('Mattress Topper'))

  // The line under the heading is the reason to read on.
  ok('says how much the best offer takes off', !!sec && /up to\s*40% off/i.test(sec), sec && sec.slice(0, 160))
  ok('counts the items in it', !!sec && /2 items/.test(sec))

  // Biggest saving first, so the strongest offer is the first thing seen.
  const order = await js(`(() => {
    const h2 = [...document.querySelectorAll('h2')].find(e => /Black Friday/i.test(e.innerText))
    return [...h2.closest('section').querySelectorAll('.card-lift')].map(c => c.innerText.split('\\n').find(l => /Duvet|Bedsheet|Pillow|Topper/.test(l)))
  })()`)
  ok('the biggest saving is first', order[0] === 'Satin Duvet Set', JSON.stringify(order))

  // ── what a card tells a shopper ──────────────────────────────────────────
  const card = await js(`(() => {
    const h2 = [...document.querySelectorAll('h2')].find(e => /Black Friday/i.test(e.innerText))
    return [...h2.closest('section').querySelectorAll('.card-lift')][0].innerText
  })()`)
  ok('the discounted price is shown', /270/.test(card), card)
  ok('beside the price it replaced', /450/.test(card))
  ok('with the saving in cedis, not only a percentage', /You save/i.test(card) && /180/.test(card), card)
  ok('and the percentage on the image', /-40%/.test(card))

  // Nearly sold out, said before checkout rather than after.
  const lowCard = await js(`(() => {
    const h2 = [...document.querySelectorAll('h2')].find(e => /Black Friday/i.test(e.innerText))
    return [...h2.closest('section').querySelectorAll('.card-lift')].map(c => c.innerText).find(t => /Cotton Bedsheet/.test(t))
  })()`)
  ok('a nearly sold out item says so', /Only 3 left/i.test(lowCard), lowCard)

  // ── the homepage does not say the same thing twice ───────────────────────
  const arrivals = await js(`(() => {
    const h2 = [...document.querySelectorAll('h2')].find(e => /New arrivals/i.test(e.innerText))
    return h2 ? h2.closest('section').innerText : null
  })()`)
  ok('New arrivals exists', !!arrivals)
  ok('and does not repeat the promoted products', !!arrivals && !arrivals.includes('Satin Duvet Set') && !arrivals.includes('Cotton Bedsheet'), arrivals)
  ok('while still showing the rest', !!arrivals && arrivals.includes('Memory Pillow') && arrivals.includes('Mattress Topper'))

  // ── "See all offers" has somewhere to go ─────────────────────────────────
  await js(`window.location.hash = '/shop/offers'`); await sleep(600)
  const shopText = await js(`document.body.innerText`)
  ok('a deep link to /shop/offers opens the offers', /Black Friday/i.test(shopText), shopText.slice(0, 200))
  const gridNames = await js(`[...document.querySelectorAll('.card-lift')].map(c => c.innerText.split('\\n').find(l => /Duvet|Bedsheet|Pillow|Topper/.test(l)))`)
  ok('showing only what is on offer', gridNames.length === 2 && gridNames.includes('Satin Duvet Set') && gridNames.includes('Cotton Bedsheet'), JSON.stringify(gridNames))

  // The chip is how someone browsing gets back to the sale.
  const chip = await js(`(() => { const b = [...document.querySelectorAll('button')].find(e => /^Offers \\(/.test(e.innerText)); return b ? b.innerText : null })()`)
  ok('an Offers chip carries the count', chip === 'Offers (2)', chip)
  const all = await h.tap('button', 'All')
  ok('tapping All leaves the offers', all.ok, all.why)
  await sleep(400)
  const afterAll = await js(`[...document.querySelectorAll('.card-lift')].length`)
  ok('and shows the whole catalogue again', afterAll === 4, String(afterAll))
  const back = await h.tap('button', 'Offers (2)')
  ok('tapping Offers filters back down', back.ok, back.why)
  await sleep(400)
  ok('to the two on offer', (await js(`[...document.querySelectorAll('.card-lift')].length`)) === 2)

  finish()
}).catch(e => { ok('ran', false, e && e.stack); finish(4) })
