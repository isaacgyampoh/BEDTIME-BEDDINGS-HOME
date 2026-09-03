import { PAPER, getPaperWidth } from './printer'

/**
 * Delivery label / packing sticker.
 *
 * Built for a thermal head, not a screen:
 *   - pure black only. The head is 1-bit, so grey dithers into faint speckle
 *     and small grey labels effectively vanish.
 *   - no solid fill blocks. A black banner across 80mm is a very large burn
 *     area: slow to print, hard on the head, and prone to streaking.
 *   - a REAL Code 128 barcode, rendered as bars from the encoded pattern. The
 *     previous label drew `'|'.repeat(40)`, which is forty identical pipes and
 *     scans as nothing at all.
 *   - the QR is embedded as a data URI fetched BEFORE printing, so the label
 *     never depends on a network call at print time.
 */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const cedi = (n) => 'GHS ' + Number(n || 0).toFixed(2)

// ── Code 128 ────────────────────────────────────────────────────────────────
// Widths of the 6 elements (bar,space,bar,space,bar,space) for each symbol.
const C128 = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
]

/**
 * Encode text as Code 128 Set B and return the run-length widths of alternating
 * bars and spaces, starting with a bar.
 */
export function code128Widths(text) {
  const s = String(text || '').replace(/[^\x20-\x7E]/g, '')
  if (!s) return []
  const START_B = 104, STOP = 106
  const codes = [START_B]
  for (const ch of s) codes.push(ch.charCodeAt(0) - 32)

  let sum = START_B
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i
  codes.push(sum % 103)          // checksum
  codes.push(STOP)

  const widths = []
  for (const c of codes) for (const d of C128[c]) widths.push(parseInt(d, 10))
  return widths
}

/** Render those widths as an inline SVG. No external library, no network. */
export function barcodeSVG(text, { width = 60, height = 12, unit = 0.34 } = {}) {
  const widths = code128Widths(text)
  if (!widths.length) return ''
  const total = widths.reduce((a, b) => a + b, 0) * unit
  let x = 0
  let bars = ''
  widths.forEach((w, i) => {
    const w2 = w * unit
    if (i % 2 === 0) bars += `<rect x="${x.toFixed(2)}" y="0" width="${w2.toFixed(2)}" height="${height}" fill="#000"/>`
    x += w2
  })
  return `<svg viewBox="0 0 ${total.toFixed(2)} ${height}" width="${width}mm" height="${height}mm" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`
}

/**
 * Fetch the QR as a data URI so printing never waits on the network.
 * Returns '' on any failure, and the caller falls back to printing the URL.
 */
export async function qrDataUri(text, size = 260) {
  try {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=0&data=${encodeURIComponent(text)}`
    const res = await fetch(url)
    if (!res.ok) return ''
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result || ''))
      fr.onerror = () => resolve('')
      fr.readAsDataURL(blob)
    })
  } catch { return '' }
}

/**
 * @param order  the whatsapp_orders row (camelCase, as the store maps it)
 * @param opts   { qr, deliverUrl, paper, shop }
 */
export function deliveryLabelHTML(order, { qr = '', deliverUrl = '', paper = getPaperWidth(), shop } = {}) {
  const p = PAPER[paper] || PAPER['80']
  const narrow = paper === '58'

  const track = order.trackingNo || order.orderNo || ''
  const items = Array.isArray(order.items) ? order.items : []
  const paid = order.status === 'Paid' || order.status === 'Completed' || !!order.paidAt
  const date = order.date
    ? new Date(order.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : ''

  // Everything a rider needs, stated once and unmistakably.
  const money = paid
    ? `<div class="pay paid"><div class="pay-k">PAID IN FULL</div><div class="pay-v">${cedi(order.total)}</div><div class="pay-n">Do not collect payment</div></div>`
    : `<div class="pay due"><div class="pay-k">COLLECT ON DELIVERY</div><div class="pay-v">${cedi(order.total)}</div><div class="pay-n">Collect this amount before handover</div></div>`

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(track)}</title><style>
  * { margin:0; padding:0; box-sizing:border-box; color:#000; }
  html, body { background:#fff; }
  body { width:${p.width}; font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
         font-variant-numeric:tabular-nums; -webkit-font-smoothing:none; padding:0 0 6mm; }

  .rule       { border-top:1px solid #000; margin:2mm 0; }
  .rule-heavy { border-top:2px solid #000; margin:2mm 0; }
  .dash       { border-top:1px dashed #000; margin:2mm 0; }
  .c { text-align:center; }
  .k { font-size:${narrow ? 6 : 7}px; font-weight:700; letter-spacing:2px; text-transform:uppercase; }

  .shop  { font-size:${narrow ? 12 : 15}px; font-weight:800; letter-spacing:1px; }
  .shop-sub { font-size:${narrow ? 7 : 8}px; font-weight:600; margin-top:0.5mm; }

  .track { font-size:${narrow ? 15 : 19}px; font-weight:800; font-family:'Courier New',monospace;
           letter-spacing:2px; margin-top:1mm; }
  .bc { margin:1.5mm 0 0.5mm; }

  .to-name  { font-size:${narrow ? 15 : 19}px; font-weight:800; line-height:1.15; }
  .to-phone { font-size:${narrow ? 13 : 16}px; font-weight:800; margin-top:1mm; }
  .to-addr  { font-size:${narrow ? 10 : 11}px; font-weight:600; line-height:1.45;
              margin-top:1.5mm; padding:2mm; border:1.5px solid #000; }

  .pay     { border:2px solid #000; padding:2mm; text-align:center; margin:2mm 0; }
  .pay-k   { font-size:${narrow ? 8 : 9}px; font-weight:800; letter-spacing:2px; }
  .pay-v   { font-size:${narrow ? 16 : 20}px; font-weight:800; margin-top:0.5mm; }
  .pay-n   { font-size:${narrow ? 7 : 8}px; font-weight:600; margin-top:0.5mm; }
  .due .pay-v { text-decoration:underline; }

  .it   { display:flex; justify-content:space-between; gap:2mm; font-size:${narrow ? 9 : 10}px; padding:0.6mm 0; }
  .it-q { font-weight:800; min-width:7mm; }
  .it-n { flex:1; font-weight:600; word-break:break-word; }

  .qr-row { display:flex; gap:2.5mm; align-items:center; margin-top:1mm; }
  .qr-row img { width:${narrow ? 20 : 24}mm; height:${narrow ? 20 : 24}mm; border:1px solid #000; }
  .qr-t  { font-size:${narrow ? 7 : 8}px; font-weight:800; text-transform:uppercase; letter-spacing:1px; }
  .qr-d  { font-size:${narrow ? 6.5 : 7}px; font-weight:600; line-height:1.4; margin-top:0.5mm; }
  .qr-u  { font-size:${narrow ? 6 : 6.5}px; font-weight:600; word-break:break-all; margin-top:1mm; }

  .foot { font-size:${narrow ? 7 : 8}px; font-weight:700; letter-spacing:1px; }
  .feed { height:8mm; }

  @page { size:${p.roll} auto; margin:0; }
  @media print { html, body { width:${p.width}; } .pay, .qr-row, .it { break-inside:avoid; } }
</style></head><body>

  <div class="c">
    <div class="shop">${esc(shop?.name || 'BEDTIME BEDDINGS & HOME')}</div>
    <div class="shop-sub">${esc(shop?.phone || '')}</div>
  </div>

  <div class="rule-heavy"></div>

  <div class="c">
    <div class="k">Tracking Number</div>
    <div class="track">${esc(track)}</div>
    ${barcodeSVG(track, { width: narrow ? 42 : 62, height: narrow ? 10 : 12 })
      ? `<div class="bc">${barcodeSVG(track, { width: narrow ? 42 : 62, height: narrow ? 10 : 12 })}</div>` : ''}
  </div>

  <div class="rule-heavy"></div>

  <div class="k">Deliver to</div>
  <div class="to-name">${esc((order.customerName || 'CUSTOMER').toUpperCase())}</div>
  <div class="to-phone">${esc(order.customerPhone || '')}</div>
  ${order.address ? `<div class="to-addr">${esc(order.address)}</div>` : ''}

  ${money}

  ${items.length ? `
  <div class="dash"></div>
  <div class="k">Contents — ${items.reduce((a, i) => a + (Number(i.qty) || 0), 0)} item(s)</div>
  ${items.map(i => `<div class="it"><span class="it-q">${esc(i.qty)}x</span><span class="it-n">${esc(i.name)}</span></div>`).join('')}
  ` : ''}

  <div class="dash"></div>

  <div class="qr-row">
    ${qr ? `<img src="${qr}" alt="" />` : ''}
    <div>
      <div class="qr-t">Confirm delivery</div>
      <div class="qr-d">${qr
        ? 'Scan at the door to mark this order delivered.'
        : 'Open this link at the door to mark this order delivered.'}</div>
      ${deliverUrl ? `<div class="qr-u">${esc(deliverUrl)}</div>` : ''}
    </div>
  </div>

  <div class="rule"></div>
  <div class="c foot">HANDLE WITH CARE &middot; ${esc(order.orderNo || '')}${date ? ' &middot; ' + esc(date) : ''}</div>
  <div class="feed"></div>
</body></html>`
}
