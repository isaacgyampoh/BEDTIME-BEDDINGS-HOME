/**
 * One cashier flow, run in both runtimes (tests/e2e/pos.e2e.cjs):
 *   log in → open POS → products load → tap product A → tap product B → tap A
 *   again → open cart → decrease A → remove B → Complete Sale → Cash → phone →
 *   tap "Confirm Cash Payment" TWICE in the same instant → receipt → print.
 *
 * Every database write is intercepted at the network layer (CDP Fetch), so the
 * flow never touches live data: record_sale is answered the way the server
 * answers it, and what the app sent is recorded and checked. Reads go to the
 * real project, so products and stock are real.
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function interceptWrites(dbg, writes) {
  let n = 0
  await dbg.sendCommand('Fetch.enable', { patterns: [{ urlPattern: '*supabase.co/*', requestStage: 'Request' }] })
  dbg.on('message', async (_e, method, p) => {
    if (method !== 'Fetch.requestPaused') return
    const { requestId, request } = p
    const m = request.method
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || /\/realtime\//.test(request.url)) {
      return dbg.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {})
    }
    const path = request.url.replace(/^https:\/\/[^/]+/, '').split('?')[0]
    let body = null; try { body = JSON.parse(request.postData || 'null') } catch { body = request.postData }
    writes.push({ method: m, path, body, at: Date.now() })
    let reply = {}
    if (path.endsWith('/rpc/record_sale')) {
      n++
      const items = Array.isArray(body?.p_items) ? body.p_items : []
      const total = items.reduce((a, c) => a + Number(c.price) * Number(c.qty), 0) - Number(body?.p_discount || 0)
      reply = { success: true, receiptNo: `RCP-E2E-${String(n).padStart(3, '0')}`, saleId: `e2e-${n}`, subtotal: total, discount: 0, total, profit: 0, date: new Date().toISOString() }
      await sleep(400)   // a real round trip, so a second tap has time to land
    } else if (/\/rpc\//.test(path)) {
      reply = null
    }
    dbg.sendCommand('Fetch.fulfillRequest', {
      requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
      body: Buffer.from(JSON.stringify(reply)).toString('base64'),
    }).catch(() => {})
  })
}

async function runFlow({ w, dbg, ok, onPrintCheck, label }) {
  const js = (s) => w.webContents.executeJavaScript(s)
  const click = async (x, y) => {
    w.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    w.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }
  // Find a visible element by selector + text, scroll it into view, return its centre.
  const locate = (sel, text, idx = 0) => js(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && ${text ? `(e.innerText || '').includes(${JSON.stringify(text)})` : 'true'})
    const e = els[${idx}]; if (!e) return null
    e.scrollIntoView({ block: 'center' })
    const r = e.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, blocked: !e.contains(hit), by: hit && (hit.className || hit.tagName).toString().slice(0, 60) }
  })()`)
  const tap = async (sel, text, idx) => {
    const p = await locate(sel, text, idx)
    if (!p) return { ok: false, why: 'not found' }
    if (p.blocked) return { ok: false, why: 'covered by ' + p.by }
    await click(p.x, p.y); await sleep(350)
    return { ok: true }
  }
  const S = (expr) => js(`(() => { const s = window.__POS_STORE__.getState(); return ${expr} })()`)

  // 1. log in and open the POS
  await js(`(async () => { for (let i = 0; i < 80 && !window.__POS_STORE__; i++) await new Promise(r => setTimeout(r, 100)) })()`)
  ok(`[${label}] app booted`, await js('!!window.__POS_STORE__'))
  await js(`window.__POS_STORE__.getState().login({ id: 'e2e', name: 'E2E Cashier', role: 'Cashier' }, false); window.__POS_STORE__.getState().setPage('pos')`)
  for (let i = 0; i < 60 && !(await S('s.products.length > 0 && !s.loading')); i++) await sleep(250)
  const nProducts = await S('s.products.length')
  ok(`[${label}] products load (${nProducts})`, nProducts > 0)

  // Wait for the grid itself, not just the data behind it.
  for (let i = 0; i < 40 && !(await js("document.querySelectorAll('button.bg-white.overflow-hidden').length > 10")); i++) await sleep(250)
  // Two in-stock products with a known name, found in the rendered grid.
  const pick = JSON.parse(await js(`(() => {
    const s = window.__POS_STORE__.getState()
    const shown = new Set([...document.querySelectorAll('button')].map(b => (b.innerText || '').split('\\n')[0].trim()))
    const ok = s.products.filter(p => p.quantity >= 3 && p.price > 0 && shown.has(p.name) && s.products.filter(q => q.name === p.name).length === 1)
    return JSON.stringify(ok.slice(0, 2).map(p => ({ id: p.id, name: p.name, stock: p.quantity, price: p.price })))
  })()`))
  ok(`[${label}] two sellable products on screen`, pick.length === 2, JSON.stringify(pick))
  if (pick.length < 2) return
  const [A, B] = pick
  const card = 'button.bg-white.overflow-hidden'

  // 2. select products
  let t = await tap(card, A.name); ok(`[${label}] tap product A`, t.ok, t.why)
  ok(`[${label}] A is in the cart`, await S(`s.cart.some(c => c.productId === ${JSON.stringify(A.id)} && c.qty === 1)`))
  t = await tap(card, B.name); ok(`[${label}] tap product B`, t.ok, t.why)
  t = await tap(card, A.name)
  ok(`[${label}] tapping A again makes it qty 2`, await S(`(s.cart.find(c => c.productId === ${JSON.stringify(A.id)}) || {}).qty === 2`))
  ok(`[${label}] cart has 2 lines`, await S('s.cart.length') === 2)

  // 3. the cart drawer: decrease A, remove B
  t = await tap('button[class*="bottom-[calc(90px"]'); ok(`[${label}] open the cart`, t.ok, t.why)
  await sleep(400)
  const aIndex = await S(`s.cart.findIndex(c => c.productId === ${JSON.stringify(A.id)})`)
  const bIndex = await S(`s.cart.findIndex(c => c.productId === ${JSON.stringify(B.id)})`)
  t = await tap('button[aria-label="Decrease quantity"]', null, aIndex); ok(`[${label}] tap decrease on A`, t.ok, t.why)
  ok(`[${label}] A back to qty 1`, await S(`(s.cart.find(c => c.productId === ${JSON.stringify(A.id)}) || {}).qty === 1`))
  t = await tap('button[aria-label="Remove item"]', null, bIndex); ok(`[${label}] tap remove on B`, t.ok, t.why)
  ok(`[${label}] B removed, A left`, await S(`s.cart.length === 1 && s.cart[0].productId === ${JSON.stringify(A.id)}`))

  // 4. pay cash
  t = await tap('button', 'Complete Sale'); ok(`[${label}] open payment`, t.ok, t.why)
  t = await tap('button', 'At counter'); ok(`[${label}] choose Cash`, t.ok, t.why)
  const phone = await locate('input[placeholder="024 000 0000"]')
  ok(`[${label}] phone field is there`, !!phone && !phone.blocked, JSON.stringify(phone))
  if (phone) { await click(phone.x, phone.y); await sleep(150); await dbg.sendCommand('Input.insertText', { text: '0244000000' }); await sleep(300) }

  const stockBefore = await S(`s.products.find(p => p.id === ${JSON.stringify(A.id)}).quantity`)
  const confirm = await locate('button', 'Confirm Cash Payment')
  ok(`[${label}] Confirm Cash Payment is tappable`, !!confirm && !confirm.blocked, JSON.stringify(confirm))
  const writesBefore = (global.__writes || []).length
  // The double tap: two full clicks in the same instant, before any re-render.
  if (confirm) { await click(confirm.x, confirm.y); await click(confirm.x, confirm.y) }
  for (let i = 0; i < 40 && !(await js('!!document.querySelector(\'iframe[title="Receipt preview"]\')')); i++) await sleep(200)

  const sales = (global.__writes || []).slice(writesBefore).filter(x => x.path.endsWith('/rpc/record_sale'))
  ok(`[${label}] a double tap records the sale ONCE (got ${sales.length})`, sales.length === 1)
  const sent = sales[0] && sales[0].body
  ok(`[${label}] the sale sent is A x1, Cash, with the phone`, !!sent && sent.p_items.length === 1 && sent.p_items[0].productId === A.id && sent.p_items[0].qty === 1 && sent.p_payment === 'Cash' && sent.p_customer === '0244000000', String(JSON.stringify(sent)).slice(0, 200))
  ok(`[${label}] the cashier is on the sale`, sent && sent.p_cashier === 'E2E Cashier')

  // 5. after the sale
  ok(`[${label}] cart is cleared`, await S('s.cart.length') === 0)
  ok(`[${label}] stock shown for A drops by 1`, await S(`s.products.find(p => p.id === ${JSON.stringify(A.id)}).quantity`) === stockBefore - 1)
  const receipt = await js(`(() => { const f = document.querySelector('iframe[title="Receipt preview"]'); return f ? f.srcdoc : '' })()`)
  ok(`[${label}] receipt shows the receipt number`, receipt.includes('RCP-E2E-001'))
  ok(`[${label}] receipt lists the product`, receipt.includes(A.name.replace(/&/g, '&amp;')) || receipt.includes(A.name))
  ok(`[${label}] receipt shows the total`, receipt.includes(Number(A.price).toFixed(2)))
  ok(`[${label}] receipt shows the cashier`, receipt.includes('E2E Cashier'))

  // 6. print it
  await onPrintCheck({ tap, js, sleep, ok, A, label })
}

module.exports = { interceptWrites, runFlow, sleep }
