/**
 * Setting up a promotion in the admin app, through the real UI.
 *
 * The case that matters is the shop's real one: one bedsheet sold in forty
 * colours, each its own product among hundreds. Before this, that meant forty
 * trips through a dropdown and forty typed prices.
 *
 * Run with: npm run test:promos   (starts Vite if it is not already running)
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

const sheets = Array.from({ length: 40 }, (_, i) => ({
  id: `s${i + 1}`, name: `1 Double Bedsheet with 2 pillow cases (color ${i + 1})`,
  category: 'Bedsheets', price: 80, cost_price: 50, quantity: 20,
  // The shop already tags every colour of one product with the same variant
  // group, so five across colours trigger the wholesale price.
  group_tag: 'double-bedsheet-2-cases',
}))
const PRODUCTS = [...sheets,
  { id: 'd1', name: 'Satin Duvet Set', category: 'Duvets', price: 450, cost_price: 300, quantity: 12 },
  { id: 'p1', name: 'Memory Pillow', category: 'Pillows', price: 90, cost_price: 50, quantity: 40 }]

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1500, height: 1000 })
  await w.loadURL(DEV)
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)
  net.script = ({ method, path: p }) => {
    if (method !== 'GET') return undefined
    if (p.endsWith('/rest/v1/products')) return PRODUCTS
    if (p.endsWith('/rest/v1/promos')) return []
    if (p.startsWith('/rest/v1/')) return []
    return undefined
  }
  await w.loadURL(DEV)
  const h = helpers(w, dbg)
  const js = h.js

  await h.waitFor('!!window.__POS_STORE__', 12000)
  await js(`window.__POS_STORE__.getState().login({ id: 'e2e', name: 'E2E Admin', role: 'Admin' }, true)`)
  // The page is built from the catalogue, so wait for it rather than for a
  // fixed number of milliseconds.
  await h.waitFor(`(() => { const s = window.__POS_STORE__.getState(); return s.products.length > 0 && !s.loading })()`, 20000)
  await js(`window.__POS_STORE__.getState().setPage('promos')`)
  await h.waitFor(`document.body.innerText.includes('Manage promotions')`, 10000)
  ok('the promos page opens', await js(`document.body.innerText.includes('Manage promotions')`))
  ok('and is not titled twice over', !(await js(`document.body.innerText.includes('Promos Promos')`)))

  const opened = await h.tap('button', 'New Promo'); await sleep(500)
  ok('New Promo opens', opened.ok, opened.why)

  const SEARCH = 'input[placeholder="Search products, e.g. bedsheet"]'
  ok('there is a search box instead of a list of 652', !!(await js(`!!document.querySelector(${JSON.stringify(SEARCH)})`)))

  // ── forty colours are one row ────────────────────────────────────────────
  await h.type(SEARCH, 'bedsheet'); await sleep(500)
  ok('typing "bedsheet" finds the forty colours', await js(`document.body.innerText.includes('40 matches')`))
  ok('and collapses them into one row', await js(`document.body.innerText.includes('in 1 row')`),
     await js(`document.body.innerText.match(/40 matches[^\\n]*/)?.[0]`))
  ok('named by what the colours share',
     await js(`document.body.innerText.includes('1 Double Bedsheet with 2 pillow cases')`))
  ok('offering to add all forty at once', await js(`document.body.innerText.includes('Add 40')`))

  // Tapping the row is the whole job.
  const row = await h.tap('button', 'Add 40'); await sleep(700)
  ok('tapping the row takes the lot', row.ok, row.why)
  ok('forty are now selected', await js(`document.body.innerText.includes('40 selected')`),
     await js(`document.body.innerText.match(/\\d+ selected/)?.[0]`))
  ok('and the row says so', await js(`document.body.innerText.includes('Added')`))

  // ── priced together, not one by one ──────────────────────────────────────
  // The chosen side collapses the forty colours into one row with one price
  // box, because forty lines reading "1 Double Bedsheet with 2 pillow ca…"
  // tell nobody which is which.
  const groupPrice = `document.querySelector('input[placeholder="Price"]').value`
  await h.type('input[placeholder="20"]', '20'); await sleep(250)
  const pct = await h.tap('button', '% off all'); await sleep(600)
  ok('"% off all" applies to the whole set', pct.ok, pct.why)
  ok('20% off 80 is 64, shown once for the set', (await js(groupPrice)) === '64', await js(groupPrice))

  // The shop's actual promotion is a flat price.
  await h.type('input[placeholder="75"]', '75'); await sleep(250)
  const fixed = await h.tap('button', 'Set all to'); await sleep(600)
  ok('"Set all to" overrides it', fixed.ok, fixed.why)
  ok('the set sits at 75', (await js(groupPrice)) === '75', await js(groupPrice))
  ok('and the header states what it is worth',
     await js(`document.body.innerText.includes('6% off')`),
     await js(`document.body.innerText.match(/40 selected[^\\n]*/)?.[0]`))

  // A colour that needs its own price can still have one.
  const each = await h.tap('button', 'Price each'); await sleep(600)
  ok('the set opens to show every colour', each.ok, each.why)
  const at75 = await js(`[...document.querySelectorAll('input[type=number]')].filter(i => i.value === '75').length`)
  ok('all forty really are at 75', at75 >= 40, `only ${at75} at 75`)
  await h.tap('button', 'Hide'); await sleep(400)

  // ── it refuses to save something wrong, in words ─────────────────────────
  await h.tap('button', 'Save'); await sleep(500)
  const refused = await js(`document.body.innerText`)
  ok('saving without a name is refused', /Give the promotion a name/i.test(refused))
  ok('and nothing was written', net.writes.filter(x => x.path.includes('promos')).length === 0)

  await h.type('input[placeholder="Promo name"]', 'Black Friday'); await sleep(250)
  ok('a missing end date is named too', await js(`document.body.innerText.includes('Choose an end date')`))

  await js(`(() => {
    const el = [...document.querySelectorAll('input[type=date]')][1]
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(el, '2026-12-31')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`); await sleep(400)
  ok('with the dates filled there is nothing left to fix',
     !(await js(`document.body.innerText.includes('Choose an end date')`)))

  // ── and saves what was on the screen ─────────────────────────────────────
  await h.tap('button', 'Save'); await sleep(1200)
  const write = net.writes.find(x => x.path.includes('promos') && x.method === 'POST')
  ok('the promotion is written', !!write, JSON.stringify(net.writes.map(x => x.method + ' ' + x.path)))
  if (write) {
    const body = Array.isArray(write.body) ? write.body[0] : write.body
    ok('named as typed', body.name === 'Black Friday', body.name)
    ok('carrying all forty products', body.items?.length === 40, String(body.items?.length))
    ok('every one at 75', body.items.every(i => Number(i.promoPrice) === 75))
    ok('each remembering what it cost before', body.items.every(i => Number(i.originalPrice) === 80))
    ok('and it goes live', body.active === true)
  }

  finish()
}).catch(e => { ok('ran', false, e && e.stack); finish(4) })
