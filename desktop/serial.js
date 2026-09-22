/**
 * Talking to the till's receipt printer over a COM port.
 *
 * Kept out of main.js so it can be exercised against a real serial device in
 * tests — tests/serial.e2e.cjs drives every function here through the actual
 * `serialport` native module, with a pseudo-terminal standing in for the
 * printer. main.js only wires these to IPC.
 *
 * Must stay listed in package.json "build.files": that list is an allowlist,
 * and a module missing from it is missing from the installer, which crashes
 * the packaged app on launch.
 */
let SerialPort = null
try { ({ SerialPort } = require('serialport')) }
catch (e) { console.warn('serialport unavailable:', e.message) }

/** Serial ports that look like a thermal printer, best guess first. */
async function listSerialPorts() {
  if (!SerialPort) return []
  const ports = await SerialPort.list()
  const score = (p) => {
    const s = `${p.manufacturer || ''} ${p.friendlyName || ''} ${p.pnpId || ''}`.toLowerCase()
    if (/printer|pos-?58|pos-?80|xprinter|gprinter|epson|thermal/.test(s)) return 3
    // The USB-serial bridges these OEM tills use internally.
    if (/ch340|ch341|prolific|pl2303|ftdi|silicon labs|cp210/.test(s)) return 2
    if (/usb/.test(s)) return 1
    return 0
  }
  return ports
    .map(p => ({ path: p.path, manufacturer: p.manufacturer || '', friendlyName: p.friendlyName || '', vendorId: p.vendorId || '', productId: p.productId || '', score: score(p) }))
    .sort((a, b) => b.score - a.score)
}

/** Write raw ESC/POS bytes to a COM port. This is the path that needs no driver. */
function writeSerial(portPath, baudRate, bytes) {
  return new Promise((resolve) => {
    if (!SerialPort) return resolve({ ok: false, error: 'Serial support is not available in this build' })
    let port
    try {
      port = new SerialPort({ path: portPath, baudRate: baudRate || 9600, autoOpen: false })
    } catch (e) { return resolve({ ok: false, error: e.message }) }

    const fail = (msg) => { try { port.close(() => {}) } catch {} ; resolve({ ok: false, error: msg }) }
    const timer = setTimeout(() => fail('Printer did not respond'), 10000)

    port.open((err) => {
      if (err) { clearTimeout(timer); return resolve({ ok: false, error: err.message }) }
      port.write(Buffer.from(bytes), (wErr) => {
        if (wErr) { clearTimeout(timer); return fail(wErr.message) }
        // drain() waits for the bytes to actually leave the buffer; closing
        // early truncates the receipt on slow heads.
        port.drain((dErr) => {
          clearTimeout(timer)
          port.close(() => resolve(dErr ? { ok: false, error: dErr.message } : { ok: true }))
        })
      })
    })
  })
}

/**
 * Ask the printer what is wrong with it.
 *
 * writeSerial only ever writes. When a thermal printer is out of paper, or its
 * cover is not latched, it drops everything sent to it and says nothing — so a
 * receipt "prints" successfully and no paper moves. That is exactly the state a
 * till is left in after a roll runs out mid-sale.
 *
 * ESC/POS real-time status (DLE EOT n) is answered even while the printer is
 * offline — that is the point of it, it jumps the print queue.
 *
 * The queries are sent ONE AT A TIME and each reply decoded against its own
 * query. The same bit means different things depending on what was asked:
 * bit 2 is "cover open" in the offline-cause reply but "drawer kick-out" in the
 * printer-status reply. Firing all three and reading bits off whatever comes
 * back reports a healthy printer as having its cover open.
 *
 * Plenty of cheap clones answer none of this. Silence is reported as "cannot
 * tell", never as a fault, and never as a reason to stop printing.
 */
const STATUS_QUERIES = [
  // DLE EOT 2 — why the printer is offline.
  { n: 2, bits: [
    [0x04, 'The cover is open, or not clicked fully shut.'],
    [0x20, 'Printing stopped because it is out of paper.'],
    [0x40, 'The printer reports an error — usually a jam or the cutter.'],
  ] },
  // DLE EOT 4 — the paper sensors. Both bits set means the roll has run out.
  { n: 4, bits: [
    [0x60, 'Out of paper.'],
  ] },
]

function readPrinterStatus(portPath, baudRate) {
  return new Promise((resolve) => {
    if (!SerialPort) return resolve({ ok: false, error: 'Serial support is not available in this build' })
    let port
    try {
      port = new SerialPort({ path: portPath, baudRate: baudRate || 9600, autoOpen: false })
    } catch (e) { return resolve({ ok: false, error: e.message }) }

    let settled = false
    const done = (out) => {
      if (settled) return
      settled = true
      try { port.close(() => {}) } catch { /* already gone */ }
      resolve(out)
    }
    port.on('error', (e) => done({ ok: false, error: e.message }))

    /** Send one query and wait for the single byte it answers with. */
    const ask = (n) => new Promise((res) => {
      let timer = null
      const onData = (d) => {
        const b = [...d].find(isStatusByte)
        if (b === undefined) return
        clearTimeout(timer); port.off('data', onData); res(b)
      }
      port.on('data', onData)
      timer = setTimeout(() => { port.off('data', onData); res(null) }, 700)
      port.write(Buffer.from([0x10, 0x04, n]), (e) => {
        if (e) { clearTimeout(timer); port.off('data', onData); res(null) }
      })
    })

    port.open(async (err) => {
      if (err) return done({ ok: false, error: err.message })
      const faults = []
      let answered = 0
      for (const q of STATUS_QUERIES) {
        const b = await ask(q.n)
        if (b === null) continue
        answered++
        for (const [mask, message] of q.bits) {
          if ((b & mask) === mask && !faults.includes(message)) faults.push(message)
        }
      }
      if (!answered) {
        return done({ ok: true, supported: false, reason: 'The printer did not answer a status request. Many low-cost heads do not implement it.' })
      }
      done({ ok: true, supported: true, faults, ready: faults.length === 0 })
    })
  })
}

/**
 * Every real-time status reply has bit 4 set with bit 0 and bit 7 clear.
 * Anything else is the printer echoing, or line noise, and would decode into
 * confident nonsense — telling a shop it is out of paper when the roll is full
 * sends someone hunting for a fault that is not there.
 */
function isStatusByte(b) {
  return (b & 0x10) === 0x10 && (b & 0x01) === 0 && (b & 0x80) === 0
}

// ── finding the printer ─────────────────────────────────────────────────────
//
// The browser build gets its port and speed from the operator, who picks the
// port in Chrome's own chooser and sets the speed by hand. The desktop app had
// neither: it guessed the port from the USB description, refused any port it
// did not recognise, and always spoke at 9600. A printer built into the till
// usually appears as a plain "Communications Port" (so it was refused), and
// many of these heads run at 19200 or 115200 (so even a correct port printed
// nothing). The operator had no way to fix either from the desktop app.
//
// So ask. A real ESC/POS head answers DLE EOT 1 with a single status byte, and
// it only answers intelligibly at its own speed — at the wrong speed the byte
// is garbled or never arrives. Trying each port at each speed and keeping the
// one that answers is detection, not guessing.

const BAUDS = [9600, 19200, 38400, 57600, 115200]

/** Does a printer answer on this port at this speed? */
function probe(portPath, baudRate, waitMs = 450) {
  return new Promise((resolve) => {
    if (!SerialPort) return resolve(false)
    let port, settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { port && port.isOpen ? port.close(() => resolve(v)) : resolve(v) } catch { resolve(v) }
    }
    const timer = setTimeout(() => done(false), waitMs + 400)
    try { port = new SerialPort({ path: portPath, baudRate, autoOpen: false }) } catch { return done(false) }
    port.on('error', () => done(false))
    port.on('data', (d) => { if ([...d].some(isStatusByte)) done(true) })
    port.open((err) => {
      if (err) return done(false)
      port.write(Buffer.from([0x10, 0x04, 0x01]), (e) => { if (e) done(false) })
      setTimeout(() => done(false), waitMs)
    })
  })
}

/**
 * Candidate order: the saved port and speed first (the common case is that
 * they are still right), then ports by how printer-like they look, each at
 * every speed with 9600 first. Exported shape is tested in tests/findprinter.
 */
function probeOrder(ports, saved = {}) {
  const paths = ports.map(p => p.path)
  const orderedPorts = saved.printerPort && paths.includes(saved.printerPort)
    ? [saved.printerPort, ...paths.filter(p => p !== saved.printerPort)]
    : paths
  const bauds = saved.printerBaud && BAUDS.includes(Number(saved.printerBaud))
    ? [Number(saved.printerBaud), ...BAUDS.filter(b => b !== Number(saved.printerBaud))]
    : BAUDS
  const out = []
  for (const path of orderedPorts) for (const baud of bauds) out.push({ path, baud })
  return out
}

let finding = null
/** Search every port at every speed. Saves and returns the first that answers. */
function findPrinter({ readSettings, writeSettings, listPorts = listSerialPorts } = {}) {
  if (finding) return finding            // two callers share one search
  finding = (async () => {
    if (!SerialPort) return { ok: false, error: 'Serial support is not available in this build', ports: [] }
    const ports = await listPorts()
    if (!ports.length) return { ok: false, error: 'No COM ports found on this machine. The printer cable inside the till may be loose.', ports }
    const tried = []
    for (const c of probeOrder(ports, readSettings())) {
      tried.push(`${c.path}@${c.baud}`)
      if (await probe(c.path, c.baud)) {
        writeSettings({ printerPort: c.path, printerBaud: c.baud })
        return { ok: true, port: c.path, baud: c.baud, tried, ports }
      }
    }
    return {
      ok: false,
      error: 'No printer answered on any port. It may be off, out of paper, or a model that does not answer status requests — pick the port and speed by hand, then print a test page.',
      tried, ports,
    }
  })().finally(() => { finding = null })
  return finding
}

module.exports = {
  get available() { return !!SerialPort },
  listSerialPorts, writeSerial, readPrinterStatus, isStatusByte,
  probe, probeOrder, findPrinter, BAUDS, STATUS_QUERIES,
}
