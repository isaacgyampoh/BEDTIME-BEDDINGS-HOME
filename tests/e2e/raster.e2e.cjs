/**
 * End-to-end: a real delivery label, laid out by the desktop app's raster
 * renderer, sent down a (simulated) COM port, then decoded from the bytes the
 * printer received back into an image — so what the head would print can be
 * looked at, not assumed.   npm run test:raster
 */
const { app, nativeImage } = require('electron')
const { spawn } = require('child_process')
const path = require('path'), fs = require('fs'), os = require('os')
const serial = require(path.join(__dirname, '../../desktop/serial.js'))
const raster = require(path.join(__dirname, '../../desktop/raster.js'))
const { deliveryLabelHTML } = require(process.env.LABEL_BUNDLE)

let pass = 0, fail = 0
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + l) } else { fail++; console.log('  \x1b[31m✗ ' + l + '\x1b[0m ' + e) } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** Read GS v 0 bands out of a captured byte stream and stack them. */
function decode(buf) {
  const bands = []; let i = 0
  while (i < buf.length) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      const xb = buf[i + 4] | (buf[i + 5] << 8), h = buf[i + 6] | (buf[i + 7] << 8)
      bands.push({ xb, h, data: buf.subarray(i + 8, i + 8 + xb * h) }); i += 8 + xb * h
    } else i++
  }
  if (!bands.length) return null
  const xb = bands[0].xb, W = xb * 8, H = bands.reduce((a, b) => a + b.h, 0)
  const px = Buffer.alloc(W * H * 4, 255)
  let y0 = 0
  for (const b of bands) {
    for (let y = 0; y < b.h; y++) for (let x = 0; x < W; x++) {
      if (b.data[y * xb + (x >> 3)] & (0x80 >> (x & 7))) { const k = ((y0 + y) * W + x) * 4; px[k] = px[k + 1] = px[k + 2] = 0 }
    }
    y0 += b.h
  }
  return { img: nativeImage.createFromBitmap(px, { width: W, height: H }), W, H, bands: bands.length }
}

// The render window is the only window here; without this Electron quits the
// moment it closes. (In the app the POS window is always open.)
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const cap = path.join(os.tmpdir(), `rasterprinter-${process.pid}.bin`)
  const fp = spawn('python3', [path.join(__dirname, 'fake_printer.py'), '19200', cap, '0'])
  const dev = await new Promise(r => fp.stdout.once('data', d => r(d.toString().trim())))
  try {
    const order = {
      id: 'b8f1c2d4-0000-4000-8000-000000000001', orderNo: 'WEB-MTL6T98Y', trackingNo: 'BT-7Q4K2M',
      customerName: 'Ama Mensah', customerPhone: '024 400 0000', address: 'East Legon, near A&C Mall | blue gate',
      total: 820, deliveryFee: 30, status: 'Paid', items: [{ name: '6pcs Kingsize Duvet set', qty: 1, price: 450 }, { name: 'Cotton Bedsheet 4pcs', qty: 1, price: 340 }],
      date: '2026-09-22T10:00:00Z',
    }
    // A stand-in QR (a real one needs the network); a solid square is enough
    // to prove images survive the trip.
    const qr = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#000"/><rect x="20" y="20" width="80" height="80" fill="#fff"/><rect x="40" y="40" width="40" height="40" fill="#000"/></svg>').toString('base64')
    const html = deliveryLabelHTML(order, { qr, deliverUrl: 'https://admin.bedtimehome.com/#/deliver/b8f1', paper: '80', shop: { name: 'BEDTIME BEDDINGS & HOME', phone: '0240000000', address: 'Accra' } })

    const t0 = Date.now()
    const out = await raster.htmlToEscPos(html, '80')
    ok(`rendered at 576 dots wide (${out.width}x${out.height}) in ${Date.now() - t0}ms`, out.width === 576)
    ok('produced raster bands', out.bytes.includes(Buffer.from([0x1d, 0x76, 0x30])))
    ok('stops shortly after the last ink rather than at the window edge', out.rows <= out.height)

    const w = await serial.writeSerial(dev, 19200, out.bytes)
    await sleep(1500)
    const got = fs.readFileSync(cap)
    ok('sent over serial', w.ok, JSON.stringify(w))
    ok('every raster byte arrived', got.length === out.bytes.length, `${got.length} / ${out.bytes.length}`)

    const d = decode(got)
    ok('the printer-side bytes decode to an image', !!d)
    if (d) {
      const png = path.join(process.env.OUT_DIR || os.tmpdir(), 'label-as-printed.png')
      fs.writeFileSync(png, d.img.toPNG())
      console.log('  → what the head would print:', png, `(${d.W}x${d.H}, ${d.bands} bands)`)
      // Ink coverage: a label is mostly paper; all-white or all-black means the
      // render or the threshold is wrong.
      const bmp = d.img.toBitmap(); let ink = 0
      for (let i = 0; i < bmp.length; i += 4) if (bmp[i] === 0) ink++
      const cover = ink / (d.W * d.H)
      ok(`ink coverage is plausible for a label (${(cover * 100).toFixed(1)}%)`, cover > 0.03 && cover < 0.6)
    }
  } catch (e) { fail++; console.log('  \x1b[31m✗ threw\x1b[0m', e && e.stack) }
  finally { try { fp.kill('SIGKILL') } catch {} ; console.log(`\n${pass} passed, ${fail} failed`); app.exit(fail ? 1 : 0) }
})
