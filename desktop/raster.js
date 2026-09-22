/**
 * Print any HTML document on the till's thermal head, as a raster image.
 *
 * Receipts go out as ESC/POS text, which is fast and sharp. Delivery labels and
 * stock sheets cannot: they carry a Code 128 barcode (SVG) and a QR code
 * (image), and ESC/POS text has no way to say either. In the browser those
 * documents went through window.print(); in the desktop app that opens a
 * Windows dialog whose only printers are OneNote and Print to PDF, because the
 * head built into the till is not a Windows printer at all.
 *
 * So the desktop app lays the page out itself, in an offscreen window exactly
 * the width of the paper in printer dots, captures it, reduces it to black and
 * white, and sends it with GS v 0 — the raster command every ESC/POS head
 * understands. What prints is what the page looks like, barcode included.
 *
 * Must stay listed in package.json "build.files" (an allowlist).
 */

// Printable width in dots at 203 dpi (8 dots/mm), the resolution these heads use.
const DOTS = { '58': 384, '80': 576 }
const PRINTABLE_MM = { '58': 48, '80': 72 }
// Most heads cap one raster command's height; 256 rows is safely under all.
const BAND = 256

/**
 * BGRA pixels → ESC/POS raster bytes. Pure, so it is tested without a window.
 * A pixel prints (bit set) when it is dark enough; transparent counts as paper.
 */
function encodeRaster(bgra, width, height, { threshold = 160, cut = true } = {}) {
  const rowBytes = Math.ceil(width / 8)
  const bits = Buffer.alloc(rowBytes * height)
  let lastInk = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = bgra[i + 3]
      if (a < 128) continue
      // Rec. 601 luma from B, G, R
      const lum = 0.114 * bgra[i] + 0.587 * bgra[i + 1] + 0.299 * bgra[i + 2]
      if (lum < threshold) {
        bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
        lastInk = y
      }
    }
  }
  // Paper costs money: stop a few rows after the last ink, not at the window's
  // bottom edge.
  const rows = Math.min(height, lastInk + 1 + 8)
  const out = [Buffer.from([0x1b, 0x40])]   // ESC @ — a clean state for the job
  for (let y0 = 0; y0 < rows; y0 += BAND) {
    const h = Math.min(BAND, rows - y0)
    out.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, h & 0xff, h >> 8]))
    out.push(bits.subarray(y0 * rowBytes, (y0 + h) * rowBytes))
  }
  out.push(Buffer.from([0x1b, 0x64, 4]))    // feed clear of the cutter
  if (cut) out.push(Buffer.from([0x1d, 0x56, 66, 0x00]))
  return { bytes: Buffer.concat(out), rows, rowBytes }
}

/** Lay the HTML out at the paper's width in dots and return its pixels. */
async function renderHtml(html, paper = '80') {
  const { BrowserWindow } = require('electron')
  const dots = DOTS[paper] || DOTS['80']
  const mm = PRINTABLE_MM[paper] || PRINTABLE_MM['80']
  // CSS lays out at 96 px/inch; the head prints at 203. Zoom so the printable
  // width in mm lands on exactly `dots` device pixels.
  const zoom = dots / (mm * 96 / 25.4)

  const page = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/head>/i, `<style>html,body{margin:0!important;padding:0!important;background:#fff!important;width:${mm}mm!important;overflow:hidden!important}</style></head>`)

  const w = new BrowserWindow({
    show: false, width: dots, height: 400, useContentSize: true, frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    w.webContents.setFrameRate(10)
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
    w.webContents.setZoomFactor(zoom)
    // Let the QR image decode and layout settle at the new zoom.
    await w.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r }))).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))')
    const cssH = await w.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)')
    const height = Math.min(Math.ceil(cssH * zoom) + 8, 12000)
    w.setContentSize(dots, height)
    await new Promise(r => setTimeout(r, 250))
    w.webContents.invalidate()
    await new Promise(r => setTimeout(r, 250))
    let img = await w.webContents.capturePage({ x: 0, y: 0, width: dots, height })
    const size = img.getSize()
    if (size.width !== dots) img = img.resize({ width: dots, quality: 'best' })
    const s = img.getSize()
    return { bgra: img.toBitmap(), width: s.width, height: s.height }
  } finally {
    try { w.destroy() } catch { /* already gone */ }
  }
}

/** Render, then encode. Returns the bytes to send down the COM port. */
async function htmlToEscPos(html, paper = '80', opts = {}) {
  const px = await renderHtml(html, paper)
  return { ...encodeRaster(px.bgra, px.width, px.height, opts), width: px.width, height: px.height }
}

module.exports = { DOTS, PRINTABLE_MM, encodeRaster, renderHtml, htmlToEscPos }
