import { useState, useEffect } from 'react'
import { isTouchPOS } from '../hooks/usePosMode'
import Keypad from './Keypad'

/**
 * A numeric / phone field that works with or without a keyboard.
 *
 * On a mouse machine this is an ordinary <input>, unchanged.
 * On a touch POS terminal (no physical keyboard, browser won't raise the OS
 * touch keyboard) tapping it opens a keypad sheet instead, so amounts and
 * phone numbers can actually be entered.
 */
export default function NumField({
  value = '',
  onChange,
  placeholder = '',
  allowDecimal = false,
  maxLength = 12,
  title = 'Enter a value',
  prefix = '',
  className = '',
  inputClassName = '',
  autoFocus = false,
  disabled = false,
}) {
  const touch = isTouchPOS()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => { if (open) setDraft(String(value ?? '')) }, [open]) // eslint-disable-line

  if (!touch) {
    return (
      <input
        type={allowDecimal ? 'number' : 'tel'}
        inputMode={allowDecimal ? 'decimal' : 'numeric'}
        className={inputClassName || className}
        placeholder={placeholder}
        value={value}
        maxLength={allowDecimal ? undefined : maxLength}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
      />
    )
  }

  const commit = () => { onChange(draft); setOpen(false) }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={`${inputClassName || className} text-left flex items-center disabled:opacity-40`}>
        {value !== '' && value != null
          ? <span>{prefix}{value}</span>
          : <span className="text-gray-400 font-normal">{placeholder || 'Tap to enter'}</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-[420] flex items-end md:items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="relative bg-white rounded-t-2xl md:rounded-2xl w-full md:max-w-[380px] p-5 animate-slide-up md:animate-fade">
            <div className="text-[13px] font-semibold text-gray-500 mb-2">{title}</div>

            <div className="h-16 px-4 mb-4 rounded-xl bg-gray-50 border-2 border-gray-200 flex items-center justify-end text-[28px] font-bold tabular-nums">
              {draft === '' ? <span className="text-gray-300">{placeholder || '0'}</span> : <>{prefix}{draft}</>}
            </div>

            <Keypad
              value={draft}
              onChange={setDraft}
              onEnter={commit}
              submitLabel="Done"
              allowDecimal={allowDecimal}
              maxLength={maxLength}
            />

            <button type="button" onClick={() => setOpen(false)}
              className="w-full h-12 mt-2.5 rounded-2xl text-[15px] font-semibold text-gray-500 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  )
}
