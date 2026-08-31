import { useEffect } from 'react'

/**
 * On-screen numeric keypad.
 *
 * POS terminals usually ship with no physical keyboard, and a browser in
 * desktop mode will not raise the OS touch keyboard for a focused <input>.
 * Anything that needs digits — the login PIN, a discount, cash received —
 * therefore needs its own keypad or it simply cannot be typed.
 *
 * A hardware keyboard or USB numpad still works: `captureKeys` binds the same
 * handlers to real keystrokes, so both input methods stay live at once.
 */

const KEY_BASE =
  'flex items-center justify-center rounded-2xl font-semibold select-none ' +
  'transition-[transform,background-color] duration-75 active:scale-[.96] touch-manipulation'

export default function Keypad({
  value = '',
  onChange,
  onEnter,
  maxLength = 12,
  allowDecimal = false,
  captureKeys = true,
  submitLabel,
  disabled = false,
  size = 'md',            // 'md' for dialogs, 'lg' for the login screen
  className = '',
}) {
  const press = (digit) => {
    if (disabled) return
    if (digit === '.') {
      if (!allowDecimal || value.includes('.')) return
      onChange((value === '' ? '0' : value) + '.')
      return
    }
    if (value.length >= maxLength) return
    // Avoid "007" — a leading zero only survives if a decimal point follows.
    const next = value === '0' && digit !== '.' ? digit : value + digit
    onChange(next)
  }

  const backspace = () => { if (!disabled) onChange(value.slice(0, -1)) }
  const clear = () => { if (!disabled) onChange('') }

  // Keep physical keyboards and USB numpads working alongside the buttons.
  useEffect(() => {
    if (!captureKeys || disabled) return
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key >= '0' && e.key <= '9') { e.preventDefault(); press(e.key) }
      else if (e.key === '.' && allowDecimal) { e.preventDefault(); press('.') }
      else if (e.key === 'Backspace') { e.preventDefault(); backspace() }
      else if (e.key === 'Escape') { e.preventDefault(); clear() }
      else if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [value, disabled, captureKeys, allowDecimal, onEnter]) // eslint-disable-line

  const cell = size === 'lg'
    ? 'h-[72px] text-[26px]'
    : 'h-16 text-[22px]'

  const digitKey = `${KEY_BASE} ${cell} bg-white text-gray-900 border border-gray-200 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-40`
  const utilKey  = `${KEY_BASE} ${cell} bg-gray-100 text-gray-600 border border-gray-200 hover:bg-gray-200 active:bg-gray-200 disabled:opacity-40`

  return (
    <div className={`grid grid-cols-3 gap-2.5 ${className}`}>
      {['1','2','3','4','5','6','7','8','9'].map(d => (
        <button key={d} type="button" disabled={disabled} onClick={() => press(d)} className={digitKey} aria-label={d}>{d}</button>
      ))}

      {allowDecimal
        ? <button type="button" disabled={disabled} onClick={() => press('.')} className={utilKey} aria-label="Decimal point">.</button>
        : <button type="button" disabled={disabled} onClick={clear} className={`${utilKey} text-[15px]`} aria-label="Clear">Clear</button>}

      <button type="button" disabled={disabled} onClick={() => press('0')} className={digitKey} aria-label="0">0</button>

      <button type="button" disabled={disabled} onClick={backspace} className={utilKey} aria-label="Backspace">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 5H8.5L2 12l6.5 7H21a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zM17 9l-5 6M12 9l5 6" />
        </svg>
      </button>

      {onEnter && submitLabel && (
        <button type="button" disabled={disabled} onClick={onEnter}
          className={`${KEY_BASE} ${cell} col-span-3 bg-[#16181d] text-white text-[17px] hover:bg-[#2a2d34] disabled:opacity-40`}>
          {submitLabel}
        </button>
      )}
    </div>
  )
}
