import { useState, useEffect } from 'react'
import Modal from './Modal'
import {
  PAPER, getPaperWidth, setPaperWidth,
  getAutoPrint, setAutoPrint, printTestPage,
} from '../lib/printer'
import {
  pairSerial, pairUsb, unlink, isLinked, restoreLink, linkLabel,
  serialSupported, usbSupported, directSupported,
  BAUD_RATES, getBaud, setBaud,
} from '../lib/printerLink'
import {
  isDesktop, desktopInfo, listSerialPorts, listPrinters,
  saveTerminalSettings, setKiosk, setAutoLaunch,
} from '../lib/desktop'
import toast from 'react-hot-toast'

// Defined at module scope on purpose: a component created inside render is a
// new type on every render, so React unmounts and remounts it each time.
const Choice = ({ active, onClick, title, sub }) => (
  <button onClick={onClick}
    className={`flex-1 min-w-[130px] rounded-2xl border-2 p-3.5 text-left transition active:scale-[.98] ${
      active ? 'border-[#16181d] bg-[#16181d] text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}>
    <div className="text-[14px] font-bold">{title}</div>
    <div className={`text-[11px] mt-0.5 ${active ? 'text-white/60' : 'text-gray-400'}`}>{sub}</div>
  </button>
)

/**
 * Per-terminal printer setup. Paper width in particular MUST be set per
 * machine: an 80mm layout sent to a 58mm printer loses the right-hand column,
 * which is the amount column — the receipt prints without prices.
 */
export default function PrinterSettings({ open, onClose }) {
  const [paper, setPaper] = useState(getPaperWidth)
  const [auto, setAuto] = useState(getAutoPrint)
  const [baud, setBaudState] = useState(getBaud)
  const [testing, setTesting] = useState(false)
  const [linked, setLinked] = useState(false)
  const [label, setLabel] = useState('Not connected')
  const [pairing, setPairing] = useState(false)
  const desktop = isDesktop()
  const [ports, setPorts] = useState([])
  const [queues, setQueues] = useState([])
  const [term, setTerm] = useState(null)

  // Reconnect silently to a printer paired earlier on this terminal.
  useEffect(() => {
    if (!open) return
    let live = true
    restoreLink().then(ok => { if (live) { setLinked(ok); setLabel(linkLabel()) } })
    // In the desktop app the machine can tell us what is actually attached,
    // instead of asking the operator to pick a port out of a browser dialog.
    if (desktop) {
      Promise.all([desktopInfo(), listSerialPorts(), listPrinters()]).then(([i, p, q]) => {
        if (!live) return
        setTerm(i); setPorts(p || []); setQueues(q || [])
      })
    }
    return () => { live = false }
  }, [open, desktop])

  const choosePaper = (w) => { setPaper(w); setPaperWidth(w); toast.success(`Paper set to ${w}mm`) }
  const chooseAuto = (m) => { setAuto(m); setAutoPrint(m) }
  const chooseBaud = (b) => { setBaudState(b); setBaud(b) }

  const pair = async (kind) => {
    setPairing(true)
    try {
      await (kind === 'usb' ? pairUsb() : pairSerial())
      setLinked(true); setLabel(linkLabel())
      toast.success('Printer connected')
    } catch (e) {
      // Cancelling the browser's device picker is normal, not an error.
      const msg = String(e?.message || e)
      if (!/No port selected|No device selected|cancelled/i.test(msg)) toast.error(msg)
    } finally { setPairing(false) }
  }

  const disconnect = async () => {
    await unlink(); setLinked(false); setLabel(linkLabel()); toast('Printer disconnected')
  }

  const testPrint = async () => {
    setTesting(true)
    const { ok, via } = await printTestPage({ paper })
    setTesting(false)
    if (!ok) toast.error('Could not reach the printer. Check it is on and has paper.')
    else if (via === 'browser') toast('Sent to the Windows printer dialog')
    else toast.success('Sent to the built-in printer')
  }

  return (
    <Modal open={open} onClose={onClose} title="Receipt Printer"
      footer={<>
        <button onClick={onClose} className="h-12 px-5 border border-stone-300 rounded-xl text-sm font-semibold text-stone-600">Close</button>
        <button onClick={testPrint} disabled={testing}
          className="flex-1 h-12 bg-[#16181d] text-white rounded-xl text-sm font-bold disabled:opacity-50 active:scale-[.98] transition">
          {testing ? 'Printing…' : 'Print test page'}
        </button>
      </>}>
      <div className="space-y-6">

        {desktop && (
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-2.5">This terminal</label>
            <div className="rounded-2xl border-2 border-green-500 bg-green-50 p-3.5 mb-2.5">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-bold text-gray-900">Desktop app</div>
                  <div className="text-[11px] text-gray-500">
                    v{term?.version || '—'} · prints without a driver or a dialog
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-gray-200 bg-white p-3.5 mb-2.5">
              <div className="text-[12px] font-bold text-gray-700 mb-1.5">Detected printer ports</div>
              {ports.length === 0
                ? <div className="text-[12px] text-gray-400">No serial ports found. Check the printer cable inside the machine.</div>
                : ports.map((p, i) => (
                    <button key={p.path} onClick={async () => { await saveTerminalSettings({ printerPort: p.path }); toast.success('Using ' + p.path) }}
                      className="w-full flex items-center justify-between gap-2 py-2 border-b border-gray-50 last:border-0 text-left">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-gray-800">{p.path}</div>
                        <div className="text-[11px] text-gray-400 truncate">{p.friendlyName || p.manufacturer || 'Serial device'}</div>
                      </div>
                      {i === 0 && <span className="text-[10px] font-bold text-green-700 bg-green-100 px-2 py-0.5 rounded-full flex-shrink-0">BEST MATCH</span>}
                    </button>
                  ))}
              {queues.length > 0 && (
                <div className="mt-2.5 pt-2.5 border-t border-gray-100">
                  <div className="text-[12px] font-bold text-gray-700 mb-1">Windows printers</div>
                  <div className="text-[11px] text-gray-500">{queues.map(q => q.displayName || q.name).join(', ')}</div>
                </div>
              )}
            </div>

            <div className="flex gap-2.5 flex-wrap">
              <button onClick={async () => { const r = await setKiosk(!(term?.settings?.kiosk !== false)); setTerm(t => ({ ...t, settings: { ...t?.settings, kiosk: r?.kiosk } })) }}
                className="flex-1 min-w-[140px] h-11 rounded-xl border border-gray-300 text-[13px] font-semibold text-gray-700">
                {term?.settings?.kiosk === false ? 'Enable kiosk mode' : 'Exit kiosk mode'}
              </button>
              <button onClick={async () => { const r = await setAutoLaunch(!term?.settings?.autoLaunch); setTerm(t => ({ ...t, settings: { ...t?.settings, autoLaunch: r?.autoLaunch } })); toast.success(r?.autoLaunch ? 'Will start on boot' : 'Will not start on boot') }}
                className="flex-1 min-w-[140px] h-11 rounded-xl border border-gray-300 text-[13px] font-semibold text-gray-700">
                {term?.settings?.autoLaunch ? 'Do not start on boot' : 'Start on boot'}
              </button>
            </div>
          </div>
        )}

        {/* Browser fallback: only shown when NOT in the desktop app, where the
            operator must pair the printer by hand. */}
        {!desktop && (
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-2.5">Built-in printer</label>

          <div className={`rounded-2xl border-2 p-3.5 mb-2.5 ${linked ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white'}`}>
            <div className="flex items-center gap-2.5">
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${linked ? 'bg-green-500' : 'bg-gray-300'}`} />
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-bold text-gray-900">{linked ? 'Connected' : 'Not connected'}</div>
                <div className="text-[11px] text-gray-500 truncate">{label}</div>
              </div>
              {linked && (
                <button onClick={disconnect} className="text-[12px] font-semibold text-gray-500 hover:text-red-500 px-2">
                  Disconnect
                </button>
              )}
            </div>
          </div>

          {!directSupported() && (
            <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
              This browser cannot talk to the printer directly. Use Google Chrome
              or Microsoft Edge on the terminal.
            </p>
          )}

          {directSupported() && !linked && (
            <div className="flex gap-2.5 flex-wrap">
              {serialSupported() && (
                <button onClick={() => pair('serial')} disabled={pairing}
                  className="flex-1 min-w-[130px] h-12 rounded-xl bg-[#16181d] text-white text-[13px] font-bold disabled:opacity-50 active:scale-[.98] transition">
                  Connect via COM port
                </button>
              )}
              {usbSupported() && (
                <button onClick={() => pair('usb')} disabled={pairing}
                  className="flex-1 min-w-[130px] h-12 rounded-xl border-2 border-[#16181d] text-[#16181d] text-[13px] font-bold disabled:opacity-50 active:scale-[.98] transition">
                  Connect via USB
                </button>
              )}
            </div>
          )}
          <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
            Pick the printer once. This terminal remembers it, so it reconnects
            on its own from then on. Try COM port first; if the list is empty,
            try USB.
          </p>
        </div>
        )}

        {!desktop && serialSupported() && !linked && (
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-2.5">COM port speed</label>
            <div className="flex gap-2 flex-wrap">
              {BAUD_RATES.map(b => (
                <button key={b} onClick={() => chooseBaud(b)}
                  className={`h-11 px-3.5 rounded-xl border-2 text-[13px] font-semibold transition ${
                    baud === b ? 'border-[#16181d] bg-[#16181d] text-white' : 'border-gray-200 bg-white text-gray-600'}`}>
                  {b}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              Almost all of these printers are 9600. Only change this if the test
              page prints garbled characters.
            </p>
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-2.5">Paper width</label>
          <div className="flex gap-2.5 flex-wrap">
            <Choice active={paper === '80'} onClick={() => choosePaper('80')}
              title="80 mm" sub={`prints ${PAPER['80'].width} wide`} />
            <Choice active={paper === '58'} onClick={() => choosePaper('58')}
              title="58 mm" sub={`prints ${PAPER['58'].width} wide`} />
          </div>
          <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
            Measure the roll in the machine. If the test page cuts off the amounts
            on the right, this is set too wide.
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-2.5">Print automatically after a sale</label>
          <div className="flex gap-2.5 flex-wrap">
            <Choice active={auto === 'all'} onClick={() => chooseAuto('all')} title="Every sale" sub="cash, MoMo and split" />
            <Choice active={auto === 'cash'} onClick={() => chooseAuto('cash')} title="Cash only" sub="MoMo prints on request" />
            <Choice active={auto === 'off'} onClick={() => chooseAuto('off')} title="Never" sub="print button only" />
          </div>
        </div>

        <div className="bg-[#f6f6f5] border border-gray-200 rounded-xl p-4">
          <div className="text-[13px] font-bold text-gray-800 mb-1.5">
            {linked ? 'Printing directly' : 'If the printer will not connect'}
          </div>
          <p className="text-[12px] text-gray-500 leading-relaxed">
            {linked
              ? 'Receipts go straight to the built-in printer. No Windows driver, no print dialog, and the paper is cut automatically.'
              : 'Without a direct connection the app falls back to the Windows print dialog, which can only see printers Windows has installed. If the built-in printer is missing from that list, install its driver in Windows Settings, or connect it directly above.'}
          </p>
        </div>

      </div>
    </Modal>
  )
}
