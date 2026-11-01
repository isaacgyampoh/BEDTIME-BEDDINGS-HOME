import { useEffect, useState } from 'react'
import { useStore } from '../hooks/useStore'
import toast from 'react-hot-toast'

const SHOP_URL = 'https://bedtimehome.com'
const DEFAULT_CLOSED = 'We are closed right now. Message us on WhatsApp and we will get back to you.'

/**
 * Opening and closing the online shop.
 *
 * The switch itself has existed in the sidebar for a long time, hidden behind
 * a flag that said "this brand has no e-commerce website yet" — which stopped
 * being true once bedtimehome.com went live with the whole catalogue. So there
 * was no visible way to close the shop, which is the one thing you want at
 * two in the morning when stock has run out.
 *
 * Closing does not take the website down. It stays up and keeps answering;
 * customers see a "we'll be right back" page with the message set here and a
 * WhatsApp button, so an order can still reach the shop by hand.
 */
export default function OnlineShop() {
  const { shopOpen, shopSettingLoaded, closedMessage, fetchShopOpen, setShopOpen, setClosedMessage } = useStore()
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [savingMsg, setSavingMsg] = useState(false)

  useEffect(() => { fetchShopOpen() }, [fetchShopOpen])
  useEffect(() => { setDraft(closedMessage || '') }, [closedMessage])

  const toggle = async () => {
    const next = !shopOpen
    // Closing is the one that costs money, so it asks first.
    if (!next && !window.confirm('Close the online shop?\n\nThe website stays up, but customers will not be able to order until you open it again.')) return
    setBusy(true)
    const res = await setShopOpen(next)
    setBusy(false)
    if (res?.ok) toast.success(next ? 'The online shop is open' : 'The online shop is closed')
    else toast.error(res?.error || 'Could not change it — the website is unchanged')
  }

  const saveMessage = async () => {
    setSavingMsg(true)
    const res = await setClosedMessage(draft)
    setSavingMsg(false)
    if (res?.ok) toast.success('Message saved')
    else toast.error(res?.error || 'Could not save the message')
  }

  const open = shopOpen
  const message = (closedMessage || '').trim() || DEFAULT_CLOSED

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] md:text-[26px] font-bold tracking-tight">Online Shop</h1>
        <p className="text-gray-400 text-sm mt-0.5">Open or close {SHOP_URL.replace('https://', '')} for customers</p>
      </div>

      {/* The state, said plainly, before anything can be changed. */}
      <div className={`rounded-2xl p-6 mb-4 text-white ${open ? 'bg-[#16181d]' : 'bg-[#7a2e22]'}`}>
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.2em] opacity-60 mb-1.5">
              {shopSettingLoaded ? 'Right now' : 'Checking…'}
            </div>
            <div className="text-2xl md:text-3xl font-bold leading-tight">
              {open ? 'Customers can order' : 'Customers cannot order'}
            </div>
            <p className="text-sm opacity-70 mt-2 max-w-md">
              {open
                ? 'The shop is open. Anyone can browse the catalogue and place an order.'
                : 'The website is still up, but every page shows the closed notice below instead of the shop.'}
            </p>
          </div>

          <button
            onClick={toggle}
            disabled={!shopSettingLoaded || busy}
            aria-pressed={open}
            aria-label={open ? 'Close the online shop' : 'Open the online shop'}
            className="shrink-0 flex items-center gap-3 bg-white/10 hover:bg-white/15 disabled:opacity-40 rounded-xl px-4 py-3 transition">
            <span className="text-sm font-bold">{busy ? 'Saving…' : open ? 'Close shop' : 'Open shop'}</span>
            <span className={`relative w-12 h-7 rounded-full transition-colors shrink-0 ${open ? 'bg-emerald-400' : 'bg-white/25'}`}>
              <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition-all ${open ? 'left-[22px]' : 'left-0.5'}`} />
            </span>
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* What a customer reads while it is shut. */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h2 className="text-sm font-bold text-gray-800 mb-1">The closed notice</h2>
          <p className="text-xs text-gray-400 mb-3">
            Shown on every page while the shop is closed, above a WhatsApp button so an
            order can still reach you.
          </p>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            maxLength={300}
            rows={3}
            placeholder={DEFAULT_CLOSED}
            className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl text-sm resize-none focus:outline-none focus:border-gray-400" />
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px] text-gray-400">{draft.length}/300</span>
            <button
              onClick={saveMessage}
              disabled={savingMsg || draft.trim() === (closedMessage || '').trim()}
              className="h-9 px-4 bg-gray-700 text-white rounded-lg text-xs font-bold disabled:opacity-30">
              {savingMsg ? 'Saving…' : 'Save message'}
            </button>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">What they will see</div>
            <div className="bg-gray-50 rounded-xl p-4 text-center">
              <div className="text-base font-bold text-gray-900 mb-1">We&apos;ll be right back</div>
              <p className="text-xs text-gray-500">{(draft.trim() || message)}</p>
              <span className="inline-block mt-3 px-4 py-1.5 bg-gray-900 text-white rounded-full text-[11px] font-semibold">Message us on WhatsApp</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h2 className="text-sm font-bold text-gray-800 mb-3">What closing does and does not do</h2>
          <ul className="space-y-2.5 text-[13px] text-gray-600">
            <li className="flex gap-2"><span className="text-gray-300">•</span><span>Takes effect <b>immediately</b> — anyone with the site open sees the change without reloading.</span></li>
            <li className="flex gap-2"><span className="text-gray-300">•</span><span>The website <b>stays online</b>. Nothing is deleted and no link breaks.</span></li>
            <li className="flex gap-2"><span className="text-gray-300">•</span><span>Orders already placed are <b>unaffected</b> — they stay in WhatsApp Orders.</span></li>
            <li className="flex gap-2"><span className="text-gray-300">•</span><span>The till and every other part of this app <b>keep working</b> normally.</span></li>
            <li className="flex gap-2"><span className="text-gray-300">•</span><span>Customers can still reach you on <b>WhatsApp</b> from the closed page.</span></li>
          </ul>
          <a href={SHOP_URL} target="_blank" rel="noreferrer"
            className="mt-5 inline-flex items-center gap-2 h-10 px-4 border border-gray-200 rounded-lg text-xs font-semibold text-gray-600 hover:bg-gray-50 transition">
            Open {SHOP_URL.replace('https://', '')} in a new tab
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6M10 14L21 3" /></svg>
          </a>
        </div>
      </div>
    </div>
  )
}
