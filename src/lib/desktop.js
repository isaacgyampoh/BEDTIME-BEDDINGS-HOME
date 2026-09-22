/**
 * Desktop-app bridge.
 *
 * The same build runs in a browser and inside the Electron shell. Everything
 * here degrades to a no-op on the web, so no call site needs to branch: the
 * browser paths that already exist stay exactly as they are.
 *
 * What the desktop app adds, and why it matters on this hardware:
 *   - ESC/POS straight to a COM port with no Windows driver and no permission
 *     prompt. The built-in head on these tills is not a Windows printer, which
 *     is why the browser's print dialog had nothing to offer.
 *   - Silent printing to a real Windows printer, when one exists.
 *   - The customer screen placed on the actual second monitor.
 */

const api = () => (typeof window !== 'undefined' ? window.posDesktop : null)

/** True only inside the Electron shell. */
export const isDesktop = () => !!api()?.isDesktop

export async function desktopInfo() {
  const d = api(); if (!d) return null
  try { return await d.info() } catch { return null }
}

/**
 * Ask the receipt printer why it is not printing.
 *
 * A thermal head that is out of paper, or whose cover is not latched, throws
 * away everything sent to it without complaining — so the app reports a
 * successful print and nothing comes out. This asks it directly.
 *
 * Returns null on the web, and `{ supported: false }` for the many cheap heads
 * that do not answer. Never a reason to skip printing — only something to say.
 */
export async function printerStatus(opts = {}) {
  const d = api(); if (!d?.printerStatus) return null
  try { return await d.printerStatus(opts) } catch { return null }
}

/** Windows print queues, if any are installed. */
export async function listPrinters() {
  const d = api(); if (!d) return []
  try { return await d.listPrinters() } catch { return [] }
}

/** COM ports, most printer-like first. */
export async function listSerialPorts() {
  const d = api(); if (!d) return []
  try { return await d.listSerialPorts() } catch { return [] }
}

/**
 * Send ESC/POS bytes to the till's printer.
 * Returns false on the web so the caller falls back to its existing path.
 */
/**
 * Send ESC/POS bytes to the till's printer.
 *
 * Returns { ok, error } rather than a bare boolean. The reason a print failed
 * used to go to console.warn and nowhere else, so the cashier saw "nothing
 * happened" while the app knew exactly why.
 */
export async function printRaw(bytes, opts = {}) {
  const d = api(); if (!d) return { ok: false, error: 'Not running in the desktop app' }
  try {
    const r = await d.printRaw(bytes, opts)
    if (!r?.ok) console.warn('desktop printRaw:', r?.error)
    return { ok: !!r?.ok, error: r?.error || null, port: r?.port, baud: r?.baud, needsSetup: !!r?.needsSetup }
  } catch (e) {
    console.warn('desktop printRaw threw:', e)
    return { ok: false, error: 'The desktop printer bridge did not respond. Restart the app.' }
  }
}

/** Print HTML with no dialog, to a named Windows printer. */
export async function printSilent(html, opts = {}) {
  const d = api(); if (!d) return { ok: false, error: null }
  try {
    const r = await d.printSilent(html, opts)
    if (!r?.ok) console.warn('desktop printSilent:', r?.error)
    return { ok: !!r?.ok, error: r?.error || null }
  } catch { return { ok: false, error: null } }
}

/**
 * Print a whole HTML document (label, stock sheet) on the till's head, as an
 * image. Returns { ok, error }, or null outside the desktop app.
 */
export async function printHtml(html, opts = {}) {
  const d = api(); if (!d?.printHtml) return null
  try {
    const r = await d.printHtml(html, opts)
    if (!r?.ok) console.warn('desktop printHtml:', r?.error)
    return { ok: !!r?.ok, error: r?.error || null }
  } catch (e) {
    console.warn('desktop printHtml threw:', e)
    return { ok: false, error: 'The desktop printer bridge did not respond. Restart the app.' }
  }
}

/** Search every COM port at every speed for a printer that answers. */
export async function findPrinter() {
  const d = api(); if (!d?.findPrinter) return null
  try { return await d.findPrinter() } catch { return { ok: false, error: 'The search could not run. Restart the app.' } }
}

export async function getDisplays() {
  const d = api(); if (!d) return []
  try { return await d.getDisplays() } catch { return [] }
}

export async function openCustomerDisplay(regId) {
  const d = api(); if (!d) return { ok: false }
  try { return await d.openCustomerDisplay(regId) } catch (e) { return { ok: false, error: String(e) } }
}

export async function saveTerminalSettings(patch) {
  const d = api(); if (!d) return null
  try { return await d.setSettings(patch) } catch { return null }
}

export async function setKiosk(on) {
  const d = api(); if (!d) return null
  try { return await d.setKiosk(on) } catch { return null }
}

export async function setAutoLaunch(on) {
  const d = api(); if (!d) return null
  try { return await d.setAutoLaunch(on) } catch { return null }
}
