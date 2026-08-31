import { useEffect, useState } from 'react'
import { isTouchPOS } from '../hooks/usePosMode'
import Keypad from './Keypad'
import TextKeyboard from './TextKeyboard'

/**
 * Replacement for window.prompt / window.confirm.
 *
 * The native dialogs are unusable on a POS terminal: they need a physical
 * keyboard to type into, and they cannot be styled or reached by touch. This
 * gives the same imperative `await` ergonomics with a keypad for PINs and an
 * on-screen keyboard for free text.
 *
 *   const pin = await askPin('Confirm deletion')      // null if cancelled
 *   const why = await askText('Reason for cancelling')
 *   if (await askConfirm('Delete this product?')) …
 *
 * Mount <PromptDialog /> once, at the app root.
 */

let open = null // (request) => void, wired up by the mounted component

const request = (req) => new Promise((resolve) => {
  if (!open) { resolve(null); return }   // not mounted — fail closed
  open({ ...req, resolve })
})

export const askPin = (title, message) =>
  request({ mode: 'pin', title: title || 'Enter your admin PIN', message })

export const askText = (title, message, initial = '') =>
  request({ mode: 'text', title, message, initial })

export const askConfirm = (title, message) =>
  request({ mode: 'confirm', title, message }).then(v => v === true)

export default function PromptDialog() {
  const [req, setReq] = useState(null)
  const [value, setValue] = useState('')
  const touch = isTouchPOS()

  useEffect(() => {
    open = (r) => { setValue(r.initial || ''); setReq(r) }
    return () => { open = null }
  }, [])

  useEffect(() => {
    if (!req) return
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null) }
      if (e.key === 'Enter' && req.mode !== 'text') { e.preventDefault(); submit() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req, value]) // eslint-disable-line

  const finish = (result) => { req?.resolve(result); setReq(null); setValue('') }
  const submit = () => {
    if (!req) return
    if (req.mode === 'confirm') return finish(true)
    if (!value.trim()) return
    finish(value)
  }

  if (!req) return null

  const isPin = req.mode === 'pin'
  const canSubmit = req.mode === 'confirm' || (isPin ? value.length === 4 : !!value.trim())

  return (
    <div className="fixed inset-0 z-[600] flex items-end md:items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => finish(null)} />
      <div className="pos-modal relative bg-white rounded-t-2xl md:rounded-2xl w-full md:max-w-[400px] max-h-[94vh] overflow-y-auto p-5 animate-slide-up md:animate-fade">
        <h3 className="text-[17px] font-bold text-gray-900">{req.title}</h3>
        {req.message && <p className="text-[13px] text-gray-500 mt-1.5 leading-relaxed">{req.message}</p>}

        {isPin && (
          <>
            <div className="flex gap-3 justify-center my-5">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="w-12 h-12 rounded-xl border-2 flex items-center justify-center"
                  style={{ borderColor: i < value.length ? '#16181d' : '#dde2dc', background: i < value.length ? '#16181d' : '#fafafa' }}>
                  {i < value.length && <div className="w-2 h-2 rounded-full bg-white" />}
                </div>
              ))}
            </div>
            <Keypad value={value} onChange={v => setValue(v.slice(0, 4))} maxLength={4} className="mb-3" />
          </>
        )}

        {req.mode === 'text' && (
          <input
            autoFocus
            className="w-full h-13 px-4 my-4 bg-gray-50 border-2 border-gray-200 rounded-xl text-base focus:outline-none focus:border-gray-400"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
          />
        )}

        <div className="flex gap-2.5">
          <button onClick={() => finish(null)}
            className="flex-1 h-12 rounded-xl border border-gray-300 text-[15px] font-semibold text-gray-600 active:scale-[.98] transition">
            Cancel
          </button>
          <button onClick={submit} disabled={!canSubmit}
            className="flex-1 h-12 rounded-xl bg-[#16181d] text-white text-[15px] font-bold disabled:opacity-30 active:scale-[.98] transition">
            {req.mode === 'confirm' ? 'Confirm' : 'OK'}
          </button>
        </div>

        {/* Free text needs an on-screen keyboard on a keyboard-less till. */}
        {req.mode === 'text' && touch && (
          <TextKeyboard value={value} onChange={setValue} onClose={() => {}} onSubmit={submit} />
        )}
      </div>
    </div>
  )
}
