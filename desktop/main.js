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

// electron-updater is optional at runtime: if it cannot load, the POS must
// still open and sell. An update mechanism is never allowed to be the reason
// a till will not start.
let autoUpdater = null
try { ({ autoUpdater } = require('electron-updater')) }
catch (e) { console.warn('electron-updater unavailable, updates disabled:', e.message) }

// serialport is a native module. If it fails to load (missing prebuild on an
// unusual machine) the app must still run — printing simply falls back.
const serial = require('./serial')
const { listSerialPorts, writeSerial, readPrinterStatus } = serial
const raster = require('./raster')

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


/**
 * Software "printers" that Windows installs by default. Sending a receipt to
 * one of these succeeds — into a OneNote page or a PDF nobody opens — so it
 * reports a successful print with nothing on paper.
 */
const VIRTUAL_PRINTER = /onenote|pdf|xps|fax|document writer|send to/i

function printSilentHTML(html, { deviceName, widthMicrons = 80000 } = {}) {
  // Never print to an unnamed queue. Electron sends `deviceName: undefined` to
  // the Windows DEFAULT printer, which on these tills is OneNote or Print to
  // PDF: the call succeeds, the app reported "printed", and no paper moved.
  if (!deviceName) return Promise.resolve({ ok: false, error: null })
  if (VIRTUAL_PRINTER.test(deviceName)) {
    return Promise.resolve({ ok: false, error: `"${deviceName}" is not a real printer.` })
  }
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

// ── updates ────────────────────────────────────────────────────────────────
/**
 * Update policy, in order of importance:
 *
 *   1. Never interrupt a sale. The renderer reports whether a transaction is
 *      in progress; we refuse to restart while it is, and install on the next
 *      natural quit instead.
 *   2. Never block selling. Every failure path here is caught and reported to
 *      the renderer as information, never as a blocking dialog.
 *   3. Download quietly, install deliberately. The download happens in the
 *      background; restarting is always the operator's decision.
 */
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000   // 6 hours
const FIRST_CHECK_DELAY = 30 * 1000                // let the till finish loading

let updateState = { status: 'idle', version: null, notes: null, error: null, progress: 0 }
let transactionBusy = false        // set by the renderer
let updateTimer = null

function sendUpdate(patch) {
  updateState = { ...updateState, ...patch }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) { try { w.webContents.send('pos:update-state', updateState) } catch {} }
  }
}

function initUpdater() {
  if (!autoUpdater) { updateState.status = 'unsupported'; return }
  // Unpackaged runs have no update path; checking would only log noise.
  if (!app.isPackaged) { updateState.status = 'dev'; return }

  autoUpdater.autoDownload = true              // fetch quietly once found
  autoUpdater.autoInstallOnAppQuit = true      // safest install moment there is
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking', error: null }))
  autoUpdater.on('update-not-available', () => sendUpdate({ status: 'current', version: null }))
  autoUpdater.on('update-available', (info) =>
    sendUpdate({ status: 'downloading', version: info?.version || null, notes: info?.releaseNotes || null, progress: 0 }))
  autoUpdater.on('download-progress', (p) =>
    sendUpdate({ status: 'downloading', progress: Math.round(p?.percent || 0) }))
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdate({ status: 'ready', version: info?.version || null, notes: info?.releaseNotes || null, progress: 100 }))
  autoUpdater.on('error', (err) => {
    // No internet, GitHub down, bad metadata, interrupted download — all land
    // here, and all are non-fatal. The POS carries on.
    console.warn('update error:', err?.message)
    sendUpdate({ status: 'error', error: String(err?.message || err) })
  })

  const check = () => {
    try { autoUpdater.checkForUpdates().catch(e => console.warn('update check failed:', e?.message)) }
    catch (e) { console.warn('update check threw:', e?.message) }
  }
  setTimeout(check, FIRST_CHECK_DELAY)
  updateTimer = setInterval(check, UPDATE_CHECK_INTERVAL)
}

/** Restart into the new version. Refuses while a sale is in progress. */
function installUpdate({ force = false } = {}) {
  if (!autoUpdater) return { ok: false, error: 'Updates are not available in this build' }
  if (updateState.status !== 'ready') return { ok: false, error: 'No update is ready to install' }
  if (transactionBusy && !force) {
    return { ok: false, busy: true,
      error: 'A sale is in progress. The update will be installed when the POS is next closed.' }
  }
  // isSilent=true, isForceRunAfter=true — reinstall without a wizard and come
  // straight back up, so the till is only down for a few seconds.
  setImmediate(() => { try { autoUpdater.quitAndInstall(true, true) } catch (e) { console.error('quitAndInstall:', e) } })
  return { ok: true }
}

// ── IPC ────────────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('pos:info', () => ({
    desktop: true, version: app.getVersion(), packaged: app.isPackaged,
    platform: process.platform, arch: process.arch,
    serial: serial.available, settings: readSettings(),
  }))

  ipcMain.handle('pos:listPrinters', async () => {
    // Real queues only. Listing OneNote and Print to PDF as "Windows printers"
    // invited someone to pick one.
    try {
      const all = await mainWindow.webContents.getPrintersAsync()
      return all.filter(p => !VIRTUAL_PRINTER.test(`${p.name} ${p.displayName || ''}`))
    } catch { return [] }
  })

  ipcMain.handle('pos:listSerialPorts', () => listSerialPorts())

  ipcMain.handle('pos:printRaw', async (_e, { bytes, portPath, baudRate }) => {
    const cfg = readSettings()
    let target = portPath || cfg.printerPort
    let baud = baudRate || cfg.printerBaud
    if (!target) {
      // Nothing chosen yet: find it by asking, rather than guessing from the
      // USB description (which rejected the plain COM port these tills use).
      const found = await serial.findPrinter({ readSettings, writeSettings })
      if (!found.ok) return { ok: false, error: found.error, needsSetup: true }
      target = found.port; baud = found.baud
    }
    const r = await writeSerial(target, baud || 9600, bytes)
    if (!r.ok) {
      return { ok: false, port: target, baud: baud || 9600,
        error: `Could not print on ${target}: ${r.error}. Check the printer is on, or open Receipt Printer to choose a different port.` }
    }
    return { ok: true, port: target, baud: baud || 9600 }
  })

  // Any HTML document (delivery label, stock sheet) on the thermal head, laid
  // out offscreen and sent as a raster image. See raster.js for why these
  // cannot go as ESC/POS text.
  ipcMain.handle('pos:printHtml', async (_e, { html, paper }) => {
    const cfg = readSettings()
    let target = cfg.printerPort, baud = cfg.printerBaud
    if (!target) {
      const found = await serial.findPrinter({ readSettings, writeSettings })
      if (!found.ok) return { ok: false, error: found.error, needsSetup: true }
      target = found.port; baud = found.baud
    }
    let out
    try { out = await raster.htmlToEscPos(html, paper === '58' ? '58' : '80') }
    catch (e) { return { ok: false, error: 'Could not lay out the page for printing: ' + e.message } }
    const r = await writeSerial(target, baud || 9600, out.bytes)
    if (!r.ok) return { ok: false, error: `Could not print on ${target}: ${r.error}. Check the printer is on, or open Receipt Printer to choose a different port.` }
    return { ok: true, port: target, baud: baud || 9600 }
  })

  ipcMain.handle('pos:findPrinter', () => serial.findPrinter({ readSettings, writeSettings }))


  ipcMain.handle('pos:printerStatus', async (_e, { portPath, baudRate } = {}) => {
    const cfg = readSettings()
    const path = portPath || cfg.printerPort
    if (!path) return { ok: false, error: 'No printer port is set' }
    return readPrinterStatus(path, baudRate || cfg.printerBaud)
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

  // ── updates ──
  ipcMain.handle('pos:updateState', () => updateState)
  ipcMain.handle('pos:checkForUpdates', () => {
    if (!autoUpdater || !app.isPackaged) return { ok: false, status: updateState.status }
    try { autoUpdater.checkForUpdates().catch(() => {}); return { ok: true } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  })
  ipcMain.handle('pos:installUpdate', (_e, opts) => installUpdate(opts || {}))
  // The renderer is the only thing that knows a sale is open.
  ipcMain.handle('pos:setBusy', (_e, busy) => { transactionBusy = !!busy; return { ok: true, busy: transactionBusy } })
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
    initUpdater()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
  })

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', () => { if (updateTimer) clearInterval(updateTimer) })
}
