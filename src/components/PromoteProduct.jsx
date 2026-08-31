import { useState, useEffect, useMemo } from 'react'
import Modal from './Modal'
import { askPin } from './PromptDialog'
import { money, num, thumb } from '../lib/utils'
import {
  tiktokCaption, whatsappMessage, suggestHashtags, shareToWhatsApp,
  availableUnits, unitPrice, unitLabel, canPromote, productUrl,
  savePost, updatePost, logSocial, lastPriceChange, publishToTikTok, fetchConnections,
} from '../lib/social'
import { useStore } from '../hooks/useStore'
import toast from 'react-hot-toast'

// Module scope: a component defined inside render is a new type every render,
// so React remounts it and the inputs inside lose focus on each keystroke.
const Field = ({ label, children }) => (
  <div>
    <label className="block text-xs font-semibold text-gray-500 mb-2">{label}</label>
    {children}
  </div>
)

/**
 * Promote a product to TikTok and/or WhatsApp.
 *
 * Reads the live product record — nothing about the product is duplicated or
 * cached here. Price and stock are re-read from the store on open, and stock is
 * re-checked server-side again at publish time.
 */
export default function PromoteProduct({ product, open, onClose }) {
  const { user, products } = useStore()
  // Always work from the CURRENT record, not the row the user clicked.
  const live = useMemo(
    () => products.find(p => p.id === product?.id) || product,
    [products, product]
  )

  const [channels, setChannels] = useState({ tiktok: false, whatsapp: true })
  const [unit, setUnit] = useState('retail')
  const [caption, setCaption] = useState('')
  const [tags, setTags] = useState([])
  const [newTag, setNewTag] = useState('')
  const [waMsg, setWaMsg] = useState('')
  const [waPhone, setWaPhone] = useState('')
  const [selectedMedia, setSelectedMedia] = useState([])
  const [videoUrl, setVideoUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [tiktokReady, setTiktokReady] = useState(false)
  const [priceDrop, setPriceDrop] = useState(null)

  const units = useMemo(() => availableUnits(live), [live])
  const gate = canPromote(live)
  const price = unitPrice(live, unit)

  useEffect(() => {
    if (!open || !live) return
    setUnit(units[0]?.id || 'retail')
    setSelectedMedia(live.image ? [{ type: 'image', url: live.image }] : [])
    setVideoUrl('')
    setNewTag('')
    fetchConnections().then(cs => {
      const tk = cs.find(c => c.platform === 'tiktok')
      setTiktokReady(!!tk && tk.status === 'connected' && tk.has_token)
    })
    // A real prior price, or nothing. Never invented.
    lastPriceChange(live.id).then(h => {
      const dropped = h && num(h.new_price) < num(h.old_price)
      setPriceDrop(dropped ? num(h.old_price) : null)
    })
  }, [open, live?.id]) // eslint-disable-line

  // Regenerate copy whenever the unit or the detected price drop changes.
  useEffect(() => {
    if (!open || !live || !gate.ok) return
    regenerate()
  }, [open, live?.id, unit, priceDrop]) // eslint-disable-line

  const event = priceDrop != null ? 'price_change' : (num(live?.quantity) <= 5 ? 'low_stock' : 'manual')

  const regenerate = () => {
    if (!live) return
    const opts = { unit, event, previous: priceDrop }
    setCaption(tiktokCaption(live, opts))
    setWaMsg(whatsappMessage(live, opts))
    setTags(suggestHashtags(live))
  }

  const addTag = () => {
    const t = '#' + String(newTag).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (t.length < 2 || tags.includes(t)) { setNewTag(''); return }
    setTags([...tags, t]); setNewTag('')
  }

  const basePost = (platform, status) => ({
    platform, status,
    product_id: live.id,
    product_name: live.name,
    unit,
    unit_price: price,
    stock_at_creation: num(live.quantity),
    source_event: event,
    created_by: user?.name || '',
  })

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  const copyMessage = async () => {
    try { await navigator.clipboard.writeText(waMsg); toast.success('Message copied') }
    catch { toast.error('Could not copy') }
  }

  const doShareWhatsApp = async () => {
    // Recorded as 'shared' — the app can confirm it opened WhatsApp with the
    // message, and nothing more. It never claims the customer received it.
    const { ok, post } = await savePost({ ...basePost('whatsapp', 'shared'), caption: waMsg })
    if (ok) {
      await logSocial({ action: 'product_promoted', platform: 'whatsapp', product_id: live.id, post_id: post.id, actor: user?.name || '', result: 'shared' })
    }
    shareToWhatsApp(waMsg, waPhone)
    toast.success('Opening WhatsApp')
  }

  // ── TikTok ────────────────────────────────────────────────────────────────
  const media = () => (videoUrl ? [{ type: 'video', url: videoUrl }] : selectedMedia)

  const saveDraft = async () => {
    setBusy(true)
    const { ok, error, post } = await savePost({
      ...basePost('tiktok', 'draft'), caption, hashtags: tags.join(' '), media: media(),
    })
    setBusy(false)
    if (!ok) return toast.error(error || 'Could not save draft')
    await logSocial({ action: 'product_promoted', platform: 'tiktok', product_id: live.id, post_id: post.id, actor: user?.name || '', result: 'draft' })
    toast.success('Saved as draft')
    onClose?.()
  }

  const publishNow = async () => {
    if (!tiktokReady) return toast.error('Connect TikTok first — Social Commerce → TikTok')
    if (!media().length) return toast.error('Select an image or add a video first')

    const pin = await askPin('Confirm with your admin PIN', 'Publishing to TikTok.')
    if (!pin) return

    setBusy(true)
    // Persist first, then hand the id to the server. The POS never waits on
    // TikTok inside a product save, and the row is the idempotency anchor.
    const { ok, error, post } = await savePost({
      ...basePost('tiktok', 'ready'), caption, hashtags: tags.join(' '), media: media(),
      idempotency_key: `${live.id}-${Date.now()}`,
    })
    if (!ok) { setBusy(false); return toast.error(error || 'Could not queue the post') }

    const res = await publishToTikTok(post.id, pin)
    setBusy(false)
    if (res?.success) {
      toast.success('Sent to TikTok — status will update once TikTok confirms')
      onClose?.()
    } else {
      await updatePost(post.id, { status: 'failed', error: res?.error || 'Publish failed' })
      toast.error(res?.error || 'TikTok publishing failed')
    }
  }

  if (!open || !live) return null

  return (
    <Modal open={open} onClose={onClose} title="Promote Product"
      footer={<>
        <button onClick={onClose} className="h-12 px-5 border border-stone-300 rounded-xl text-sm font-semibold text-stone-600">Close</button>
        {channels.whatsapp && (
          <button onClick={doShareWhatsApp} disabled={!gate.ok}
            className="flex-1 h-12 bg-[#25d366] text-white rounded-xl text-sm font-bold disabled:opacity-40 active:scale-[.98] transition">
            Share on WhatsApp
          </button>
        )}
        {channels.tiktok && (
          <button onClick={saveDraft} disabled={busy || !gate.ok}
            className="flex-1 h-12 bg-[#16181d] text-white rounded-xl text-sm font-bold disabled:opacity-40 active:scale-[.98] transition">
            {busy ? 'Saving…' : 'Save draft'}
          </button>
        )}
      </>}>

      <div className="space-y-5">

        {/* Product — straight from the inventory record */}
        <div className="flex gap-3.5 p-3.5 bg-[#f6f6f5] rounded-2xl border border-gray-200">
          <div className="w-20 h-20 rounded-xl bg-white overflow-hidden flex-shrink-0 border border-gray-200">
            {live.image
              ? <img src={thumb(live.image, 160)} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-400">No photo</div>}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-bold text-gray-900 leading-snug">{live.name}</div>
            <div className="text-[12px] text-gray-500 mt-0.5">{live.category || 'Uncategorised'}</div>
            <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
              <span className="text-[15px] font-bold text-gray-900">{price != null ? money(price) : '—'}</span>
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                num(live.quantity) === 0 ? 'bg-red-100 text-red-700'
                : num(live.quantity) <= 5 ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                {num(live.quantity)} in stock
              </span>
            </div>
            <a href={productUrl(live.id)} target="_blank" rel="noopener noreferrer"
              className="text-[11px] text-[#0e7c86] font-medium mt-1 inline-block break-all">{productUrl(live.id)}</a>
          </div>
        </div>

        {!gate.ok && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 text-[13px] text-red-700 font-medium">
            {gate.reason}
          </div>
        )}

        {gate.ok && (<>
          {/* Selling unit — this system has retail/wholesale, not box/piece.
              Each quotes its own configured price; neither is derived. */}
          {units.length > 1 && (
            <Field label="Selling unit">
              <div className="flex gap-2.5">
                {units.map(u => (
                  <button key={u.id} onClick={() => setUnit(u.id)}
                    className={`flex-1 rounded-2xl border-2 p-3 text-left transition ${
                      unit === u.id ? 'border-[#16181d] bg-[#16181d] text-white' : 'border-gray-200 bg-white text-gray-700'}`}>
                    <div className="text-[13px] font-bold">{u.label}</div>
                    <div className={`text-[12px] ${unit === u.id ? 'text-white/70' : 'text-gray-400'}`}>
                      {money(u.price)} {unitLabel(live, u.id)}
                    </div>
                  </button>
                ))}
              </div>
            </Field>
          )}

          {priceDrop != null && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[12px] text-amber-800">
              Recorded price change: was {money(priceDrop)}, now {money(price)}. The copy below mentions it.
            </div>
          )}

          <Field label="Choose where to promote">
            <div className="flex gap-2.5">
              {[
                { id: 'whatsapp', label: 'WhatsApp', sub: 'Share now' },
                { id: 'tiktok', label: 'TikTok', sub: tiktokReady ? 'Connected' : 'Not connected' },
              ].map(c => (
                <button key={c.id} onClick={() => setChannels(v => ({ ...v, [c.id]: !v[c.id] }))}
                  className={`flex-1 rounded-2xl border-2 p-3.5 text-left transition ${
                    channels[c.id] ? 'border-[#16181d] bg-[#16181d] text-white' : 'border-gray-200 bg-white text-gray-700'}`}>
                  <div className="text-[14px] font-bold">{c.label}</div>
                  <div className={`text-[11px] mt-0.5 ${channels[c.id] ? 'text-white/60' : 'text-gray-400'}`}>{c.sub}</div>
                </button>
              ))}
            </div>
          </Field>

          {/* ── WhatsApp ── */}
          {channels.whatsapp && (
            <div className="border border-gray-200 rounded-2xl p-4 space-y-3">
              <div className="text-[13px] font-bold text-gray-800">WhatsApp message</div>
              <textarea value={waMsg} onChange={e => setWaMsg(e.target.value)} rows={9}
                className="w-full px-3.5 py-3 bg-gray-50 border border-gray-200 rounded-xl text-[13px] leading-relaxed resize-y focus:outline-none focus:border-gray-400" />
              <div className="flex gap-2 flex-wrap">
                <input value={waPhone} onChange={e => setWaPhone(e.target.value)} placeholder="Send to (optional) 024 000 0000"
                  className="flex-1 min-w-[180px] h-11 px-3.5 bg-gray-50 border border-gray-200 rounded-xl text-[13px] focus:outline-none focus:border-gray-400" />
                <button onClick={copyMessage} className="h-11 px-4 rounded-xl border border-gray-300 text-[13px] font-semibold text-gray-600">Copy</button>
                <button onClick={() => setWaMsg(whatsappMessage(live, { unit, event, previous: priceDrop }))}
                  className="h-11 px-4 rounded-xl border border-gray-300 text-[13px] font-semibold text-gray-600">Reset</button>
              </div>
            </div>
          )}

          {/* ── TikTok ── */}
          {channels.tiktok && (
            <div className="border border-gray-200 rounded-2xl p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-bold text-gray-800">TikTok content</div>
                <button onClick={regenerate} className="text-[12px] font-semibold text-[#0e7c86]">Regenerate</button>
              </div>

              <textarea value={caption} onChange={e => setCaption(e.target.value)} rows={8}
                className="w-full px-3.5 py-3 bg-gray-50 border border-gray-200 rounded-xl text-[13px] leading-relaxed resize-y focus:outline-none focus:border-gray-400" />

              <Field label="Hashtags">
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map(t => (
                    <button key={t} onClick={() => setTags(tags.filter(x => x !== t))}
                      className="h-8 px-2.5 bg-gray-100 hover:bg-red-50 hover:text-red-600 rounded-lg text-[12px] font-medium text-gray-600 transition">
                      {t} ✕
                    </button>
                  ))}
                  {!tags.length && <span className="text-[12px] text-gray-400">None</span>}
                </div>
                <div className="flex gap-2">
                  <input value={newTag} onChange={e => setNewTag(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
                    placeholder="add a hashtag"
                    className="flex-1 h-11 px-3.5 bg-gray-50 border border-gray-200 rounded-xl text-[13px] focus:outline-none focus:border-gray-400" />
                  <button onClick={addTag} className="h-11 px-4 rounded-xl border border-gray-300 text-[13px] font-semibold text-gray-600">Add</button>
                </div>
              </Field>

              <Field label="Media">
                {live.image ? (
                  <button onClick={() => setSelectedMedia(selectedMedia.length ? [] : [{ type: 'image', url: live.image }])}
                    className={`w-24 h-24 rounded-xl overflow-hidden border-2 transition ${selectedMedia.length ? 'border-[#16181d]' : 'border-gray-200 opacity-50'}`}>
                    <img src={thumb(live.image, 200)} alt="" className="w-full h-full object-cover" />
                  </button>
                ) : (
                  <p className="text-[12px] text-gray-400">This product has no photo. Add one on the product, or paste a video URL below.</p>
                )}
                <input value={videoUrl} onChange={e => setVideoUrl(e.target.value)}
                  placeholder="or paste a video URL (mp4)"
                  className="w-full h-11 px-3.5 mt-2.5 bg-gray-50 border border-gray-200 rounded-xl text-[13px] focus:outline-none focus:border-gray-400" />
                <p className="text-[11px] text-gray-400 mt-1.5">
                  No video is generated automatically. Select the product photo, or supply a real video.
                </p>
              </Field>

              {!tiktokReady && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-[12px] text-amber-800">
                  TikTok is not connected. You can still save a draft; connect the
                  account in Social Commerce to publish.
                </div>
              )}

              <button onClick={publishNow} disabled={busy || !tiktokReady}
                className="w-full h-12 bg-[#16181d] text-white rounded-xl text-sm font-bold disabled:opacity-30 active:scale-[.98] transition">
                {busy ? 'Publishing…' : 'Publish to TikTok'}
              </button>
              <p className="text-[11px] text-gray-400 text-center">
                Until TikTok audits the app, posts are created private on your account.
              </p>
            </div>
          )}
        </>)}
      </div>
    </Modal>
  )
}
