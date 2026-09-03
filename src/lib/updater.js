import { isDesktop } from './desktop'

/**
 * Renderer-side update bridge.
 *
 * Every call is a no-op on the web build, so the same bundle still runs at
 * admin.bedtimehome.com unchanged.
 *
 * The one rule that matters here: the POS tells the main process when a sale is
 * open, and the main process refuses to restart while it is. An update must
 * never cost a transaction.
 */
const api = () => (typeof window !== 'undefined' ? window.posDesktop : null)

export const updatesSupported = () => isDesktop() && typeof api()?.onUpdateState === 'function'

export async function getUpdateState() {
  const d = api(); if (!d?.updateState) return null
  try { return await d.updateState() } catch { return null }
}

/** Subscribe to update progress. Returns an unsubscribe function. */
export function onUpdateState(cb) {
  const d = api()
  if (!d?.onUpdateState) return () => {}
  try { return d.onUpdateState(cb) } catch { return () => {} }
}

export async function checkForUpdates() {
  const d = api(); if (!d?.checkForUpdates) return { ok: false }
  try { return await d.checkForUpdates() } catch (e) { return { ok: false, error: String(e) } }
}

/** Restart into the new version. Rejected by main while a sale is open. */
export async function installUpdate(opts = {}) {
  const d = api(); if (!d?.installUpdate) return { ok: false }
  try { return await d.installUpdate(opts) } catch (e) { return { ok: false, error: String(e) } }
}

/** Report whether a transaction is in progress. Safe to call on the web. */
export async function reportBusy(busy) {
  const d = api(); if (!d?.setBusy) return
  try { await d.setBusy(busy) } catch {}
}
