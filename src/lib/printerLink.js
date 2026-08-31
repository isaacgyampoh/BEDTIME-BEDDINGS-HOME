/**
 * Transport to a built-in POS printer that Windows has not installed.
 *
 * Web Serial and WebUSB both require:
 *   - a secure origin (admin.bedtimehome.com is HTTPS)
 *   - a one-time user gesture to pick the device
 * After that the browser remembers the grant for this origin, so the terminal
 * is paired once at install and reconnects silently on every boot.
 *
 * WebUSB only works while no Windows driver has claimed the device. That is
 * usually a problem — here it is the opposite: this machine has no driver,
 * which is exactly why WebUSB is available to us.
 */

const BAUD_KEY = 'pos-printer-baud'
const LINK_KEY = 'pos-printer-link'   // 'serial' | 'usb' | '' (none)

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200]

export function getBaud() {
  try { return Number(localStorage.getItem(BAUD_KEY)) || 9600 } catch { return 9600 }
}
export function setBaud(b) {
  try { localStorage.setItem(BAUD_KEY, String(b)) } catch {}
}
export function getLinkType() {
  try { return localStorage.getItem(LINK_KEY) || '' } catch { return '' }
}
function setLinkType(t) {
  try { t ? localStorage.setItem(LINK_KEY, t) : localStorage.removeItem(LINK_KEY) } catch {}
}

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator
export const usbSupported = () => typeof navigator !== 'undefined' && 'usb' in navigator
export const directSupported = () => serialSupported() || usbSupported()

let serialPort = null
let usbDevice = null
let usbEndpoint = null

// ── Web Serial ──────────────────────────────────────────────────────────────
async function openSerial(port) {
  if (port.readable || port.writable) return port  // already open
  await port.open({ baudRate: getBaud(), dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' })
  return port
}

/** Ask the operator to pick the printer's COM port. Needs a user gesture. */
export async function pairSerial() {
  if (!serialSupported()) throw new Error('This browser has no Web Serial support')
  const port = await navigator.serial.requestPort()
  await openSerial(port)
  serialPort = port
  setLinkType('serial')
  return true
}

/** Reconnect to an already-granted port, without any prompt. */
async function restoreSerial() {
  if (!serialSupported()) return false
  const ports = await navigator.serial.getPorts()
  if (!ports.length) return false
  serialPort = await openSerial(ports[0])
  return true
}

async function writeSerial(bytes) {
  if (!serialPort) throw new Error('No serial port')
  const writer = serialPort.writable.getWriter()
  try {
    // Cheap heads have small buffers; feed them in chunks so nothing is dropped.
    const CHUNK = 512
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await writer.write(bytes.slice(i, i + CHUNK))
    }
  } finally {
    writer.releaseLock()
  }
}

// ── WebUSB ──────────────────────────────────────────────────────────────────
async function claimUsb(device) {
  if (!device.opened) await device.open()
  if (device.configuration === null) await device.selectConfiguration(1)

  // USB printer class is 0x07. Find its bulk OUT endpoint.
  for (const cfg of device.configurations) {
    for (const iface of cfg.interfaces) {
      for (const alt of iface.alternates) {
        if (alt.interfaceClass !== 0x07) continue
        const out = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk')
        if (!out) continue
        try { await device.claimInterface(iface.interfaceNumber) } catch { continue }
        usbEndpoint = out.endpointNumber
        return true
      }
    }
  }
  throw new Error('No USB printer interface found on that device')
}

/** Ask the operator to pick the printer as a USB device. Needs a user gesture. */
export async function pairUsb() {
  if (!usbSupported()) throw new Error('This browser has no WebUSB support')
  const device = await navigator.usb.requestDevice({ filters: [{ classCode: 0x07 }] })
  await claimUsb(device)
  usbDevice = device
  setLinkType('usb')
  return true
}

async function restoreUsb() {
  if (!usbSupported()) return false
  const devices = await navigator.usb.getDevices()
  if (!devices.length) return false
  usbDevice = devices[0]
  await claimUsb(usbDevice)
  return true
}

async function writeUsb(bytes) {
  if (!usbDevice || usbEndpoint == null) throw new Error('No USB printer')
  const CHUNK = 512
  for (let i = 0; i < bytes.length; i += CHUNK) {
    await usbDevice.transferOut(usbEndpoint, bytes.slice(i, i + CHUNK))
  }
}

// ── unified ─────────────────────────────────────────────────────────────────
export function isLinked() {
  return !!(serialPort || usbDevice)
}

/**
 * Reconnect to a previously paired printer. Safe to call on every boot: it
 * never prompts, and returns false when nothing has been paired yet.
 */
export async function restoreLink() {
  if (isLinked()) return true
  const kind = getLinkType()
  try {
    if (kind === 'usb') return await restoreUsb()
    if (kind === 'serial') return await restoreSerial()
    // Nothing recorded — try serial then usb, in case storage was cleared.
    return (await restoreSerial()) || (await restoreUsb())
  } catch (e) {
    console.warn('printer reconnect failed:', e)
    return false
  }
}

/** Send raw ESC/POS bytes. Returns true when the printer accepted them. */
export async function sendBytes(bytes) {
  if (!isLinked() && !(await restoreLink())) return false
  try {
    if (usbDevice) await writeUsb(bytes)
    else await writeSerial(bytes)
    return true
  } catch (e) {
    console.error('printer write failed:', e)
    // A yanked cable or a sleeping port leaves a stale handle: drop it so the
    // next attempt re-opens instead of failing forever.
    serialPort = null; usbDevice = null; usbEndpoint = null
    return false
  }
}

export async function unlink() {
  try { if (serialPort) await serialPort.close() } catch {}
  try { if (usbDevice) await usbDevice.close() } catch {}
  serialPort = null; usbDevice = null; usbEndpoint = null
  setLinkType('')
}

/** Human-readable description of what we are connected to. */
export function linkLabel() {
  if (usbDevice) return `USB · ${usbDevice.productName || 'thermal printer'}`
  if (serialPort) {
    const info = serialPort.getInfo?.() || {}
    return info.usbVendorId
      ? `Serial · VID ${info.usbVendorId.toString(16)}:${(info.usbProductId || 0).toString(16)}`
      : 'Serial port'
  }
  return 'Not connected'
}
