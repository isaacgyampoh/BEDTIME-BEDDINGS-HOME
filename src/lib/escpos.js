/**
 * Direct ESC/POS printing, bypassing the Windows print system entirely.
 *
 * Why this exists: on this terminal Chrome's print dialog offers only OneNote,
 * Fax and Save as PDF. The built-in thermal head is not a Windows printer, so
 * window.print() has nothing to print to. These OEM tills usually wire the head
 * to an internal USB/serial bridge that Windows leaves as a raw device until a
 * vendor driver is installed.
 *
 * ESC/POS is the command language those heads actually speak. Talking to them
 * directly means no driver, no print queue, and no print dialog — which is how
 * real POS software drives a built-in printer.
 *
 * Two transports, because these machines differ:
 *   Web Serial — the head is a COM port (most common on OEM tills)
 *   WebUSB     — the head is a raw USB device (works only while no Windows
 *                driver has claimed it, which is exactly this machine's state)
 */

// ── ESC/POS commands ────────────────────────────────────────────────────────
const ESC = 0x1b, GS = 0x1d
export const CMD = {
  init:        [ESC, 0x40],
  alignLeft:   [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  alignRight:  [ESC, 0x61, 2],
  boldOn:      [ESC, 0x45, 1],
  boldOff:     [ESC, 0x45, 0],
  // GS ! n — high nibble = width multiplier-1, low nibble = height multiplier-1
  sizeNormal:  [GS, 0x21, 0x00],
  sizeDouble:  [GS, 0x21, 0x11],
  sizeTall:    [GS, 0x21, 0x01],
  underlineOn: [ESC, 0x2d, 1],
  underlineOff:[ESC, 0x2d, 0],
  // CP437, the safest default across cheap clones
  codepage437: [ESC, 0x74, 0x00],
  feed:        (n) => [ESC, 0x64, Math.max(0, Math.min(255, n))],
  cut:         [GS, 0x56, 66, 0x00],   // partial cut after feeding
  drawerKick:  [ESC, 0x70, 0x00, 0x19, 0xfa],
}

/** Characters per line in Font A (12 dots wide): 58mm→32, 80mm→48. */
export const COLS = { '58': 32, '80': 48 }

/**
 * A thermal head has no font fallback — anything outside its codepage prints as
 * garbage. Fold the typography the app uses into plain ASCII.
 */
export function toAscii(s) {
  return String(s ?? '')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/\u00a0/g, ' ')   // non-breaking space -> plain space
    .replace(/[^\x20-\x7e\n]/g, '')
}

// ── text layout ─────────────────────────────────────────────────────────────
export function center(text, cols) {
  const t = toAscii(text).slice(0, cols)
  const pad = Math.max(0, Math.floor((cols - t.length) / 2))
  return ' '.repeat(pad) + t
}

/** "Item                 GHS 10.00" — right column flush to the paper edge. */
export function columns(left, right, cols) {
  const l = toAscii(left), r = toAscii(right)
  if (l.length + r.length + 1 <= cols) {
    return l + ' '.repeat(cols - l.length - r.length) + r
  }
  // Not enough room: wrap the label and put the amount on its own line.
  const wrapped = wrap(l, cols)
  return wrapped + '\n' + ' '.repeat(Math.max(0, cols - r.length)) + r
}

export function wrap(text, cols) {
  const words = toAscii(text).split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  for (const w of words) {
    if (!cur.length) { cur = w.slice(0, cols) ; continue }
    if (cur.length + 1 + w.length <= cols) cur += ' ' + w
    else { lines.push(cur); cur = w.slice(0, cols) }
  }
  if (cur) lines.push(cur)
  return lines.join('\n')
}

export const rule = (cols, ch = '-') => ch.repeat(cols)

// ── byte assembly ───────────────────────────────────────────────────────────
class Builder {
  constructor() { this.parts = [] }
  raw(bytes) { this.parts.push(Uint8Array.from(bytes)); return this }
  text(s) {
    const clean = toAscii(s)
    const out = new Uint8Array(clean.length)
    for (let i = 0; i < clean.length; i++) out[i] = clean.charCodeAt(i) & 0xff
    this.parts.push(out)
    return this
  }
  line(s = '') { return this.text(s + '\n') }
  build() {
    const total = this.parts.reduce((n, p) => n + p.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const p of this.parts) { out.set(p, o); o += p.length }
    return out
  }
}

const money = (n) => 'GHS ' + Number(n || 0).toFixed(2)

/** Render a sale as ESC/POS bytes. */
export function receiptBytes(sale, shop, paper = '80', { cut = true } = {}) {
  const cols = COLS[paper] || COLS['80']
  const b = new Builder()
  const items = Array.isArray(sale?.items) ? sale.items : []
  const subtotal = Number(sale.total || 0) + Number(sale.discount || 0)
  const payment = sale.payment === 'Paystack' ? 'Momo' : sale.payment

  b.raw(CMD.init).raw(CMD.codepage437)

  b.raw(CMD.alignCenter).raw(CMD.boldOn).raw(CMD.sizeTall)
  b.line(shop.name)
  b.raw(CMD.sizeNormal).raw(CMD.boldOff)
  if (shop.address) b.line(wrap(shop.address, cols))
  b.line('Tel: ' + shop.phone)
  if (shop.website) b.line(shop.website)

  b.line(rule(cols, '='))
  b.raw(CMD.boldOn).line('SALES RECEIPT').raw(CMD.boldOff)
  b.line(rule(cols, '='))

  b.raw(CMD.alignLeft)
  b.line(columns('Receipt:', sale.receiptNo || '', cols))
  b.line(columns('Date:', sale.dateText || '', cols))
  b.line(columns('Customer:', sale.customer || 'Walk-in', cols))
  b.line(columns('Cashier:', sale.cashier || '', cols))
  b.line(columns('Payment:', payment || '', cols))
  b.line(columns('Type:', sale.type || 'Retail', cols))
  b.line(rule(cols))

  for (const it of items) {
    const lineTotal = it.lineTotal != null ? it.lineTotal : Number(it.price) * Number(it.qty)
    b.raw(CMD.boldOn).line(wrap(it.name, cols)).raw(CMD.boldOff)
    b.line(columns(`  ${it.qty} x ${money(it.price)}`, money(lineTotal), cols))
  }

  b.line(rule(cols))
  b.line(columns('Subtotal', money(subtotal), cols))
  if (Number(sale.discount) > 0) b.line(columns('Discount', '-' + money(sale.discount), cols))
  if (sale.payment === 'Split' && Number(sale.splitCash) > 0) b.line(columns('Cash', money(sale.splitCash), cols))
  if (sale.payment === 'Split' && Number(sale.splitMomo) > 0) b.line(columns('Momo', money(sale.splitMomo), cols))
  b.line(rule(cols, '='))

  b.raw(CMD.boldOn).raw(CMD.sizeTall)
  b.line(columns('TOTAL', money(sale.total), Math.floor(cols)))
  b.raw(CMD.sizeNormal).raw(CMD.boldOff)
  b.line(rule(cols, '='))

  b.raw(CMD.alignCenter)
  b.raw(CMD.boldOn).line('Thank you for shopping with us!').raw(CMD.boldOff)
  b.line('We hope to see you again soon.')
  if (shop.website) b.line(shop.website)
  b.line('Goods sold are not returnable.')

  b.raw(CMD.feed(4))
  if (cut) b.raw(CMD.cut)
  return b.build()
}

/** Alignment/darkness check for setting a terminal up. */
export function testBytes(paper = '80') {
  const cols = COLS[paper] || COLS['80']
  const b = new Builder()
  b.raw(CMD.init).raw(CMD.codepage437)
  b.raw(CMD.alignCenter).raw(CMD.boldOn).raw(CMD.sizeTall).line('PRINTER TEST')
  b.raw(CMD.sizeNormal).raw(CMD.boldOff)
  b.line(`${paper}mm - ${cols} characters wide`)
  b.raw(CMD.alignLeft).line(rule(cols, '='))
  b.line('1234567890'.repeat(Math.ceil(cols / 10)).slice(0, cols))
  b.line(rule(cols))
  b.line(columns('Short item', money(1), cols))
  b.line(columns('A much longer product name to test wrapping behaviour', money(1234.56), cols))
  b.line(rule(cols, '='))
  b.raw(CMD.boldOn).line(columns('TOTAL', money(1235.56), cols)).raw(CMD.boldOff)
  b.line(rule(cols, '='))
  b.raw(CMD.alignCenter)
  b.line('The row of digits above should')
  b.line('exactly fill the paper width.')
  b.raw(CMD.feed(4)).raw(CMD.cut)
  return b.build()
}
