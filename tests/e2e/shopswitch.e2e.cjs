/**
 * Opening and closing the online shop from the POS.
 *
 * The switch existed in the sidebar the whole time, hidden by a flag that said
 * the brand had no e-commerce site — which stopped being true when
 * bedtimehome.com went live with the catalogue. So there was no visible way to
 * close the shop. This drives the new section and watches what is written.
 *
 * Run with: npm run test:shopswitch
 */
const path = require('path')
const { app, BrowserWindow } = require('electron')
const { intercept, helpers, sleep } = require('./flow.cjs')
const DEV = process.env.POS_DEV_URL || 'http://localhost:5173'

let pass = 0, fail = 0
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + l) } else { fail++; console.log('  \x1b[31m✗ ' + l + '\x1b[0m ' + (e || '')) } }
const finish = (code) => { console.log(`\n${pass} passed, ${fail} failed`); app.exit(code ?? (fail ? 1 : 0)) }
setTimeout(() => { ok('finished within 180s', false); finish(2) }, 180000)
process.on('unhandledRejection', (e) => { ok('no unhandled rejection', false, e && e.stack); finish(3) })
app.on('window-all-closed', () => {})

const PRODUCTS = [{ id: 'p1', name: 'Satin Duvet', category: 'Duvets', price: 450, cost_price: 300, quantity: 5 }]
let shopOpen = true
let closedMessage = 'Back tomorrow morning.'

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1400, height: 1000 })
  await w.loadURL(DEV)
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)

  const saved = []
  net.script = ({ method, path: p, query, body }) => {
    // A preflight has to be answered by the real server, or the browser never
    // sends the request it is asking permission for — which is why an earlier
    // version of this test saw no writes at all.
    if (method === 'OPTIONS') return undefined
    if (p.endsWith('/rest/v1/store_settings')) {
      if (method === 'GET') {
        return /closed_message/.test(query) ? [{ closed_message: closedMessage }] : [{ shop_open: shopOpen }]
      }
      // A preflight arrives with no body; only a real upsert carries one.
      const row = Array.isArray(body) ? body[0] : body
      if (!row || typeof row !== 'object') return [{ shop_open: shopOpen, closed_message: closedMessage }]
      saved.push(row)
      if ('shop_open' in row) shopOpen = row.shop_open
      if ('closed_message' in row) closedMessage = row.closed_message
      return [{ shop_open: shopOpen, closed_message: closedMessage }]
    }
    if (method !== 'GET') return undefined
    if (p.endsWith('/rest/v1/products')) return PRODUCTS
    if (p.startsWith('/rest/v1/')) return []
    return undefined
  }
  await w.loadURL(DEV)
  const h = helpers(w, dbg)
  const js = h.js

  await h.waitFor('!!window.__POS_STORE__', 12000)
  await js(`window.__POS_STORE__.getState().login({ id: 'e2e', name: 'E2E Admin', role: 'Admin' }, true)`)
  await h.waitFor(`(() => { const s = window.__POS_STORE__.getState(); return s.products.length > 0 && !s.loading })()`, 20000)

  // It has to be findable, which was the whole complaint.
  const inNav = await js(`[...document.querySelectorAll('button,a')].some(b => /Online Shop/i.test(b.innerText))`)
  ok('"Online Shop" appears in the navigation', inNav)

  await js(`window.__POS_STORE__.getState().setPage('onlineshop')`)
  await h.waitFor(`document.body.innerText.includes('Online Shop')`, 10000)
  await sleep(900)
  const text = () => js(`document.body.innerText`)
  ok('the section opens', /Open or close/i.test(await text()))
  ok('and says plainly that customers can order', /Customers can order/i.test(await text()), (await text()).slice(0, 120))

  // ── closing ──────────────────────────────────────────────────────────────
  await js(`(() => { window.confirm = () => true; return 'ok' })()`)   // accept the close confirmation
  saved.length = 0
  const closeBtn = await h.tap('button', 'Close shop')
  ok('the close button works', closeBtn.ok, closeBtn.why)
  await sleep(1200)
  ok('shop_open=false was written', saved.some(r => r.shop_open === false), JSON.stringify(saved))
  ok('the screen now says customers cannot order', /Customers cannot order/i.test(await text()))
  ok('and the store agrees', (await js(`window.__POS_STORE__.getState().shopOpen`)) === false)

  // ── opening again ────────────────────────────────────────────────────────
  saved.length = 0
  const openBtn = await h.tap('button', 'Open shop')
  ok('the open button works', openBtn.ok, openBtn.why)
  await sleep(1200)
  ok('shop_open=true was written', saved.some(r => r.shop_open === true), JSON.stringify(saved))
  ok('and it reads as open again', /Customers can order/i.test(await text()))

  // ── the closed notice, which nothing could set before ────────────────────
  const ta = await js(`(() => {
    const t = document.querySelector('textarea'); if (!t) return 'none'
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(t, 'Closed for stock take. Back Monday.')
    t.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'
  })()`)
  ok('the closed notice can be edited', ta === 'ok')
  await sleep(400)
  ok('and the preview shows what customers will read',
     /Closed for stock take/.test(await text()))
  saved.length = 0
  const saveBtn = await h.tap('button', 'Save message')
  ok('saving it works', saveBtn.ok, saveBtn.why)
  await sleep(1200)
  ok('the message was written', saved.some(r => r.closed_message === 'Closed for stock take. Back Monday.'), JSON.stringify(saved))

  finish()
}).catch(e => { ok('ran', false, e && e.stack); finish(4) })
