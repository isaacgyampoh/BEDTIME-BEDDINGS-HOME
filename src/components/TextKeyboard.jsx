import { useState } from 'react'

/**
 * Compact on-screen QWERTY, for text entry on a keyboard-less POS terminal.
 *
 * Deliberately additive: the underlying <input> stays in the DOM and stays
 * focusable, so a barcode scanner — which is just a very fast keyboard — keeps
 * working exactly as before. This only covers the case where someone needs to
 * type a product name by hand.
 */

const ROWS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
]
const NUMS = ['1','2','3','4','5','6','7','8','9','0']

const KEY = 'h-12 rounded-lg font-semibold text-[15px] flex items-center justify-center ' +
            'select-none touch-manipulation active:scale-95 transition-transform ' +
            'bg-white border border-gray-200 text-gray-800 active:bg-gray-100'

export default function TextKeyboard({ value = '', onChange, onClose, onSubmit }) {
  const [shift, setShift] = useState(false)

  const type = (ch) => {
    onChange(value + (shift ? ch.toUpperCase() : ch))
    if (shift) setShift(false)
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[410] bg-[#ececeb] border-t border-gray-300 p-2.5 pb-[max(10px,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,.12)]">
      <div className="max-w-[860px] mx-auto space-y-2">

        {/* Live value + close */}
        <div className="flex items-center gap-2">
          <div className="flex-1 h-12 px-3.5 bg-white border border-gray-200 rounded-lg flex items-center text-[15px] font-medium truncate">
            {value || <span className="text-gray-300">Type to search…</span>}
          </div>
          <button type="button" onClick={onClose} aria-label="Hide keyboard"
            className="h-12 px-5 rounded-lg bg-[#16181d] text-white text-[14px] font-semibold active:scale-95 transition">
            Done
          </button>
        </div>

        <div className="grid grid-cols-10 gap-1.5">
          {NUMS.map(n => <button key={n} type="button" onClick={() => type(n)} className={KEY}>{n}</button>)}
        </div>

        {ROWS.map((row, i) => (
          <div key={i} className="flex gap-1.5 justify-center">
            {i === 2 && (
              <button type="button" onClick={() => setShift(s => !s)}
                className={`${KEY} flex-[1.5] ${shift ? '!bg-[#16181d] !text-white' : ''}`} aria-pressed={shift}>
                ⇧
              </button>
            )}
            {row.map(ch => (
              <button key={ch} type="button" onClick={() => type(ch)} className={`${KEY} flex-1`}>
                {shift ? ch.toUpperCase() : ch}
              </button>
            ))}
            {i === 2 && (
              <button type="button" onClick={() => onChange(value.slice(0, -1))}
                className={`${KEY} flex-[1.5]`} aria-label="Backspace">⌫</button>
            )}
          </div>
        ))}

        <div className="flex gap-1.5">
          <button type="button" onClick={() => onChange('')} className={`${KEY} px-5`}>Clear</button>
          <button type="button" onClick={() => type(' ')} className={`${KEY} flex-1`} aria-label="Space">space</button>
          {onSubmit && (
            <button type="button" onClick={onSubmit}
              className="h-12 px-6 rounded-lg bg-[#0e7c86] text-white text-[14px] font-semibold active:scale-95 transition">
              Add
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
