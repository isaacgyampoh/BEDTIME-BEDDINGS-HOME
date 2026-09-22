/**
 * Thermal receipt printing for POS terminals with a built-in printer.
 *
 * Why not just window.open() + print():
 *   - A popup is blocked or steals focus in kiosk/fullscreen, which is exactly
 *     how a till runs. A hidden iframe prints without disturbing the app.
 *   - The old code closed the print window 1s after calling print(). On slower
 *     POS hardware the job had not spooled yet, so nothing came out. We now
 *     tear down on `afterprint`, with a long fallback.
 *   - It printed before layout had settled, which produced blank or clipped
 *     receipts. We wait for the iframe to load first.
 *
 * Thermal-specific rules baked into the stylesheet below:
 *   - The head is 1-bit: it cannot print grey. Every #555/#ccc/#666 dithers
 *     into a faint speckle. Everything here is pure black, and hierarchy comes
 *     from weight and size instead.
 *   - No background washes. The old receipt drew ~8,500 characters of 16% grey
 *     watermark behind every sale: on thermal that is a dirty smudge, it makes
 *     the printer noticeably slower (far more dots to burn) and it wastes paper.
 *   - Money is tabular so the amount column lines up.
 */

import { receiptBytes, testBytes } from './escpos'
import { sendBytes, isLinked, restoreLink } from './printerLink'
import { isDesktop, printRaw as desktopPrintRaw, printSilent as desktopPrintSilent, printHtml as desktopPrintHtml } from './desktop'

const PAPER_KEY = 'pos-paper-width'   // '58' | '80'
const AUTO_KEY = 'pos-auto-print'     // 'all' | 'cash' | 'off'

/** Printable area per roll size (203dpi: 58mm→384 dots, 80mm→576 dots). */
export const PAPER = {
  '58': { roll: '58mm', width: '48mm', base: 11, name: 15, total: 14, meta: 10 },
  '80': { roll: '80mm', width: '72mm', base: 12, name: 18, total: 16, meta: 11 },
}

export function getPaperWidth() {
  try { return localStorage.getItem(PAPER_KEY) === '58' ? '58' : '80' } catch { return '80' }
}
export function setPaperWidth(w) {
  try { localStorage.setItem(PAPER_KEY, w === '58' ? '58' : '80') } catch {}
}

/** 'all' = every sale, 'cash' = cash only (the old behaviour), 'off' = never. */
export function getAutoPrint() {
  try { return localStorage.getItem(AUTO_KEY) || 'cash' } catch { return 'cash' }
}
export function setAutoPrint(mode) {
  try { localStorage.setItem(AUTO_KEY, mode) } catch {}
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const cedi = (n) => 'GHS ' + Number(n || 0).toFixed(2)

function stylesheet(p) {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; color: #000; }
    html, body { background: #fff; }
    body {
      width: ${p.width};
      margin: 0 auto;
      padding: 2mm 0 6mm;
      font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
      font-size: ${p.base}px;
      line-height: 1.35;
      -webkit-font-smoothing: none;
      font-variant-numeric: tabular-nums;
    }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .shop { font-size: ${p.name}px; font-weight: 800; line-height: 1.15; }
    .sub { font-size: ${p.meta}px; }
    .rule { border-top: 1px dashed #000; margin: 2mm 0; }
    .rule-solid { border-top: 2px solid #000; margin: 2mm 0; }
    .title { font-weight: 800; letter-spacing: 2px; margin: 2mm 0; font-size: ${p.base}px; }

    table { width: 100%; border-collapse: collapse; }
    td { vertical-align: top; padding: 0.4mm 0; font-size: ${p.meta}px; }
    td.r { text-align: right; font-weight: 700; }

    .item { margin-bottom: 1.6mm; }
    .item-name { font-weight: 700; font-size: ${p.base}px; word-break: break-word; }
    .item-line { display: flex; justify-content: space-between; font-size: ${p.meta}px; padding-left: 2mm; }

    .tot { display: flex; justify-content: space-between; font-size: ${p.meta}px; padding: 0.4mm 0; }
    .grand { display: flex; justify-content: space-between;
             font-size: ${p.total}px; font-weight: 800; padding-top: 1.5mm; }
    .foot { text-align: center; font-size: ${p.meta}px; line-height: 1.5; margin-top: 2mm; }

    /* Feed a little past the tear bar so the last line clears the cutter. */
    .feed { height: 8mm; }

    @page { size: ${p.roll} auto; margin: 0; }
    @media print {
      html, body { width: ${p.width}; }
      /* Never let the browser add its own header/footer or page breaks. */
      .item, .grand, table { break-inside: avoid; page-break-inside: avoid; }
    }
  `
}

/**
 * Render HTML on the terminal's printer.
 * Resolves true when the job was handed to the OS, false if it could not be.
 */
export function buildDocument(bodyHTML, { paper = getPaperWidth(), title = 'Receipt' } = {}) {
  const p = PAPER[paper] || PAPER['80']
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
         `<style>${stylesheet(p)}</style></head><body>${bodyHTML}<div class="feed"></div></body></html>`
}

/** Millimetre width of the printable area, for sizing an on-screen preview. */
export function paperMM(paper = getPaperWidth()) {
  return parseInt((PAPER[paper] || PAPER['80']).width, 10)
}

export function printHTML(bodyHTML, { paper = getPaperWidth(), title = 'Receipt' } = {}) {
  return new Promise((resolve) => {
    let frame
    try {
      frame = document.createElement('iframe')
      // Kept in the layout (not display:none) so the print engine lays it out,
      // but 0×0 and off-screen so nothing is visible on the cashier's screen.
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;'
      document.body.appendChild(frame)

      const doc = frame.contentWindow.document
      doc.open()
      doc.write(buildDocument(bodyHTML, { paper, title }))
      doc.close()

      let done = false
      const cleanup = () => {
        if (done) return
        done = true
        // Leave the frame alive briefly: removing it the instant print() returns
        // can cancel a job that has not finished spooling on slow hardware.
        setTimeout(() => { try { frame.remove() } catch {} }, 2000)
        resolve(true)
      }

      const fire = () => {
        try {
          frame.contentWindow.focus()
          frame.contentWindow.onafterprint = cleanup
          frame.contentWindow.print()
          // afterprint is unreliable on some Android WebViews — always have a
          // fallback so the frame is not orphaned.
          setTimeout(cleanup, 15000)
        } catch (e) {
          console.error('print failed:', e)
          try { frame.remove() } catch {}
          resolve(false)
        }
      }

      if (frame.contentWindow.document.readyState === 'complete') setTimeout(fire, 60)
      else frame.onload = () => setTimeout(fire, 60)
    } catch (e) {
      console.error('print setup failed:', e)
      try { if (frame) frame.remove() } catch {}
      resolve(false)
    }
  })
}

/** Build the receipt body for a completed sale. */
export function receiptHTML(sale, shop) {
  const items = Array.isArray(sale?.items) ? sale.items : []
  const subtotal = Number(sale.total || 0) + Number(sale.discount || 0)
  const payment = sale.payment === 'Paystack' ? 'Momo' : sale.payment

  const row = (label, value) =>
    `<tr><td>${esc(label)}</td><td class="r">${esc(value)}</td></tr>`

  return `
    <div class="c">
      <div class="shop">${esc(shop.name)}</div>
      ${shop.address ? `<div class="sub">${esc(shop.address)}</div>` : ''}
      <div class="sub">Tel: ${esc(shop.phone)}</div>
      ${shop.website ? `<div class="sub">${esc(shop.website)}</div>` : ''}
    </div>

    <div class="rule"></div>
    <div class="c title">SALES RECEIPT</div>
    <div class="rule"></div>

    <table>
      ${row('Receipt', sale.receiptNo)}
      ${row('Date', sale.dateText || '')}
      ${row('Customer', sale.customer || 'Walk-in')}
      ${row('Cashier', sale.cashier || '')}
      ${row('Payment', payment || '')}
      ${row('Type', sale.type || 'Retail')}
    </table>

    <div class="rule"></div>

    ${items.map(it => `
      <div class="item">
        <div class="item-name">${esc(it.name)}</div>
        <div class="item-line">
          <span>${esc(it.qty)} x ${cedi(it.price)}</span>
          <span class="b">${cedi(it.lineTotal != null ? it.lineTotal : Number(it.price) * Number(it.qty))}</span>
        </div>
      </div>`).join('')}

    <div class="rule"></div>

    <div class="tot"><span>Subtotal</span><span class="b">${cedi(subtotal)}</span></div>
    ${Number(sale.discount) > 0 ? `<div class="tot"><span>Discount</span><span class="b">-${cedi(sale.discount)}</span></div>` : ''}
    ${sale.payment === 'Split' && Number(sale.splitCash) > 0 ? `<div class="tot"><span>Cash</span><span class="b">${cedi(sale.splitCash)}</span></div>` : ''}
    ${sale.payment === 'Split' && Number(sale.splitMomo) > 0 ? `<div class="tot"><span>Momo</span><span class="b">${cedi(sale.splitMomo)}</span></div>` : ''}

    <div class="rule-solid"></div>
    <div class="grand"><span>TOTAL</span><span>${cedi(sale.total)}</span></div>
    <div class="rule-solid"></div>

    <div class="foot">
      <div class="b">Thank you for shopping with us!</div>
      <div>We hope to see you again soon.</div>
      ${shop.website ? `<div>${esc(shop.website)}</div>` : ''}
      <div>Goods sold are not returnable.</div>
    </div>
  `
}

/** A one-page alignment/darkness check for setting a terminal up. */
export function testPageHTML(paper) {
  const p = PAPER[paper] || PAPER['80']
  return `
    <div class="c"><div class="shop">PRINTER TEST</div>
    <div class="sub">${p.roll} roll &middot; ${p.width} printable</div></div>
    <div class="rule"></div>
    <div class="item"><div class="item-name">Alignment — the bar below should
    reach both edges without wrapping.</div></div>
    <div class="rule-solid"></div>
    <div class="tot"><span>Narrow item</span><span class="b">${cedi(1)}</span></div>
    <div class="tot"><span>A much longer product name here</span><span class="b">${cedi(1234.56)}</span></div>
    <div class="rule"></div>
    <div class="grand"><span>TOTAL</span><span>${cedi(1235.56)}</span></div>
    <div class="rule-solid"></div>
    <div class="foot">
      <div class="b">If the amounts above are cut off, switch paper width.</div>
      <div>1234567890 &middot; ABCDEFGHIJKLM</div>
    </div>`
}

/**
 * Print a COMPLETE html document that brings its own styles (the stock-count
 * sheet and the picking slip do). Same iframe machinery as printHTML — the
 * point is to stop using window.open(), which a kiosk blocks — but the
 * document's own stylesheet is left alone apart from retargeting the paper
 * size to whatever this terminal is set to.
 */
/**
 * Print a full HTML document — delivery label, stock count sheet.
 *
 * Desktop app: laid out and sent to the head as a raster image, because the
 * head is not a Windows printer and window.print() there offers only OneNote
 * and PDF. Browser: the OS print dialog, as before.
 *
 * Resolves true/false for existing callers; `lastPrintError()` says why.
 */
let _lastPrintError = null
export const lastPrintError = () => _lastPrintError

export async function printDocument(fullHTML, opts = {}) {
  _lastPrintError = null
  if (isDesktop()) {
    const paper = opts.paper || getPaperWidth()
    const r = await desktopPrintHtml(retarget(fullHTML, { ...opts, paper }), { paper })
    if (r?.ok) return true
    _lastPrintError = r?.error || 'Printer unavailable. Check the printer connection and try again.'
    return false
  }
  const ok = await printDocumentInBrowser(fullHTML, opts)
  if (!ok) _lastPrintError = 'Could not open the print dialog.'
  return ok
}

/** Fit a document written for 80mm to the roll actually loaded. */
function retarget(fullHTML, { paper = getPaperWidth(), title = 'Print' } = {}) {
  const p = PAPER[paper] || PAPER['80']
  return fullHTML
    .replace(/@page\s*\{[^}]*\}/g, `@page { size: ${p.roll} auto; margin: 0; }`)
    .replace(/width:\s*72mm/g, `width: ${p.width}`)
    .replace(/width:\s*80mm/g, `width: ${p.width}`)
    .replace(/<script>[\s\S]*?window\.print\(\)[\s\S]*?<\/script>/g, '')
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${String(title).replace(/[<>]/g, '')}</title>`)
}

function printDocumentInBrowser(fullHTML, { paper = getPaperWidth(), title = 'Print' } = {}) {
  const html = retarget(fullHTML, { paper, title })

  return new Promise((resolve) => {
    let frame
    try {
      frame = document.createElement('iframe')
      frame.setAttribute('aria-hidden', 'true')
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;'
      document.body.appendChild(frame)
      const doc = frame.contentWindow.document
      doc.open(); doc.write(html); doc.close()

      let done = false
      const cleanup = () => {
        if (done) return
        done = true
        setTimeout(() => { try { frame.remove() } catch {} }, 2000)
        resolve(true)
      }
      const fire = () => {
        try {
          frame.contentWindow.focus()
          frame.contentWindow.onafterprint = cleanup
          frame.contentWindow.print()
          setTimeout(cleanup, 15000)
        } catch (e) {
          console.error('print failed:', e)
          try { frame.remove() } catch {}
          resolve(false)
        }
      }
      if (frame.contentWindow.document.readyState === 'complete') setTimeout(fire, 120)
      else frame.onload = () => setTimeout(fire, 120)
    } catch (e) {
      console.error('print setup failed:', e)
      try { if (frame) frame.remove() } catch {}
      resolve(false)
    }
  })
}

// ── high level: direct link first, browser print second ─────────────────────

/**
 * Print a sale.
 *
 * Order matters. If the terminal has been paired with its built-in head we send
 * ESC/POS straight to it: no driver, no queue, no print dialog. Only if that is
 * unavailable do we fall back to window-style printing, which needs the printer
 * to exist as an OS printer — and on this till it does not.
 *
 * Returns { ok, via } so the caller can tell the operator what actually happened.
 */
export async function printReceipt(sale, shop, { paper = getPaperWidth() } = {}) {
  return printVia(
    () => receiptBytes(sale, shop, paper),
    () => buildDocument(receiptHTML(sale, shop), { paper }),
    () => printHTML(receiptHTML(sale, shop), { paper, title: `Receipt ${sale.receiptNo || ''}` }),
    paper,
  )
}

/**
 * The one routing decision for every printout. Same receipt data in, one of
 * three transports out:
 *
 *   desktop app  → ESC/POS over the COM port, else a named real Windows queue.
 *                  Never the browser fallbacks: Web Serial is not wired in the
 *                  desktop shell, and window.print() there opens a dialog
 *                  offering OneNote and PDF — a print that is not a print.
 *   browser      → the Web Serial / WebUSB link the operator paired, else the
 *                  OS print dialog.
 *
 * Always resolves { ok, via, error }. `error` is written for the person at the
 * till; the technical detail goes to the console.
 */
async function printVia(bytesFn, docFn, htmlFn, paper) {
  if (isDesktop()) {
    const raw = await desktopPrintRaw(bytesFn())
    if (raw.ok) return { ok: true, via: 'desktop-serial', error: null }
    const q = await desktopPrintSilent(docFn(), { widthMicrons: paperMM(paper) * 1000 })
    if (q.ok) return { ok: true, via: 'desktop-printer', error: null }
    return {
      ok: false, via: 'desktop', needsSetup: !!raw.needsSetup,
      error: raw.error || 'Printer unavailable. Check the printer connection and try again.',
    }
  }

  if (isLinked() || await restoreLink()) {
    const ok = await sendBytes(bytesFn())
    if (ok) return { ok: true, via: 'direct', error: null }
  }
  const ok = await htmlFn()
  return { ok, via: 'browser', error: ok ? null : 'Could not open the print dialog.' }
}

/** Alignment/darkness check, over whichever transport is available. */
export async function printTestPage({ paper = getPaperWidth() } = {}) {
  return printVia(
    () => testBytes(paper),
    () => buildDocument(testPageHTML(paper), { paper }),
    () => printHTML(testPageHTML(paper), { paper, title: 'Printer test' }),
    paper,
  )
}
