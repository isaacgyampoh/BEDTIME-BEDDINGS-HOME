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

  // Displays
  getDisplays:       () => ipcRenderer.invoke('pos:getDisplays'),
  openCustomerDisplay:  (regId) => ipcRenderer.invoke('pos:openCustomerDisplay', { regId }),
  closeCustomerDisplay: () => ipcRenderer.invoke('pos:closeCustomerDisplay'),

  // Terminal settings
  setSettings:       (patch) => ipcRenderer.invoke('pos:setSettings', patch),
  setKiosk:          (on) => ipcRenderer.invoke('pos:setKiosk', !!on),
  setAutoLaunch:     (on) => ipcRenderer.invoke('pos:setAutoLaunch', !!on),
  relaunch:          () => ipcRenderer.invoke('pos:relaunch'),
})
