import { useEffect } from 'react'

export default function Modal({ open, onClose, title, children, footer }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    // Stop the page behind the sheet scrolling under the operator's finger.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[400] flex items-end md:items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="pos-modal relative bg-white rounded-t-2xl md:rounded-2xl w-full md:max-w-[560px] max-h-[90vh] flex flex-col animate-slide-up md:animate-fade">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h3 className="text-xl font-bold">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="w-12 h-12 -mr-1 bg-gray-100 rounded-xl text-xl flex items-center justify-center active:scale-95 transition">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
        {footer && <div className="p-5 border-t border-gray-100 flex gap-3 safe-bottom">{footer}</div>}
      </div>
    </div>
  )
}
