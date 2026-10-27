/**
 * Adding a product photo, through the real form, with a real file.
 *
 * The report was "when you upload a product and add an image, the image
 * doesn't show". The cause was that every upload was named .jpg and declared
 * image/jpeg while four code paths could hand over the ORIGINAL bytes — so a
 * HEIC photo off a phone was stored as JPEG, the upload returned no error, the
 * product saved, and the picture never appeared.
 *
 * This drives the actual file input and watches what leaves the browser.
 *
 * Run with: npm run test:upload
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app, BrowserWindow } = require('electron')
const { intercept, helpers, sleep } = require('./flow.cjs')
const DEV = process.env.POS_DEV_URL || 'http://localhost:5173'

let pass = 0, fail = 0
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + l) } else { fail++; console.log('  \x1b[31m✗ ' + l + '\x1b[0m ' + (e || '')) } }
const finish = (code) => { console.log(`\n${pass} passed, ${fail} failed`); app.exit(code ?? (fail ? 1 : 0)) }
setTimeout(() => { ok('finished within 180s', false); finish(2) }, 180000)
process.on('unhandledRejection', (e) => { ok('no unhandled rejection', false, e && e.stack); finish(3) })
app.on('window-all-closed', () => {})

const PRODUCTS = [{ id: 'p1', name: 'Existing Duvet', category: 'Duvets', price: 450, cost_price: 300, quantity: 5 }]

// A real 2x2 PNG, and a file that claims to be a HEIC and cannot be decoded —
// which is what a phone photo looks like to a browser that has no HEIC codec.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-e2e-'))
const PNG = path.join(dir, 'duvet.png')
fs.writeFileSync(PNG, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQ0AABHEAaFviFsdAAAAAElFTkSuQmCC', 'base64'))
const HEIC = path.join(dir, 'IMG_4312.heic')
// ftyp box naming heic, then nothing a decoder can use.
fs.writeFileSync(HEIC, Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.from([0, 0, 0, 0]),
  Buffer.from('heicmif1'), Buffer.alloc(64, 0),
]))

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1400, height: 1000 })
  await w.loadURL(DEV)
  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)

  // Remember every storage upload: the path and the type it was declared as.
  const uploads = []
  net.script = ({ method, path: p, url }) => {
    if (p.startsWith('/storage/v1/object/')) {
      uploads.push({ method, path: p, url })
      return { Key: p.replace('/storage/v1/object/', '') }
    }
    if (method !== 'GET') return undefined
    if (p.endsWith('/rest/v1/products')) return PRODUCTS
    if (p.startsWith('/rest/v1/')) return []
    return undefined
  }
  await w.loadURL(DEV)
  const h = helpers(w, dbg)
  const js = h.js

  await h.waitFor('!!window.__POS_STORE__', 12000)
  await js(`window.__POS_STORE__.getState().login({ id: 'e2e', name: 'E2E Admin', role: 'Admin' }, true)`)
  await h.waitFor(`(() => { const s = window.__POS_STORE__.getState(); return s.products.length > 0 && !s.loading })()`, 20000)
  await js(`window.__POS_STORE__.getState().setPage('products')`)
  await h.waitFor(`document.body.innerText.includes('Products')`, 10000)
  ok('the products page opens', await js(`document.body.innerText.includes('Products')`))

  // Fill a field by the label above it. The product form's inputs share a
  // class and carry no placeholder, so picking "the first one" filled the
  // wrong box and the save stopped at "Enter name" without ever reaching the
  // image — which is how this test first passed while proving nothing.
  const setField = (label, value) => js(`(() => {
    const lab = [...document.querySelectorAll('label')].find(l => l.innerText.trim() === ${JSON.stringify(label)})
    if (!lab) return 'no label ' + ${JSON.stringify(label)}
    const input = lab.parentElement.querySelector('input, textarea')
    if (!input) return 'no input under ' + ${JSON.stringify(label)}
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)

  // Put a file on the real <input type=file>, as a person would.
  const setFile = async (file) => {
    const { root } = await dbg.sendCommand('DOM.getDocument', {})
    const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
    if (!nodeId) return false
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], nodeId })
    return true
  }

  // ── a PNG: it must arrive declared as what it actually is ────────────────
  const openForm = async () => {
    for (let i = 0; i < 12; i++) {
      const r = await js(`(() => {
        if (document.querySelector('input[type=file]')) return 'ok'
        const b = [...document.querySelectorAll('button')].filter(x => x.innerText.trim() === 'Add' && x.getClientRects().length)[0]
        if (!b) return 'waiting'
        b.scrollIntoView({ block: 'center' }); b.click(); return 'clicked'
      })()`)
      await sleep(600)
      if (await js(`!!document.querySelector('input[type=file]')`)) return 'ok'
    }
    return 'never opened'
  }
  ok('Add opens the form', (await openForm()) === 'ok')
  await sleep(500)
  ok('the form has a file input', await setFile(PNG))
  await sleep(900)
  ok('the name can be filled', (await setField('Name', 'Test Duvet')) === 'ok')
  await sleep(300)
  uploads.length = 0
  await h.tap('button', 'Save')
  await sleep(2500)

  ok('the photo was uploaded', uploads.length === 1, JSON.stringify(uploads))
  if (uploads.length) {
    const p = uploads[0].path
    ok('under a name matching its contents', /\.(jpg|png|webp)$/.test(p), p)
    // The canvas can decode a PNG, so it is re-encoded and really is a JPEG.
    ok('a decodable image becomes a real jpeg', p.endsWith('.jpg'), p)
  }

  // ── a HEIC: it must be refused, not stored as a broken jpeg ──────────────
  await js(`document.querySelectorAll('.pos-modal').forEach(m => { const b = [...m.querySelectorAll('button')].find(x => /Cancel|✕/.test(x.innerText)); b && b.click() })`)
  await sleep(500)
  ok('Add opens again', (await openForm()) === 'ok')
  await sleep(500)
  ok('the HEIC is offered to the form', await setFile(HEIC))
  await sleep(900)
  await setField('Name', 'Phone Photo Duvet')
  await sleep(300)
  uploads.length = 0
  await h.tap('button', 'Save')
  await sleep(2500)

  // react-hot-toast renders its messages outside the form; read only those,
  // because the help text under the file input mentions HEIC too and would
  // make this assertion pass without any error being shown at all.
  const toast = await js(`(() => {
    const el = [...document.querySelectorAll('[class*="toast"], [role="status"], [data-sonner-toast]')]
      .map(n => n.innerText).filter(Boolean)
    return el.join(' | ')
  })()`)
  ok('NOTHING was uploaded for an undisplayable photo', uploads.length === 0, JSON.stringify(uploads))
  ok('an error is actually shown', !!toast, 'no toast appeared at all')
  ok('it names HEIC', /HEIC/i.test(toast), toast)
  ok('with something they can act on', /Most Compatible|JPEG/i.test(toast), toast)

  // The old behaviour: upload it anyway, as image/jpeg, and show nothing.
  ok('the product was not saved with a photo that cannot load',
     !net.writes.some(x => x.path.includes('/rest/v1/products') && x.method === 'POST'),
     JSON.stringify(net.writes.map(x => x.method + ' ' + x.path)))

  finish()
}).catch(e => { ok('ran', false, e && e.stack); finish(4) })
