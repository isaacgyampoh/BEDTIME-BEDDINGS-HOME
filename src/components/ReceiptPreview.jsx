import { useEffect, useRef, useState, useMemo } from 'react'
import { fmtDateTime, SHOP } from '../lib/utils'
import {
  printReceipt, receiptHTML, buildDocument, paperMM,
  getAutoPrint, getPaperWidth,
} from '../lib/printer'
import toast from 'react-hot-toast'

/**
 * Receipt preview + print.
 *
 * The preview is an iframe rendering the EXACT document that gets printed,
 * rather than a second hand-written JSX version of the same layout. The two
 * had already drifted — the old preview left out the split cash/MoMo lines
 * that the printout showed, so the cashier saw one thing and the customer got
 * another. There is now one source of truth for a receipt.
 */
export default function ReceiptPreview({ sale, onClose }) {
  const printedRef = useRef(false)
  const [printing, setPrinting] = useState(false)
  // Shown in the sheet, not a toast: a toast disappears before anyone at a
  // busy counter reads it, and this is the thing they need to act on.
  const [printError, setPrintError] = useState('')
  const paper = getPaperWidth()

  const doc = useMemo(() => {
    if (!sale) return ''
    return buildDocument(
      receiptHTML({ ...sale, dateText: fmtDateTime(sale.date) }, SHOP),
      { paper, title: `Receipt ${sale.receiptNo || ''}` }
    )
  }, [sale, paper])

  const doPrint = async () => {
    if (!sale || printing) return
    setPrinting(true)
    // Goes straight to the built-in head over ESC/POS when the terminal has
    // been paired; otherwise falls back to the OS print path.
    const { ok, error, via } = await printReceipt(
      { ...sale, dateText: fmtDateTime(sale.date) }, SHOP, { paper }
    )
    setPrinting(false)
    setPrintError(ok ? '' : (error || 'Printer unavailable. Check the printer connection and try again.'))
    if (ok && via === 'browser') toast('Sent to the print dialog')
  }

  // Auto-print. Was hardcoded to cash sales; now follows the terminal setting,
  // so a MoMo or split sale can print automatically too.
  useEffect(() => {
    if (!sale || printedRef.current) return
    const mode = getAutoPrint()
    if (!(mode === 'all' || (mode === 'cash' && sale.payment === 'Cash'))) return
    printedRef.current = true
    const t = setTimeout(doPrint, 200)
    return () => clearTimeout(t)
  }, [sale]) // eslint-disable-line

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!sale) return null

  // 1mm ≈ 3.78 CSS px. Add a little padding so the paper edge is visible.
  const previewW = Math.round(paperMM(paper) * 3.78) + 24

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-[499]" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[500] flex flex-col bg-white rounded-2xl shadow-2xl max-h-[92vh]"
        style={{ width: Math.max(previewW, 320) }}>

        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <div>
            <div className="text-[15px] font-bold text-gray-900">Receipt</div>
            <div className="text-[11px] text-gray-400">{sale.receiptNo} · {paper}mm paper</div>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-11 h-11 bg-gray-100 hover:bg-gray-200 rounded-xl text-lg flex items-center justify-center transition active:scale-95">✕</button>
        </div>

        {/* Exactly what the printer will produce. */}
        <div className="flex-1 overflow-y-auto bg-[#ececeb] p-3">
          <iframe
            title="Receipt preview"
            srcDoc={doc}
            className="w-full bg-white block border-0 shadow-sm"
            style={{ height: 'min(62vh, 900px)' }}
          />
        </div>

        {printError && (
          <div role="alert" className="mx-4 mt-3 border border-red-200 bg-red-50 rounded-lg px-3 py-2.5 text-[13px] text-red-800">
            <div className="font-bold">Not printed</div>
            <div className="mt-0.5">{printError}</div>
          </div>
        )}

        <div className="flex gap-2 p-4 border-t border-gray-100 flex-shrink-0 safe-bottom">
          <button onClick={doPrint} disabled={printing}
            className="flex-1 h-12 bg-[#16181d] hover:bg-[#2a2d34] text-white rounded-xl text-sm font-bold active:scale-[.98] transition disabled:opacity-50">
            {printing ? 'Printing…' : printError ? 'Try again' : 'Print Receipt'}
          </button>
          <button onClick={onClose}
            className="h-12 px-5 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm font-semibold text-gray-600 transition active:scale-[.98]">
            Done
          </button>
        </div>
      </div>
    </>
  )
}
