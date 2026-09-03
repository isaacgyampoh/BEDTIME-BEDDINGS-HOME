import { useEffect, useState } from 'react'
import { useStore } from '../hooks/useStore'
import {
  updatesSupported, getUpdateState, onUpdateState, installUpdate, reportBusy,
} from '../lib/updater'
import toast from 'react-hot-toast'

/**
 * Update notification.
 *
 * Deliberately quiet: nothing is shown while the POS is current, checking, or
 * downloading in the background. It appears only when an update is sitting
 * ready to install, because that is the only moment the operator has a decision
 * to make.
 *
 * It never restarts during a sale. The store's busy signal is mirrored to the
 * main process, which refuses to restart while a transaction is open; this
 * component explains that rather than failing silently.
 */
export default function UpdateBanner() {
  const cartCount = useStore(s => s.cart.length)
  const txDepth = useStore(s => s.txDepth)
  const [state, setState] = useState(null)
  const [dismissed, setDismissed] = useState(null)   // version the user deferred
  const [working, setWorking] = useState(false)

  const busy = txDepth > 0 || cartCount > 0

  useEffect(() => {
    if (!updatesSupported()) return
    getUpdateState().then(s => s && setState(s))
    return onUpdateState(setState)
  }, [])

  // Keep the main process in step, so it can refuse a restart on its own.
  useEffect(() => { reportBusy(busy) }, [busy])

  if (!updatesSupported()) return null
  if (state?.status !== 'ready') return null            // quiet unless ready
  if (dismissed && dismissed === state.version) return null

  const notes = Array.isArray(state.notes)
    ? state.notes.map(n => (typeof n === 'string' ? n : n?.note)).filter(Boolean).join('\n')
    : (typeof state.notes === 'string' ? state.notes : '')

  const doInstall = async () => {
    setWorking(true)
    const r = await installUpdate()
    setWorking(false)
    if (r?.ok) return                                   // the app is restarting
    if (r?.busy) {
      toast('Finish the current sale first — the update will install when you close the POS', { duration: 5000 })
      return
    }
    toast.error(r?.error || 'Could not start the update')
  }

  return (
    <div className="fixed bottom-4 right-4 z-[450] w-[min(360px,calc(100vw-2rem))] animate-fade">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-xl overflow-hidden">
        <div className="px-5 pt-4 pb-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#16181d] flex items-center justify-center flex-shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold text-gray-900 leading-tight">Update ready</div>
              <div className="text-[12px] text-gray-500 mt-0.5">
                BEDTIME POS {state.version} is ready to install
              </div>
            </div>
          </div>

          {notes && (
            <div className="mt-3 text-[12px] text-gray-600 leading-relaxed max-h-24 overflow-y-auto whitespace-pre-line">
              {notes.replace(/<[^>]+>/g, '').trim().slice(0, 400)}
            </div>
          )}

          {busy && (
            <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-[12px] text-amber-800">
              A sale is open. Finish it first — nothing will be lost.
            </div>
          )}
        </div>

        <div className="flex gap-2 px-5 pb-4">
          <button onClick={doInstall} disabled={working || busy}
            className="flex-1 h-11 bg-[#16181d] hover:bg-[#2a2d34] text-white rounded-xl text-[14px] font-bold disabled:opacity-40 active:scale-[.98] transition">
            {working ? 'Restarting…' : 'Restart & update'}
          </button>
          <button onClick={() => setDismissed(state.version)}
            className="h-11 px-4 rounded-xl border border-gray-300 text-[14px] font-semibold text-gray-600 active:scale-[.98] transition">
            Later
          </button>
        </div>

        <div className="px-5 pb-3 -mt-1">
          <p className="text-[11px] text-gray-400 leading-snug">
            If you choose Later, it installs automatically the next time you close the POS.
          </p>
        </div>
      </div>
    </div>
  )
}
