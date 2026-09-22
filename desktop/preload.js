/**
 * The only bridge between the web app and the machine.
 *
 * Everything is an explicit, named channel — the renderer never gets `require`,
 * `fs`, `child_process` or a raw ipcRenderer. Adding a capability means adding
 * a line here on purpose, which is the point.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('posDesktop', {
  /** Present only inside the desktop app, so the web build can feature-detect. */
  isDesktop: true,

  info:              () => ipcRenderer.invoke('pos:info'),

  // Printing
  listPrinters:      () => ipcRenderer.invoke('pos:listPrinters'),
  listSerialPorts:   () => ipcRenderer.invoke('pos:listSerialPorts'),
  /** bytes: number[] — ESC/POS. Arrays cross the bridge; Uint8Array does not. */
  printRaw:          (bytes, opts = {}) => ipcRenderer.invoke('pos:printRaw', { bytes: Array.from(bytes), ...opts }),
  printSilent:       (html, opts = {}) => ipcRenderer.invoke('pos:printSilent', { html, ...opts }),
  printerStatus:     (opts = {}) => ipcRenderer.invoke('pos:printerStatus', opts),
  findPrinter:       () => ipcRenderer.invoke('pos:findPrinter'),

  // Displays
  getDisplays:       () => ipcRenderer.invoke('pos:getDisplays'),
  openCustomerDisplay:  (regId) => ipcRenderer.invoke('pos:openCustomerDisplay', { regId }),
  closeCustomerDisplay: () => ipcRenderer.invoke('pos:closeCustomerDisplay'),

  // Terminal settings
  setSettings:       (patch) => ipcRenderer.invoke('pos:setSettings', patch),

  // Updates
  updateState:       () => ipcRenderer.invoke('pos:updateState'),
  checkForUpdates:   () => ipcRenderer.invoke('pos:checkForUpdates'),
  installUpdate:     (opts) => ipcRenderer.invoke('pos:installUpdate', opts || {}),
  /** Tell the main process a sale is open, so it will not restart mid-transaction. */
  setBusy:           (busy) => ipcRenderer.invoke('pos:setBusy', !!busy),
  /** Subscribe to update progress. Returns an unsubscribe function. */
  onUpdateState: (cb) => {
    if (typeof cb !== 'function') return () => {}
    // Only the payload crosses the bridge — never the ipcRenderer event object,
    // which would hand the renderer a channel it could send on.
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('pos:update-state', handler)
    return () => ipcRenderer.removeListener('pos:update-state', handler)
  },
  setKiosk:          (on) => ipcRenderer.invoke('pos:setKiosk', !!on),
  setAutoLaunch:     (on) => ipcRenderer.invoke('pos:setAutoLaunch', !!on),
  relaunch:          () => ipcRenderer.invoke('pos:relaunch'),
})
