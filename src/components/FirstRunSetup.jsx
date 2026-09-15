import { useEffect, useState } from 'react'
import { isDesktop, desktopInfo, listSerialPorts } from '../lib/desktop'
import PrinterSettings from './PrinterSettings'

const DONE_KEY = 'pos-first-run-done'

/**
 * One-time setup nudge on a freshly installed terminal.
 *
 * Without this, a new install opens straight into the POS with no printer
 * configured, and nothing on screen says so — the first receipt simply fails
 * and whoever is at the till has no idea the setting exists. This appears once,
 * points at the one thing that needs doing, and never shows again.
 */
export default function FirstRunSetup() {
  const [show, setShow] = useState(false)
  const [ports, setPorts] = useState([])
  const [openSettings, setOpenSettings] = useState(false)

  useEffect(() => {
    if (!isDesktop()) return
    try { if (localStorage.getItem(DONE_KEY) === '1') return } catch { return }

    let live = true
    ;(async () => {
      const info = await desktopInfo()
      // Only nag when a printer genuinely has not been chosen yet.
      if (!live || info?.settings?.printerPort) { markDone(); return }
      const p = await listSerialPorts()
      if (!live) return
      setPorts(p || [])
      setShow(true)
    })()
    return () => { live = false }
  }, [])

  const markDone = () => { try { localStorage.setItem(DONE_KEY, '1') } catch {} }
  const dismiss = () => { markDone(); setShow(false) }

  if (!show) return null

  const best = ports[0]

  return (
    <>
      <PrinterSettings open={openSettings} onClose={() => { setOpenSettings(false); dismiss() }} />

      <div className="fixed inset-0 z-[520] flex items-center justify-center px-5">
        <div className="absolute inset-0 bg-black/60" onClick={dismiss} />
        <div className="relative bg-white rounded-2xl w-full max-w-[420px] p-6 shadow-2xl animate-fade">
          <div className="text-[19px] font-bold text-gray-900">Set up the receipt printer</div>
          <p className="text-[13px] text-gray-500 mt-1.5 leading-relaxed">
            This looks like a new installation. Choose the paper size and print a
            test page so receipts come out correctly.
          </p>

          <div className="mt-4 rounded-xl border border-gray-200 bg-[#f6f6f5] p-3.5">
            {best ? (
              <>
                <div className="text-[12px] font-bold text-gray-700">Printer found</div>
                <div className="text-[13px] font-semibold text-gray-900 mt-0.5">{best.path}</div>
                <div className="text-[11px] text-gray-500">{best.friendlyName || best.manufacturer || 'Serial device'}</div>
              </>
            ) : (
              <>
                <div className="text-[12px] font-bold text-amber-700">No printer detected</div>
                <div className="text-[11px] text-gray-600 mt-0.5 leading-relaxed">
                  Check the printer is switched on and the cable inside the machine
                  is connected, then open the settings below.
                </div>
              </>
            )}
          </div>

          <div className="flex gap-2.5 mt-5">
            <button onClick={() => setOpenSettings(true)}
              className="flex-1 h-12 bg-[#16181d] hover:bg-[#2a2d34] text-white rounded-xl text-[15px] font-bold active:scale-[.98] transition">
              Set up printer
            </button>
            <button onClick={dismiss}
              className="h-12 px-5 rounded-xl border border-gray-300 text-[15px] font-semibold text-gray-600 active:scale-[.98] transition">
              Skip
            </button>
          </div>

          <p className="text-[11px] text-gray-400 mt-3 text-center">
            You can change this any time from the menu → Receipt Printer.
          </p>
        </div>
      </div>
    </>
  )
}
