/**
 * The figure must not change when you close and reopen the POS.
 *
 * The reported fault: paid customers showed 53, then 42, then 23 across
 * restarts. Each was an honest count of a different window — `waOrders` holds
 * the newest N orders, and N was 200 on the initial load and 500 after a
 * refresh, while the counts were computed by filtering that array.
 *
 * This serves a table far larger than any limit and answers each request with
 * a DIFFERENT slice, the way a real newest-first query does as orders arrive.
 * If a figure is counted in memory it will wander; if it is counted in the
 * database it cannot.
 *
 * Run with: npm run test:counts
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

// 900 orders: far more than any limit the app uses.
const ALL = []
const push = (n, status, paid) => { for (let i = 0; i < n; i++) ALL.push({
  id: `o${ALL.length}`, order_no: `WEB-${ALL.length}`, date: new Date(Date.now() - ALL.length * 60000).toISOString(),
  customer_name: 'Customer', customer_phone: '0548124978', items: '[]', subtotal: 100, total: 100,
  status, paid_at: paid ? '2026-11-01T10:00:00Z' : null, source: 'web', notes: '' }) }
push(530, 'Paid', true); push(220, 'Pending', false); push(90, 'Completed', true); push(60, 'Cancelled', false)
// One order spelled in lower case, as production holds. Every status check in
// the app used === , so this order was absent from the Cancelled list and from
// the counts: the figures summed to one less than the table.
ALL.push({ id: 'o-lower', order_no: 'WEB-lower', date: new Date(Date.now() - 1e6).toISOString(),
  customer_name: 'Customer', customer_phone: '0548124978', items: '[]', subtotal: 100, total: 100,
  status: 'cancelled', paid_at: null, source: 'web', notes: '' })

// Which rotation of the table this open sees. Real queries are newest-first and
// orders keep arriving, so the window moves between sessions — but within one
// session the pages must be consistent, or paging would duplicate and skip rows.
let generation = 0
const view = () => { const k = (generation * 37) % ALL.length; return ALL.slice(k).concat(ALL.slice(0, k)) }

/** The subset of PostgREST's filter grammar the app actually sends. */
const applyFilters = (rows, decoded) => {
  const inM = /status=in\.\(([^)]*)\)/.exec(decoded)
  if (inM) {
    const wanted = decodeURIComponent(inM[1]).replace(/"/g, '').split(',')
    rows = rows.filter(o => wanted.includes(o.status))
  }
  // or=(status.ilike.Paid,status.ilike.Completed) — ilike without a wildcard
  // is a case-insensitive equality test, which is the whole point of it here.
  const orM = /or=\(([^)]*)\)/.exec(decoded)
  if (orM) {
    const terms = orM[1].split(',').map(term => {
      const bits = term.split('.')
      return { col: bits[0], op: bits[1], val: bits.slice(2).join('.') }
    })
    rows = rows.filter(o => terms.some(({ col, op, val }) =>
      op === 'ilike' ? String(o[col] == null ? '' : o[col]).toLowerCase() === val.toLowerCase()
                     : String(o[col] == null ? '' : o[col]) === val))
  }
  if (/paid_at=is\.null/.test(decoded)) rows = rows.filter(o => !o.paid_at)
  if (/sale_receipt_no=is\.null/.test(decoded)) rows = rows.filter(o => !o.sale_receipt_no)
  return rows
}
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1400, height: 1000 })
  await w.loadURL(DEV)
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)

  net.script = ({ method, path: p, query, headers }) => {
    if (method === 'OPTIONS') return undefined
    if (p.endsWith('/rest/v1/whatsapp_orders')) {
      // A count request: supabase-js asks with select=id ALONE and reads the
      // total out of Content-Range, not the body. `select=id\b` also matches
      // `select=id,order_no,...`, which is the row request — so it has to be
      // id and nothing else. The parentheses of in.(...) and or=(...) arrive
      // percent-encoded.
      const decoded = decodeURIComponent(query || '')
      if (/select=id(&|$)/.test(query || '')) {
        const rows = applyFilters(ALL, decoded)
        return { body: [], __headers: { 'Content-Range': `0-0/${rows.length}` } }
      }
      // A row request. The app now pages through the table with a Range header
      // instead of taking the newest 500, so honour the range it asked for —
      // and serve a consistent view within the open, or paging would hand back
      // the same row twice and miss another.
      const rows = applyFilters(view(), decoded)
      const rangeH = (headers && (headers.Range || headers.range)) || ''
      const rm = /(\d+)-(\d+)/.exec(rangeH)
      const from = rm ? Number(rm[1]) : 0
      const to = rm ? Number(rm[2]) : from + Number((/limit=(\d+)/.exec(query || '') || [])[1] || 1000) - 1
      const page = rows.slice(from, to + 1)
      return { body: page, __headers: { 'Content-Range': `${from}-${from + page.length - 1}/${rows.length}` } }
    }
    if (method !== 'GET') return undefined
    if (p.endsWith('/rest/v1/products')) return [{ id: 'p1', name: 'Duvet', category: 'Duvets', price: 450, cost_price: 300, quantity: 5 }]
    if (p.startsWith('/rest/v1/')) return []
    return undefined
  }

  const openPos = async () => {
    generation++            // the window has moved, as it does in production
    await w.loadURL(DEV)
    const h = helpers(w, dbg)
    await h.waitFor('!!window.__POS_STORE__', 12000)
    await h.js(`window.__POS_STORE__.getState().login({ id: 'e2e', name: 'E2E Admin', role: 'Admin' }, true)`)
    await h.waitFor(`(() => { const s = window.__POS_STORE__.getState(); return s.products.length > 0 && !s.loading })()`, 20000)
    await h.js(`window.__POS_STORE__.getState().setPage('whatsapp')`)
    await sleep(2200)
    return h.js(`(() => {
      const nums = [...document.querySelectorAll('div')].filter(d => /^(Pending|Paid|Completed)$/.test(d.innerText.trim()))
        .map(d => (d.nextElementSibling || {}).innerText || '')
      const s = window.__POS_STORE__.getState()
      return { labels: nums, loaded: s.waOrders.length, counts: s.counts }
    })()`)
  }

  const h2 = helpers(w, dbg)
  const runs = []
  for (let i = 0; i < 3; i++) runs.push(await openPos())
  runs.forEach((r, i) => console.log(`    open ${i + 1}: figures ${JSON.stringify(r.labels)}  (orders in memory: ${r.loaded})`))

  ok('the POS was opened three times', runs.length === 3)
  ok('the whole table is loaded, not the newest slice of it',
     runs.every(r => r.loaded === ALL.length),
     runs.map(r => r.loaded).join(' vs ') + ' of ' + ALL.length)

  const same = JSON.stringify(runs[0].labels)
  ok('the figures are IDENTICAL across every open', runs.every(r => JSON.stringify(r.labels) === same),
     runs.map(r => JSON.stringify(r.labels)).join(' vs '))

  ok('paid reads the whole table, not the loaded slice', runs[0].labels.includes('530'), JSON.stringify(runs[0].labels))
  ok('pending too', runs[0].labels.includes('220'), JSON.stringify(runs[0].labels))
  ok('and completed', runs[0].labels.includes('90'), JSON.stringify(runs[0].labels))
  ok('none of them is marked approximate', !runs[0].labels.some(l => l.includes('~')), JSON.stringify(runs[0].labels))

  // ── the order no filter could see ──────────────────────────────────────────
  const c = runs[0].counts
  ok('a lower-case status is still counted as cancelled', c.cancelled === 61, JSON.stringify(c))
  ok('and the status figures account for every order',
     c.pending + c.paid + c.completed + c.cancelled === c.total,
     `${c.pending}+${c.paid}+${c.completed}+${c.cancelled} vs total ${c.total}`)
  ok('the table total is counted, not inferred', c.total === ALL.length, String(c.total))

  // The Cancelled list must contain it too, not merely the count.
  await h2.js(`window.__POS_STORE__.getState().setWAFilter('Cancelled')`)
  await sleep(600)
  const cancelledShown = await h2.js(`window.__POS_STORE__.getState().waOrders.filter(o => String(o.status).toLowerCase() === 'cancelled').length`)
  ok('the cancelled orders are all in memory to be listed', cancelledShown === 61, String(cancelledShown))

  finish()
}).catch(e => { ok('ran', false, e && e.stack); finish(4) })
