/**
 * Cashier scenarios, run in both runtimes by tests/e2e/pos.e2e.cjs:
 *   cash     tap A, tap B, tap A again, cart: decrease A, remove B, pay Cash,
 *            double-tap Confirm → exactly one sale, receipt, print
 *   momo     pay by MoMo prompt → order row created → prompt sent → the order
 *            is marked Paid by the (simulated) callback → sale → receipt
 *   split    part cash, part MoMo prompt → one sale with both amounts
 *   reprint  transaction history → View → print a past sale
 *
 * Every database write and every Edge Function call is intercepted with CDP
 * Fetch and answered the way the server answers it, so nothing touches live
 * data and nobody's phone gets a real MoMo prompt. Reads go to the live
 * project, so products, stock and past sales are real.
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Network layer: record writes, answer them, and let scenarios script more. */
async function intercept(dbg, net) {
  let saleN = 0
  await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co/*', requestStage: 'Request' }] })
  dbg.on('message', async (_e, method, p) => {
    if (method !== 'Fetch.requestPaused') return
    const { requestId, request } = p
    const url = request.url, m = request.method
    const path = url.replace(/^https:\/\/[^/]+/, '').split('?')[0]
    const query = (url.split('?')[1] || '')
    let body = null; try { body = JSON.parse(request.postData || 'null') } catch { body = request.postData }
    // Answer on a later tick. Fulfilling a POST inside the requestPaused
    // handler itself crashes Electron 32 (SIGSEGV) — reproduced on the MoMo
    // order insert; deferring it does not.
    const reply = async (obj, code = 200) => { await sleep(30); return dbg.sendCommand('Fetch.fulfillRequest', {
      requestId, responseCode: code,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(obj)).toString('base64'),
    }).catch(() => {}) }

    // A scenario may script any request, reads included.
    if (process.env.E2E_TRACE) process.stderr.write(`NET ${m} ${path}?${query.slice(0, 60)} post=${(request.postData || '').length} has=${request.hasPostData}\n`)
    const scripted = net.script ? net.script({ method: m, path, query, body, url }) : undefined
    if (scripted !== undefined) {
      if (m !== 'GET') net.writes.push({ method: m, path, query, body, at: Date.now() })
      if (scripted && scripted.__status) return reply(scripted.body || {}, scripted.__status)
      return reply(scripted)
    }

    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || /\/realtime\//.test(url)) {
      return dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {})
    }
    net.writes.push({ method: m, path, query, body, at: Date.now() })
    if (path.endsWith('/rpc/record_sale')) {
      saleN++
      const items = Array.isArray(body?.p_items) ? body.p_items : []
      const total = items.reduce((a, c) => a + Number(c.price) * Number(c.qty), 0) - Number(body?.p_discount || 0)
      await sleep(400)   // a real round trip, so a second tap has time to land
      net.lastReceipt = `RCP-E2E-${String(saleN).padStart(3, '0')}`
      return reply({ success: true, receiptNo: net.lastReceipt, saleId: `e2e-${saleN}`, subtotal: total, discount: 0, total, profit: 0, date: new Date().toISOString() })
    }
    if (path.includes('/functions/')) return reply({ success: true })
    return reply(/\/rpc\//.test(path) ? null : {})
  })
}

function helpers(w, dbg) {
  const js = (s) => w.webContents.executeJavaScript(s)
  const click = async (x, y) => {
    w.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    w.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }
  const locate = (sel, text, idx = 0) => js(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && ${text ? `(e.innerText || '').includes(${JSON.stringify(text)})` : 'true'})
    const e = els[${idx}]; if (!e) return null
    e.scrollIntoView({ block: 'center' })
    const r = e.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, blocked: !e.contains(hit), by: hit && (hit.className || hit.tagName).toString().slice(0, 60), disabled: !!e.disabled }
  })()`)
  const tap = async (sel, text, idx) => {
    const p = await locate(sel, text, idx)
    if (!p) return { ok: false, why: 'not found' }
    if (p.blocked) return { ok: false, why: 'covered by ' + p.by }
    await click(p.x, p.y); await sleep(350)
    return { ok: true }
  }
  const type = async (sel, text, idx = 0) => {
    const p = await locate(sel, null, idx); if (!p) return false
    await click(p.x, p.y); await sleep(120)
    await js(`(() => { const e = document.activeElement; if (e && e.select) e.select() })()`)
    await dbg.sendCommand('Input.insertText', { text }); await sleep(250)
    return true
  }
  const S = (expr) => js(`(() => { const s = window.__POS_STORE__.getState(); return ${expr} })()`)
  const waitFor = async (expr, ms = 10000) => { for (let t = 0; t < ms; t += 200) { if (await js(expr)) return true; await sleep(200) } return false }
  return { js, click, locate, tap, type, S, waitFor }
}

async function login(h, ok, label, role = 'Cashier') {
  await h.waitFor('!!window.__POS_STORE__', 8000)
  ok(`[${label}] app booted`, await h.js('!!window.__POS_STORE__'))
  await h.js(`window.__POS_STORE__.getState().login({ id: 'e2e-${role}', name: 'E2E ${role}', role: '${role}' }, ${role === 'Admin'}); window.__POS_STORE__.getState().setPage('pos')`)
  await h.waitFor(`(() => { const s = window.__POS_STORE__.getState(); return s.products.length > 0 && !s.loading })()`, 15000)
  await h.waitFor("document.querySelectorAll('button.bg-white.overflow-hidden').length > 10", 10000)
}

/** Two in-stock, uniquely-named products that are actually on screen. */
async function pickProducts(h, exclude = []) {
  return JSON.parse(await h.js(`(() => {
    const s = window.__POS_STORE__.getState(), ex = ${JSON.stringify(exclude)}
    const shown = new Set([...document.querySelectorAll('button')].map(b => (b.innerText || '').split('\\n')[0].trim()))
    const ok = s.products.filter(p => !ex.includes(p.id) && p.quantity >= 3 && p.price > 0 && shown.has(p.name) && s.products.filter(q => q.name === p.name).length === 1)
    return JSON.stringify(ok.slice(0, 2).map(p => ({ id: p.id, name: p.name, stock: p.quantity, price: p.price })))
  })()`))
}

const CARD = 'button.bg-white.overflow-hidden'
const lastSale = (net, since) => net.writes.slice(since).filter(x => x.path.endsWith('/rpc/record_sale'))

async function openPayment(h, ok, label) {
  let t = await h.tap('button[class*="bottom-[calc(90px"]'); ok(`[${label}] open the cart`, t.ok, t.why)
  await sleep(300)
  t = await h.tap('button', 'Complete Sale'); ok(`[${label}] open payment`, t.ok, t.why)
}

async function checkReceipt(h, ok, label, A, net) {
  await h.waitFor('!!document.querySelector(\'iframe[title="Receipt preview"]\')', 15000)
  const receiptNo = net.lastReceipt || '(no sale recorded)'
  const receipt = await h.js(`(() => { const f = document.querySelector('iframe[title="Receipt preview"]'); return f ? f.srcdoc : '' })()`)
  ok(`[${label}] receipt shows ${receiptNo}`, receipt.includes(receiptNo))
  ok(`[${label}] receipt lists the product`, receipt.includes(A.name) || receipt.includes(A.name.replace(/&/g, '&amp;')))
  return receiptNo
}

async function closeReceipt(h) {
  await h.tap('button', 'Done'); await sleep(300)
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function cash({ h, net, ok, label, printCheck }) {
  const nP = await h.S('s.products.length'); ok(`[${label}] products load (${nP})`, nP > 0)
  const pick = await pickProducts(h); ok(`[${label}] two sellable products on screen`, pick.length === 2, JSON.stringify(pick))
  if (pick.length < 2) return
  const [A, B] = pick
  let t = await h.tap(CARD, A.name); ok(`[${label}] tap product A`, t.ok, t.why)
  ok(`[${label}] A is in the cart`, await h.S(`s.cart.some(c => c.productId === ${JSON.stringify(A.id)} && c.qty === 1)`))
  t = await h.tap(CARD, B.name); ok(`[${label}] tap product B`, t.ok, t.why)
  await h.tap(CARD, A.name)
  ok(`[${label}] tapping A again makes it qty 2`, await h.S(`(s.cart.find(c => c.productId === ${JSON.stringify(A.id)}) || {}).qty === 2`))
  ok(`[${label}] cart has 2 lines`, await h.S('s.cart.length') === 2)

  t = await h.tap('button[class*="bottom-[calc(90px"]'); ok(`[${label}] open the cart`, t.ok, t.why)
  await sleep(400)
  const aIdx = await h.S(`s.cart.findIndex(c => c.productId === ${JSON.stringify(A.id)})`)
  const bIdx = await h.S(`s.cart.findIndex(c => c.productId === ${JSON.stringify(B.id)})`)
  t = await h.tap('button[aria-label="Decrease quantity"]', null, aIdx); ok(`[${label}] tap decrease on A`, t.ok, t.why)
  ok(`[${label}] A back to qty 1`, await h.S(`(s.cart.find(c => c.productId === ${JSON.stringify(A.id)}) || {}).qty === 1`))
  t = await h.tap('button[aria-label="Remove item"]', null, bIdx); ok(`[${label}] tap remove on B`, t.ok, t.why)
  ok(`[${label}] B removed, A left`, await h.S(`s.cart.length === 1 && s.cart[0].productId === ${JSON.stringify(A.id)}`))
  ok(`[${label}] cart total is A's price`, Math.abs((await h.S('s.cart.reduce((a, c) => a + c.lineTotal, 0)')) - A.price) < 0.001)

  t = await h.tap('button', 'Complete Sale'); ok(`[${label}] open payment`, t.ok, t.why)
  t = await h.tap('button', 'At counter'); ok(`[${label}] choose Cash`, t.ok, t.why)
  ok(`[${label}] type the phone`, await h.type('input[placeholder="024 000 0000"]', '0244000000'))
  const stockBefore = await h.S(`s.products.find(p => p.id === ${JSON.stringify(A.id)}).quantity`)
  const confirm = await h.locate('button', 'Confirm Cash Payment')
  ok(`[${label}] Confirm Cash Payment is tappable`, !!confirm && !confirm.blocked && !confirm.disabled, JSON.stringify(confirm))
  const since = net.writes.length
  if (confirm) { await h.click(confirm.x, confirm.y); await h.click(confirm.x, confirm.y) }   // the double tap
  const rno = await checkReceipt(h, ok, label, A, net)
  const sales = lastSale(net, since)
  ok(`[${label}] a double tap records the sale ONCE (got ${sales.length})`, sales.length === 1)
  const sent = sales[0] && sales[0].body
  ok(`[${label}] sale sent: A x1, Cash, phone, cashier`, !!sent && sent.p_items.length === 1 && sent.p_items[0].productId === A.id && sent.p_items[0].qty === 1 && sent.p_payment === 'Cash' && sent.p_customer === '0244000000' && sent.p_cashier === 'E2E Cashier', String(JSON.stringify(sent)).slice(0, 200))
  ok(`[${label}] cart is cleared`, await h.S('s.cart.length') === 0)
  ok(`[${label}] stock for A drops by exactly 1`, await h.S(`s.products.find(p => p.id === ${JSON.stringify(A.id)}).quantity`) === stockBefore - 1)
  await printCheck({ A, receiptNo: rno })
  await closeReceipt(h)
  return A
}

async function momo({ h, net, ok, label }) {
  const [A] = await pickProducts(h)
  if (!A) return ok(`[${label}] a product for MoMo`, false)
  let polls = 0
  net.script = ({ method, path, query }) => {
    if (method === 'POST' && path.endsWith('/whatsapp_orders')) return { id: 'e2e-momo-order' }
    if (method === 'GET' && path.endsWith('/whatsapp_orders') && query.includes('e2e-momo-order')) {
      polls++
      return [{ status: polls >= 2 ? 'Paid' : 'Pending' }]     // the callback lands on the 2nd poll
    }
    return undefined
  }
  const since = net.writes.length
  await h.tap(CARD, A.name)
  await openPayment(h, ok, label)
  let t = await h.tap('button', 'Direct prompt'); ok(`[${label}] choose MoMo`, t.ok, t.why)
  ok(`[${label}] type the MoMo number`, await h.type('input[placeholder="024 000 0000"]', '0244111222'))
  t = await h.tap('button', 'Pay · Send Prompt'); ok(`[${label}] send the prompt`, t.ok, t.why)
  ok(`[${label}] waits for the customer`, await h.waitFor(`document.body.innerText.includes('Prompt sent to 0244111222')`, 5000))
  const w = net.writes.slice(since)
  const order = w.find(x => x.method === 'POST' && x.path.endsWith('/whatsapp_orders'))
  ok(`[${label}] a durable order row is written first`, !!order && order.body.total === A.price && order.body.customer_phone === '0244111222')
  const charge = w.find(x => x.path.includes('/functions/') && x.query.includes('nalopay-charge'))
  ok(`[${label}] the prompt is sent for the order's amount and id`, !!charge && Number(charge.body.amount) === A.price && charge.body.orderId === 'e2e-momo-order')
  ok(`[${label}] no sale is recorded before the money arrives`, lastSale(net, since).length === 0)
  const rno = await checkReceipt(h, ok, label, A, net)
  const sales = lastSale(net, since)
  ok(`[${label}] one sale, paid by Momo, once confirmed`, sales.length === 1 && sales[0].body.p_payment === 'Momo')
  const link = net.writes.slice(since).find(x => x.method === 'PATCH' && x.path.endsWith('/whatsapp_orders') && x.body && x.body.sale_receipt_no)
  ok(`[${label}] the order is linked to the receipt`, !!link && link.body.sale_receipt_no === rno)
  net.script = null
  await closeReceipt(h)
}

async function split({ h, net, ok, label }) {
  const [A] = await pickProducts(h)
  if (!A) return ok(`[${label}] a product for split`, false)
  await h.tap(CARD, A.name)
  const qtyWanted = A.price >= 4 ? 1 : 3
  for (let i = 1; i < qtyWanted; i++) await h.tap(CARD, A.name)
  const total = await h.S('s.cart.reduce((a, c) => a + c.lineTotal, 0)')
  const cashPart = Math.floor(total / 2)
  let polls = 0
  net.script = ({ method, path, query }) => {
    if (method === 'POST' && path.endsWith('/whatsapp_orders')) return { id: 'e2e-split-order' }
    if (method === 'GET' && path.endsWith('/whatsapp_orders') && query.includes('e2e-split-order')) { polls++; return [{ status: polls >= 2 ? 'Paid' : 'Pending' }] }
    return undefined
  }
  const since = net.writes.length
  await openPayment(h, ok, label)
  let t = await h.tap('button', 'Cash + MoMo'); ok(`[${label}] choose Split`, t.ok, t.why)
  ok(`[${label}] type the cash part`, await h.type('input[placeholder="0.00"]', String(cashPart)))
  ok(`[${label}] type the MoMo number`, await h.type('input[placeholder="024 000 0000"]', '0244333444'))
  t = await h.tap('button', 'Confirm Split'); ok(`[${label}] confirm the split`, t.ok, t.why)
  await checkReceipt(h, ok, label, A, net)
  const charge = net.writes.slice(since).find(x => x.path.includes('/functions/') && x.query.includes('nalopay-charge'))
  ok(`[${label}] MoMo is charged only the remainder`, !!charge && Math.abs(Number(charge.body.amount) - (total - cashPart)) < 0.001, charge && String(charge.body.amount))
  const sale = lastSale(net, since)[0]
  ok(`[${label}] one Split sale with both amounts`, !!sale && sale.body.p_payment === 'Split' && Math.abs(sale.body.p_split_cash - cashPart) < 0.001 && Math.abs(sale.body.p_split_momo - (total - cashPart)) < 0.001, sale && JSON.stringify({ p: sale.body.p_payment, c: sale.body.p_split_cash, m: sale.body.p_split_momo }))
  net.script = null
  await closeReceipt(h)
}

async function reprint({ h, ok, label, printCheck }) {
  await h.js(`window.__POS_STORE__.getState().login({ id: 'e2e-admin', name: 'E2E Admin', role: 'Admin' }, true); window.__POS_STORE__.getState().setPage('receipts')`)
  const loaded = await h.waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'View')`, 15000)
  ok(`[${label}] transaction history lists past sales`, loaded)
  if (!loaded) return
  // The receipt number printed on the same row as the first View button.
  const rowNo = await h.js(`(() => {
    const v = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'View' && b.getClientRects().length)
    let row = v && (v.closest('tr') || v.parentElement)
    while (row && !/RCP/.test(row.innerText || '') && row.parentElement) row = row.parentElement
    return ((row && row.innerText) || '').match(/RCP[0-9A-Z-]+/)?.[0] || ''
  })()`)
  ok(`[${label}] the first row has a receipt number (${rowNo})`, !!rowNo)
  const t = await h.tap('button', 'View'); ok(`[${label}] tap View on that sale`, t.ok, t.why)
  await h.waitFor('!!document.querySelector(\'iframe[title="Receipt preview"]\')', 8000)
  const doc = await h.js(`(() => { const f = document.querySelector('iframe[title="Receipt preview"]'); return f ? f.srcdoc : '' })()`)
  ok(`[${label}] the receipt that opens is that sale's`, !!rowNo && doc.includes(rowNo))
  const shownNo = rowNo
  await printCheck({ A: { name: '', price: null }, receiptNo: shownNo })
  await closeReceipt(h)
}

async function offline({ h, net, ok, label }) {
  // The server cannot be reached when the till loads its products.
  net.script = ({ method, path }) => (method === 'GET' && path.endsWith('/products')) ? { __status: 503, body: { message: 'Service Unavailable' } } : undefined
  await h.js(`window.__POS_STORE__.getState().setPage('pos'); window.__POS_STORE__.setState({ products: [] }); window.__POS_STORE__.getState().loadAll()`)
  const shown = await h.waitFor(`!!document.querySelector('[role=alert]') && document.body.innerText.includes('Unable to connect to the server')`, 8000)
  ok(`[${label}] a failed load says so, instead of "No products found"`, shown)
  ok(`[${label}] and does not claim the shop has no products`, !(await h.js(`document.body.innerText.includes('No products found')`)))
  net.script = null
  const t = await h.tap('button', 'Try again'); ok(`[${label}] tap Try again`, t.ok, t.why)
  ok(`[${label}] products load once the server is back`, await h.waitFor(`window.__POS_STORE__.getState().products.length > 0 && !document.querySelector('[role=alert]')`, 10000))
}

module.exports = { intercept, helpers, login, scenarios: { cash, momo, split, reprint, offline }, sleep }
