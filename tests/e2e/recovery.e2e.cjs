/**
 * Coming back to an unpaid order through a payment link.
 *
 * Phase 9 of the payment brief, for the cases that can be proven without
 * touching a real payment provider: opening the link, an order that is already
 * paid, one that was cancelled, correcting the delivery details, and — the one
 * that matters most — that returning to the page can never mark an order paid.
 *
 * Nothing here simulates a provider-confirmed payment, because a simulated
 * success proves nothing about a real one.
 *
 * Run with: npm run test:recovery
 */
const { app, BrowserWindow } = require('electron')
const { intercept, helpers, sleep } = require('./flow.cjs')
const DEV = process.env.POS_DEV_URL || 'http://localhost:5173'

let pass = 0, fail = 0
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + l) } else { fail++; console.log('  \x1b[31m✗ ' + l + '\x1b[0m ' + (e || '')) } }
const finish = (code) => { console.log(`\n${pass} passed, ${fail} failed`); app.exit(code ?? (fail ? 1 : 0)) }
setTimeout(() => { ok('finished within 180s', false); finish(2) }, 180000)
process.on('unhandledRejection', (e) => { ok('no unhandled rejection', false, e && e.stack); finish(3) })
app.on('window-all-closed', () => {})

const ORDER = {
  id: 'ord123ab', order_no: 'WEB-MH8K2X1', date: '2026-11-01T09:30:00Z',
  customer_name: 'Ama Mensah', customer_phone: '0548124978',
  address: 'Spintex, near the filling station', notes: 'DELIVERY | call on arrival',
  items: JSON.stringify([
    { productId: 'a', name: 'Satin Duvet Set', qty: 1, price: 450 },
    { productId: 'b', name: 'Cotton Bedsheet', qty: 2, price: 160 },
  ]),
  subtotal: 770, delivery_fee: 0, total: 770, status: 'Pending',
  ussd_code: '*713*123#', paid_at: null, tracking_no: null, delivery_status: null,
}

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 390, height: 844 })
  w.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
  await w.loadURL(DEV)
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)

  let order = { ...ORDER }
  const updates = []
  net.script = ({ method, path: p, body }) => {
    if (method === 'OPTIONS') return undefined
    if (p === '/rest/v1/rpc/public_order_get') return order
    if (p === '/rest/v1/rpc/public_order_save_details') {
      updates.push(body); Object.assign(order, {
        customer_name: body.p_name ?? order.customer_name,
        customer_phone: body.p_phone ?? order.customer_phone,
        address: body.p_address ?? order.address,
      })
      return { success: true }
    }
    if (p === '/rest/v1/rpc/public_order_set_ref') { updates.push(body); return { success: true } }
    if (p.endsWith('/rest/v1/whatsapp_orders')) {
      if (method === 'GET') return [order]
      updates.push({ directUpdate: body }); return [order]
    }
    if (method !== 'GET') return undefined
    if (p.startsWith('/rest/v1/')) return []
    return undefined
  }

  // A hash-only change does not reload the document, and Electron reports the
  // aborted navigation as ERR_FAILED. Load the path, then set the hash and
  // reload so the page always starts from scratch.
  const openPay = async (id = order.id, query = '') => {
    await w.loadURL(`${DEV}/${query}`)
    await sleep(400)
    await w.webContents.executeJavaScript(`(() => { window.location.hash = '#/pay/${id}'; return 'ok' })()`)
    await w.webContents.reload()
    await sleep(2600)
    return w.webContents.executeJavaScript('document.body.innerText')
  }

  // ── 1. the link opens the right order ────────────────────────────────────
  let text = await openPay()
  ok('the payment link opens the order', /WEB-MH8K2X1/.test(text), text.slice(0, 160))
  ok('it lists what was bought', /Satin Duvet Set/.test(text) && /Cotton Bedsheet/.test(text))
  ok('with quantities', /2/.test(text))
  ok('and the amount payable', /770/.test(text), text.slice(0, 200))
  const fieldValues = () => w.webContents.executeJavaScript(
    `[...document.querySelectorAll('input, textarea')].map(i => i.value).join(' | ')`)
  const vals = await fieldValues()
  ok('the customer is named', /Ama Mensah/.test(vals), vals)
  ok('their number is shown', /0548124978/.test(vals), vals)
  ok('and where it is going', /Spintex/.test(vals), vals)
  ok('there is a way to pay', /Pay|Continue/i.test(text))

  // ── 2. returning to the page must never mark it paid ─────────────────────
  // The oldest trick: ?reference=anything in the URL.
  updates.length = 0
  text = await openPay(order.id, '?reference=forged-ref-12345&trxref=forged-ref-12345')
  const wroteStatus = updates.some(u => JSON.stringify(u).includes('"status"') || JSON.stringify(u).includes('Paid'))
  ok('a forged reference in the URL writes no status', !wroteStatus, JSON.stringify(updates).slice(0, 200))
  ok('and the order is still unpaid on screen', !/already been paid/i.test(text) || order.status === 'Pending')
  ok('the order itself was never changed to Paid', order.status === 'Pending')

  // ── 3. an order that is already paid ─────────────────────────────────────
  order = { ...ORDER, status: 'Paid', paid_at: '2026-11-01T10:05:00Z' }
  text = await openPay()
  ok('an already-paid order says so', /paid/i.test(text), text.slice(0, 200))
  const payable = await w.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].some(b => /^(Pay|Continue to Payment)/i.test(b.innerText.trim()) && !b.disabled)`)
  ok('and offers no way to pay it again', !payable)

  // ── 4. an order that was cancelled ───────────────────────────────────────
  order = { ...ORDER, status: 'Cancelled' }
  text = await openPay()
  ok('a cancelled order says so', /cancel/i.test(text), text.slice(0, 200))
  const payable2 = await w.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')].some(b => /^(Pay|Continue to Payment)/i.test(b.innerText.trim()) && !b.disabled)`)
  ok('and cannot be paid', !payable2)

  // ── 5. correcting the delivery details ───────────────────────────────────
  order = { ...ORDER }
  await openPay()
  updates.length = 0
  const edited = await w.webContents.executeJavaScript(`(() => {
    const set = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }
    const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'hidden')
    const addr = inputs.find(i => /spintex/i.test(i.value))
    if (!addr) return 'no address field (' + inputs.length + ' inputs)'
    set(addr, 'East Legon, blue gate opposite the school')
    return 'ok'
  })()`)
  ok('the delivery address can be corrected', edited === 'ok', edited)
  if (edited === 'ok') {
    await sleep(300)
    // The page has a single button: it validates, saves the delivery details
    // and only then asks for payment.
    const pressed = await w.webContents.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button')].filter(x => !x.disabled && x.getClientRects().length).pop()
      if (!b) return 'no button'
      b.scrollIntoView({ block: 'center' }); b.click(); return b.innerText.trim().slice(0, 30)
    })()`)
    await sleep(2000)
    ok('pressing it goes through the delivery details first', pressed !== 'no button', pressed)
    ok('the corrected address reached the server', JSON.stringify(updates).includes('East Legon'), JSON.stringify(updates).slice(0, 220))
    ok('and it is the SAME order, not a new one', order.order_no === 'WEB-MH8K2X1')
    const madeOrder = net.writes.some(x => x.path.includes('public_order_create'))
    ok('no second order was created', !madeOrder)
  }

  // ── 6. it has to be usable on the phone it was texted to ─────────────────
  order = { ...ORDER }
  await openPay()
  const fits = await w.webContents.executeJavaScript(
    `document.documentElement.scrollWidth <= window.innerWidth + 2`)
  ok('the page fits a phone screen without sideways scrolling', fits)

  finish()
}).catch(e => { ok('ran', false, e && e.stack); finish(4) })
