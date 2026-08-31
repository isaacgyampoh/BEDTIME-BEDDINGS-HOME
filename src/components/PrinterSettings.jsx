import { useState } from 'react'
import Modal from './Modal'
import {
  PAPER, getPaperWidth, setPaperWidth,
  getAutoPrint, setAutoPrint, printHTML, testPageHTML,
} from '../lib/printer'
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
  const [testing, setTesting] = useState(false)

  const choosePaper = (w) => { setPaper(w); setPaperWidth(w); toast.success(`Paper set to ${w}mm`) }
  const chooseAuto = (m) => { setAuto(m); setAutoPrint(m) }

  const testPrint = async () => {
    setTesting(true)
    const ok = await printHTML(testPageHTML(paper), { paper, title: 'Printer test' })
    setTesting(false)
    if (!ok) toast.error('Could not reach the printer. Check it is on and has paper.')
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
          <div className="text-[13px] font-bold text-gray-800 mb-1.5">To skip the print dialog</div>
          <p className="text-[12px] text-gray-500 leading-relaxed">
            A browser shows a print dialog every time unless it is told not to.
            Launch Chrome on this terminal with <code className="bg-white px-1.5 py-0.5 rounded border border-gray-200 text-[11px]">--kiosk-printing</code>,
            and set the built-in printer as the default. Receipts then print
            straight to the roll with no confirmation.
          </p>
        </div>

      </div>
    </Modal>
  )
}
