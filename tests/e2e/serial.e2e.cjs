/**
 * End-to-end: the desktop app's serial printing, through the real `serialport`
 * native module, against a simulated printer (tests/e2e/fake_printer.py).
 *
 * Run with Electron, not node, so the native module loads under the same ABI
 * as the packaged app:   npm run test:serial
 *
 * What it proves, each against real bytes on a real tty:
 *   1. findPrinter locates the printer when it is NOT at 9600 — the case the
 *      desktop app used to get wrong every time
 *   2. it skips a port that does not answer, and a port that cannot open
 *   3. a receipt built by the app's own receiptBytes() arrives intact
 *   4. printing at the wrong speed is detectable, not silently "successful"
 *   5. a paper-out printer is reported as out of paper
 */
const { app } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const serial = require(path.join(__dirname, '../../desktop/serial.js'))
const ESCPOS = process.env.ESCPOS_BUNDLE      // receiptBytes, bundled to CJS by the runner

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + label) }
  else { fail++; console.log('  \x1b[31m✗ ' + label + '\x1b[0m ' + extra) }
}

function startPrinter(baud, paperOut = false) {
  const cap = path.join(os.tmpdir(), `fakeprinter-${process.pid}-${baud}-${paperOut ? 'po' : 'ok'}.bin`)
  const p = spawn('python3', [path.join(__dirname, 'fake_printer.py'), String(baud), cap, paperOut ? '1' : '0'])
  return new Promise((resolve, reject) => {
    p.stdout.once('data', (d) => resolve({ proc: p, dev: d.toString().trim(), cap }))
    p.once('error', reject)
    setTimeout(() => reject(new Error('fake printer did not start')), 5000)
  })
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

app.whenReady().then(async () => {
  const procs = []
  try {
    ok('serialport native module loaded', serial.available)
    const { receiptBytes } = require(ESCPOS)

    // A printer at 19200: the desktop app's old fixed 9600 would never reach it.
    const good = await startPrinter(19200); procs.push(good.proc)
    const silent = await startPrinter(19200); procs.push(silent.proc)
    silent.proc.kill('SIGSTOP')          // a port that opens but never answers

    let saved = {}
    const ports = [
      { path: '/dev/does-not-exist', score: 3 },   // looks like a printer, cannot open
      { path: silent.dev, score: 2 },
      { path: good.dev, score: 0 },                  // plain COM port, like the till's
    ]
    const found = await serial.findPrinter({
      readSettings: () => saved,
      writeSettings: (p) => { saved = { ...saved, ...p } },
      listPorts: async () => ports,
    })
    ok('findPrinter succeeds', found.ok, JSON.stringify(found).slice(0, 200))
    ok('it found the port that answers, not the best-named one', found.port === good.dev, found.port)
    ok('it found the printer at 19200, not 9600', found.baud === 19200, String(found.baud))
    ok('it saved the port and speed for next time', saved.printerPort === good.dev && saved.printerBaud === 19200)

    const sale = {
      receiptNo: 'RCP-E2E-001', dateText: '22/09/2026 10:15', cashier: 'Ama', customer: 'Walk-in',
      payment: 'Cash', total: 285, discount: 0,
      items: [{ name: 'Duvet set', qty: 1, price: 250 }, { name: 'Pillow case', qty: 1, price: 35 }],
    }
    const shop = { name: 'BEDTIME BEDDINGS & HOME', address: 'Accra', phone: '0240000000' }
    const bytes = receiptBytes(sale, shop, '80')
    const w = await serial.writeSerial(found.port, found.baud, bytes)
    await sleep(600)
    const got = fs.readFileSync(good.cap)
    ok('writeSerial reports success', w.ok, JSON.stringify(w))
    ok('every byte of the receipt reached the printer', got.length === bytes.length, `${got.length} of ${bytes.length}`)
    const text = got.toString('latin1')
    ok('the shop name printed', text.includes('BEDTIME BEDDINGS'))
    ok('the receipt number printed', text.includes('RCP-E2E-001'))
    ok('both items printed', text.includes('Duvet set') && text.includes('Pillow case'))
    ok('the total printed', /285\.00/.test(text))
    ok('the paper is cut at the end', got.slice(-4).equals(Buffer.from([0x1d, 0x56, 66, 0])))

    // Wrong speed: the bytes leave, but a real head prints nothing useful.
    const before = fs.readFileSync(good.cap).length
    await serial.writeSerial(found.port, 9600, bytes)
    await sleep(600)
    ok('at the wrong speed nothing legible prints', fs.readFileSync(good.cap).length === before)
    ok('...and the probe can tell the speed is wrong', !(await serial.probe(found.port, 9600)))

    // Status: healthy, then out of paper.
    const st = await serial.readPrinterStatus(found.port, found.baud)
    ok('a healthy printer reports ready', st.ok && st.supported && st.ready, JSON.stringify(st))
    const empty = await startPrinter(19200, true); procs.push(empty.proc)
    const st2 = await serial.readPrinterStatus(empty.dev, 19200)
    ok('an empty printer reports out of paper', st2.supported && st2.faults.some(f => /out of paper/i.test(f)), JSON.stringify(st2))

    // Nothing anywhere: a clear message, not a silent success.
    const none = await serial.findPrinter({ readSettings: () => ({}), writeSettings: () => {}, listPorts: async () => [{ path: '/dev/nope', score: 0 }] })
    ok('no printer is a failure with a reason', !none.ok && /No printer answered/.test(none.error || ''), none.error)
    const zero = await serial.findPrinter({ readSettings: () => ({}), writeSettings: () => {}, listPorts: async () => [] })
    ok('no ports is a failure with a reason', !zero.ok && /No COM ports/.test(zero.error || ''), zero.error)
  } catch (e) {
    fail++; console.log('  \x1b[31m✗ harness threw\x1b[0m', e && e.stack)
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
    console.log(`\n${pass} passed, ${fail} failed`)
    app.exit(fail ? 1 : 0)
  }
})
