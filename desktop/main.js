/**
 * BEDTIME POS — Electron main process.
 *
 * Exists to solve things a browser on a POS terminal cannot:
 *
 *   Printing.  The built-in thermal head on these tills is not installed as a
 *              Windows printer, so a browser has no destination for it. Here we
 *              enumerate COM ports with Node and write ESC/POS bytes straight
 *              to the head — no driver, no print queue, no dialog. When a real
 *              Windows printer DOES exist we can also print silently to it.
 *
 *   Kiosk.     Genuine fullscreen with no browser chrome, and a single instance.
 *
 *   2nd screen.Electron reports the physical displays, so the customer window
 *              lands on the right monitor instead of guessing with a popup.
 *
 *   Offline.   The UI is loaded from disk, so the till opens even with no
 *              internet. Only data needs the network.
 *
 * Security: contextIsolation on, nodeIntegration off. The renderer reaches this
 * process only through the narrow, explicitly-listed channels in preload.js.
 */

const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

// serialport is a native module. If it fails to load (missing prebuild on an
// unusual machine) the app must still run — printing simply falls back.
let SerialPort = null
try { ({ SerialPort } = require('serialport')) }
catch (e) { console.warn('serialport unavailable, raw printing disabled:', e.message) }

const DEV_URL = process.env.POS_DEV_URL || ''
const isDev = !!DEV_URL || !app.isPackaged

/** The built web app: bundled next to the binary in production. */
function appIndex() {
  const packaged = path.join(process.resourcesPath || '', 'app', 'index.html')
  if (fs.existsSync(packaged)) return packaged
  return path.join(__dirname, '..', 'dist', 'index.html')
}

let mainWindow = null
let customerWindow = null

// ── settings (tiny JSON beside the user data, not localStorage) ─────────────
const settingsFile = () => path.join(app.getPath('userData'), 'pos-settings.json')
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) } catch { return {} }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2)) } catch {}
  return next
}

// ── windows ────────────────────────────────────────────────────────────────
function createMainWindow() {
  const saved = readSettings()
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 600,
    show: false,
    backgroundColor: '#f6f6f5',
    autoHideMenuBar: true,
    kiosk: saved.kiosk !== false,          // a till runs kiosk unless told not to
    fullscreen: saved.kiosk !== false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,                      // preload needs require()
      spellcheck: false,
    },
  })

  if (DEV_URL) mainWindow.loadURL(DEV_URL)
  else mainWindow.loadFile(appIndex())

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // External links open in the real browser, never inside the till shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' } }
    return { action: 'deny' }
  })

  // A white screen on a till is worse than a message.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    dialog.showErrorBox('BEDTIME POS', `The app stopped unexpectedly (${details.reason}). It will restart.`)
    app.relaunch(); app.exit(0)
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

/** Put the customer display on a genuine second monitor. */
function openCustomerWindow(regId) {
  if (customerWindow && !customerWindow.isDestroyed()) { customerWindow.focus(); return { ok: true, reused: true } }

  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const secondary = displays.find(d => d.id !== primary.id)
  if (!secondary) return { ok: false, error: 'Only one display is connected' }

  const { x, y, width, height } = secondary.bounds
  customerWindow = new BrowserWindow({
    x, y, width, height,
    frame: false, fullscreen: true, kiosk: true,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  const hash = `#/customer-display?reg=${encodeURIComponent(regId || '')}`
  if (DEV_URL) customerWindow.loadURL(DEV_URL + '/' + hash)
  else customerWindow.loadFile(appIndex(), { hash })

  customerWindow.on('closed', () => { customerWindow = null })
  return { ok: true, display: { width, height } }
}

// ── printing ───────────────────────────────────────────────────────────────

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
 * Print HTML with no dialog, to a named Windows printer.
 * Only useful when the printer IS installed in Windows; the serial path above
 * is what covers the built-in head that is not.
 */
function printSilentHTML(html, { deviceName, widthMicrons = 80000 } = {}) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false },
    })
    const done = (res) => { try { w.destroy() } catch {} ; resolve(res) }
    const timer = setTimeout(() => done({ ok: false, error: 'Print timed out' }), 20000)

    w.webContents.once('did-finish-load', () => {
      // A receipt is one continuous strip; give it a tall page so the driver
      // does not split it across sheets.
      w.webContents.print({
        silent: true,
        printBackground: false,
        deviceName: deviceName || undefined,
        margins: { marginType: 'none' },
        pageSize: { width: widthMicrons, height: 297000 },
      }, (success, failureReason) => {
        clearTimeout(timer)
        done(success ? { ok: true } : { ok: false, error: failureReason || 'Printing failed' })
      })
    })

    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(e => {
      clearTimeout(timer); done({ ok: false, error: e.message })
    })
  })
}

// ── IPC ────────────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('pos:info', () => ({
    desktop: true, version: app.getVersion(),
    platform: process.platform, arch: process.arch,
    serial: !!SerialPort, settings: readSettings(),
  }))

  ipcMain.handle('pos:listPrinters', async () => {
    try { return await mainWindow.webContents.getPrintersAsync() } catch { return [] }
  })

  ipcMain.handle('pos:listSerialPorts', () => listSerialPorts())

  ipcMain.handle('pos:printRaw', async (_e, { bytes, portPath, baudRate }) => {
    let target = portPath || readSettings().printerPort
    if (!target) {
      // Auto-pick only a port that actually looks like a printer or a USB
      // bridge. A score of 0 means we recognised nothing about it, and blindly
      // writing receipt bytes into an unrelated COM device (a modem, a scale,
      // a debug console) is worse than asking the operator to choose.
      const ports = await listSerialPorts()
      const best = ports.find(p => p.score >= 1)
      if (!best) {
        return {
          ok: false,
          error: ports.length
            ? 'Could not identify the printer. Pick the port in Receipt Printer settings.'
            : 'No serial port found for the printer',
          ports,
        }
      }
      target = best.path
      writeSettings({ printerPort: target })
    }
    if (!target) return { ok: false, error: 'No serial port found for the printer' }
    return writeSerial(target, baudRate || readSettings().printerBaud || 9600, bytes)
  })

  ipcMain.handle('pos:printSilent', (_e, { html, deviceName, widthMicrons }) =>
    printSilentHTML(html, { deviceName: deviceName || readSettings().printerName, widthMicrons }))

  ipcMain.handle('pos:getDisplays', () => {
    const primary = screen.getPrimaryDisplay()
    return screen.getAllDisplays().map(d => ({
      id: d.id, primary: d.id === primary.id,
      width: d.bounds.width, height: d.bounds.height, scale: d.scaleFactor,
    }))
  })

  ipcMain.handle('pos:openCustomerDisplay', (_e, { regId } = {}) => openCustomerWindow(regId))
  ipcMain.handle('pos:closeCustomerDisplay', () => {
    if (customerWindow && !customerWindow.isDestroyed()) customerWindow.close()
    return { ok: true }
  })

  ipcMain.handle('pos:setSettings', (_e, patch) => writeSettings(patch || {}))

  ipcMain.handle('pos:setKiosk', (_e, on) => {
    writeSettings({ kiosk: !!on })
    if (mainWindow) { mainWindow.setKiosk(!!on); mainWindow.setFullScreen(!!on) }
    return { ok: true, kiosk: !!on }
  })

  ipcMain.handle('pos:setAutoLaunch', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on, path: process.execPath })
    writeSettings({ autoLaunch: !!on })
    return { ok: true, autoLaunch: !!on }
  })

  ipcMain.handle('pos:relaunch', () => { app.relaunch(); app.exit(0) })
}

// ── lifecycle ──────────────────────────────────────────────────────────────
// Two copies of a till fighting over one printer and one cart is a real hazard.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })

  app.whenReady().then(() => {
    registerIpc()
    createMainWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
  })

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
