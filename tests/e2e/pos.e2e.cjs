/**
 * Cashier scenarios in both runtimes, through the real UI (see flow.cjs).
 *   MODE=chrome   the web app as Chrome on a Windows till runs it
 *   MODE=desktop  the real desktop main.js + preload, printing over the real
 *                 serialport module to tests/e2e/fake_printer.py
 * Run with: npm run test:pos   (starts Vite if it is not already running)
 */
const path = require('path'), fs = require('fs'), os = require('os')
const { spawn } = require('child_process')
const MODE = process.env.MODE || 'chrome'
const DEV = process.env.POS_DEV_URL || 'http://localhost:5173'
const { app, BrowserWindow } = require('electron')
const { intercept, helpers, login, scenarios, sleep } = require('./flow.cjs')

let pass = 0, fail = 0
const ok = (l, c, e = '') => { if (c) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + l) } else { fail++; console.log('  \x1b[31m✗ ' + l + '\x1b[0m ' + (e || '')) } }
const finish = (code) => { console.log(`\n${pass} passed, ${fail} failed`); app.exit(code ?? (fail ? 1 : 0)) }
setTimeout(() => { ok('finished within 240s', false); finish(2) }, 240000)
process.on('unhandledRejection', (e) => { ok('no unhandled rejection', false, e && e.stack); finish(3) })
app.on('window-all-closed', () => {})

let printer = null
if (MODE === 'desktop') {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-e2e-'))
  app.setPath('userData', ud)
  process.env.POS_DEV_URL = DEV
  const cap = path.join(ud, 'printed.bin')
  const fp = spawn('python3', [path.join(__dirname, 'fake_printer.py'), '19200', cap, '0'])
  printer = { cap, fp, ready: new Promise(r => fp.stdout.once('data', d => r(d.toString().trim()))) }
  printer.ready.then(dev => fs.writeFileSync(path.join(ud, 'pos-settings.json'), JSON.stringify({ kiosk: false, firstRunDone: true, printerPort: dev, printerBaud: 19200 })))
}

app.whenReady().then(async () => {
  if (printer) await printer.ready
  let w
  if (MODE === 'desktop') {
    require(path.join(__dirname, '../../desktop/main.js'))
    for (let i = 0; i < 50 && !(w = BrowserWindow.getAllWindows()[0]); i++) await sleep(100)
    ok('[desktop] main window opens', !!w)
    await new Promise(r => w.webContents.isLoading() ? w.webContents.once('did-finish-load', r) : r())
    ok('[desktop] preload bridge present', await w.webContents.executeJavaScript('!!(window.posDesktop && window.posDesktop.isDesktop)'))
  } else {
    w = new BrowserWindow({ show: false, width: 1366, height: 768 })
    w.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')
    await w.loadURL(DEV)
    await w.webContents.executeJavaScript('localStorage.clear()')
    await w.loadURL(DEV)
    ok('[chrome] not seen as the desktop app', !(await w.webContents.executeJavaScript('!!window.posDesktop')))
  }

  const dbg = w.webContents.debugger; dbg.attach('1.3')
  const net = { writes: [], script: null }
  await intercept(dbg, net)
  const h = helpers(w, dbg)

  if (MODE === 'chrome') {
    // Browser path with no paired printer ends at the OS print dialog. Catch
    // print() on the hidden frame and keep what it would have printed.
    await h.js(`(() => {
      window.__printed = []
      const add = Node.prototype.appendChild
      Node.prototype.appendChild = function (n) {
        const r = add.call(this, n)
        if (n && n.tagName === 'IFRAME' && n.contentWindow) {
          n.contentWindow.print = function () { window.__printed.push(n.contentDocument.body.innerText); setTimeout(() => n.contentWindow.onafterprint && n.contentWindow.onafterprint(), 10) }
        }
        return r
      }
    })()`)
  }
  const printCheck = (label) => async ({ A, receiptNo }) => {
    if (MODE === 'chrome') {
      const before = await h.js('window.__printed.length')
      const t = await h.tap('button', 'Print Receipt'); ok(`[${label}] tap Print Receipt`, t.ok, t.why)
      await sleep(1200)
      const printed = await h.js(`window.__printed.slice(${before}).join('\\n')`)
      ok(`[${label}] the print job carries ${receiptNo}`, printed.includes(receiptNo) && (!A.name || printed.includes(A.name)), printed.slice(0, 120))
    } else {
      const before = fs.readFileSync(printer.cap).length
      const t = await h.tap('button', 'Print Receipt'); ok(`[${label}] tap Print Receipt`, t.ok, t.why)
      for (let i = 0; i < 30 && fs.readFileSync(printer.cap).length === before; i++) await sleep(200)
      await sleep(500)
      const text = fs.readFileSync(printer.cap).slice(before).toString('latin1')
      ok(`[${label}] the printer received ${receiptNo} over serial`, text.includes(receiptNo), `${text.length} bytes`)
      if (A.name) ok(`[${label}] with the product and total`, text.includes(A.name.slice(0, 20)) && text.includes(Number(A.price).toFixed(2)))
      ok(`[${label}] no "Not printed" error on screen`, !(await h.js(`!!document.querySelector('[role=alert]')`)))
    }
  }

  await login(h, ok, MODE)
  const only = (process.env.SCENARIOS || 'cash,momo,split,reprint').split(',')
  for (const name of only) {
    const label = `${MODE}/${name}`
    try { await scenarios[name]({ h, net, ok, label, printCheck: printCheck(label) }) }
    catch (e) { ok(`[${label}] ran without throwing`, false, e && e.stack) }
    if (name !== 'reprint') {
      await h.js(`window.__POS_STORE__.getState().setPage('pos')`)
      await h.waitFor("document.querySelectorAll('button.bg-white.overflow-hidden').length > 10", 8000)
    }
  }
  try { printer && printer.fp.kill('SIGKILL') } catch {}
  finish()
})
