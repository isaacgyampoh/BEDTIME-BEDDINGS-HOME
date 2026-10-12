import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { respond } from '../lib/voiceShop'

/**
 * Voice shopping for people who find typing and searching hard.
 *
 * Press to talk: the browser's own speech recognition turns speech into text,
 * voiceShop.js decides what it means against the real catalogue, and the reply
 * is spoken back. No audio and no conversation leaves the device — recognition
 * is the browser's, and the answers come from products already loaded. That is
 * also why it costs nothing per conversation and keeps working when the shop's
 * connection is poor.
 *
 * Everything the voice can do, the panel can do by hand: every product has an
 * Add button and there is a text box for anyone whose browser has no speech
 * recognition (notably Firefox and some in-app browsers). Voice is an extra
 * way in, never the only one.
 */

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null
export const voiceSupported = () => !!SR

const money = (n) => `GHS ${Number(n || 0).toFixed(2)}`

const Icon = ({ d, size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)
const MicIcon = <><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><path d="M12 19v3" /></>
const StopIcon = <rect x="6" y="6" width="12" height="12" rx="1" />
const CloseIcon = <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>

export default function VoiceShopper({
  open, onClose, products = [], promoMap = {}, cart = [],
  onAdd, onRemove, onClearCart, onOpen, onNavigate,
}) {
  const [status, setStatus] = useState('idle')      // idle | listening | thinking | speaking | denied | unsupported
  const [heard, setHeard] = useState('')
  const [turns, setTurns] = useState([])            // { who: 'you'|'shop', text }
  const [results, setResults] = useState([])
  const [typed, setTyped] = useState('')
  const [muted, setMuted] = useState(false)
  const lastResults = useRef([])
  const recognition = useRef(null)
  const lastReply = useRef('')
  const panelRef = useRef(null)
  const scrollRef = useRef(null)

  const speak = useCallback((text) => {
    lastReply.current = text
    if (muted || typeof speechSynthesis === 'undefined') return
    try {
      speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.rate = 1
      u.onend = () => setStatus(s => (s === 'speaking' ? 'idle' : s))
      setStatus('speaking')
      speechSynthesis.speak(u)
    } catch { setStatus('idle') }
  }, [muted])

  /** One turn: what was said -> what the shop does and says. */
  const handle = useCallback((utterance) => {
    if (!utterance?.trim()) return
    setTurns(t => [...t, { who: 'you', text: utterance }])
    setStatus('thinking')
    const r = respond(utterance, { products, promoMap, cart, lastResults: lastResults.current })
    if (r.results) { setResults(r.results); lastResults.current = r.lastResults || r.results }
    if (r.action) {
      const a = r.action
      if (a.kind === 'add') onAdd?.(a.product, a.qty)
      else if (a.kind === 'remove') onRemove?.(a.id)
      else if (a.kind === 'clearCart') onClearCart?.()
      else if (a.kind === 'navigate') onNavigate?.(a.page)
    }
    setTurns(t => [...t, { who: 'shop', text: r.say }])
    speak(r.say)
  }, [products, promoMap, cart, onAdd, onRemove, onClearCart, onNavigate, speak])

  const stopListening = useCallback(() => {
    try { recognition.current?.stop() } catch { /* already stopped */ }
    recognition.current = null
    setStatus(s => (s === 'listening' ? 'idle' : s))
  }, [])

  const listen = useCallback(() => {
    if (!SR) { setStatus('unsupported'); return }
    if (status === 'listening') { stopListening(); return }
    try { speechSynthesis?.cancel() } catch { /* nothing playing */ }
    const rec = new SR()
    rec.lang = 'en-GH'
    rec.interimResults = true
    rec.continuous = false
    rec.maxAlternatives = 1
    rec.onstart = () => { setHeard(''); setStatus('listening') }
    rec.onresult = (e) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript
      setHeard(text)
      if (e.results[e.results.length - 1].isFinal) { stopListening(); handle(text) }
    }
    rec.onerror = (e) => {
      recognition.current = null
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') setStatus('denied')
      else if (e.error === 'no-speech') { setStatus('idle'); speak('I did not hear anything. Tap the microphone and speak.') }
      else setStatus('idle')
    }
    rec.onend = () => { recognition.current = null; setStatus(s => (s === 'listening' ? 'idle' : s)) }
    recognition.current = rec
    try { rec.start() } catch { setStatus('idle') }
  }, [status, stopListening, handle, speak])

  // Release the microphone and stop any speech the moment the panel closes —
  // a live microphone must never outlive the thing the shopper opened.
  useEffect(() => {
    if (open) return
    stopListening()
    try { speechSynthesis?.cancel() } catch { /* nothing playing */ }
    setStatus('idle')
  }, [open, stopListening])
  useEffect(() => () => { stopListening(); try { speechSynthesis?.cancel() } catch { /* gone */ } }, [stopListening])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Keep the newest reply and its product cards in view; otherwise the cards
  // sit below a growing transcript and are never seen.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [turns, results])

  const cartCount = useMemo(() => cart.reduce((a, c) => a + Number(c.qty || 0), 0), [cart])
  const cartTotal = useMemo(() => cart.reduce((a, c) => a + Number(c.price || 0) * Number(c.qty || 0), 0), [cart])

  if (!open) return null

  const label = {
    idle: 'Tap to speak', listening: 'Listening…', thinking: 'One moment…',
    speaking: 'Speaking…', denied: 'Microphone blocked', unsupported: 'Type instead',
  }[status]

  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Shop by voice"
        className="relative bg-white w-full sm:max-w-[560px] sm:rounded-2xl rounded-t-2xl max-h-[90vh] flex flex-col outline-none">

        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-200 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold text-zinc-900">Shop by voice</h2>
            <p className="text-[12px] text-zinc-500" aria-live="polite">{label}</p>
          </div>
          <button onClick={() => setMuted(m => !m)}
            className="ml-auto h-10 px-3 rounded-lg border border-zinc-300 text-[12px] font-semibold text-zinc-700"
            aria-pressed={muted}>{muted ? 'Replies muted' : 'Mute replies'}</button>
          <button onClick={onClose} aria-label="Close voice shopping"
            className="h-10 w-10 rounded-lg border border-zinc-300 flex items-center justify-center text-zinc-700">
            <Icon d={CloseIcon} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
          {turns.length === 0 && (
            <div className="text-[13px] text-zinc-600 leading-relaxed">
              <p className="font-semibold text-zinc-900 mb-1">Say what you are looking for.</p>
              <ul className="space-y-1 list-disc pl-5">
                <li>“Show me duvets”</li>
                <li>“Which one is cheapest?”</li>
                <li>“Add two to my cart”</li>
                <li>“How much is my cart?”</li>
                <li>“Checkout”</li>
              </ul>
            </div>
          )}

          {/* Transcript — also the accessible record of the conversation. */}
          <div aria-live="polite" className="space-y-2.5">
            {turns.map((turn, i) => (
              <div key={i} className={turn.who === 'you' ? 'text-right' : ''}>
                <span className={`inline-block max-w-[85%] text-left px-3 py-2 rounded-lg text-[13px] leading-snug ${
                  turn.who === 'you' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-900'}`}>{turn.text}</span>
              </div>
            ))}
            {status === 'listening' && heard && (
              <div className="text-right"><span className="inline-block px-3 py-2 rounded-lg text-[13px] bg-zinc-200 text-zinc-600">{heard}</span></div>
            )}
          </div>

          {results.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3">
              {results.map(p => {
                const promo = promoMap[p.id]
                const price = promo ? promo.price : p.price
                const out = Number(p.quantity || 0) <= 0
                return (
                  <div key={p.id} className="border border-zinc-200 rounded-xl overflow-hidden">
                    <button onClick={() => { onOpen?.(p); onClose?.() }} className="block w-full text-left"
                      aria-label={`Open ${p.name}`}>
                      <div className="aspect-square bg-zinc-100">
                        {p.image && <img src={p.image} alt="" className="w-full h-full object-cover" loading="lazy" />}
                      </div>
                      <div className="px-2.5 pt-2">
                        <div className="text-[12px] font-medium leading-snug line-clamp-2 text-zinc-900">{p.name}</div>
                        <div className="flex items-baseline gap-1.5 mt-1">
                          <span className="text-[13px] font-bold">{money(price)}</span>
                          {promo && <span className="text-[11px] text-zinc-400 line-through">{money(p.price)}</span>}
                        </div>
                        <div className="text-[11px] text-zinc-500 mt-0.5">{out ? 'Out of stock' : `${p.quantity} in stock`}</div>
                      </div>
                    </button>
                    <div className="p-2.5 pt-2">
                      <button disabled={out} onClick={() => { onAdd?.(p, 1); setTurns(t => [...t, { who: 'shop', text: `Added ${p.name}.` }]) }}
                        className="w-full h-10 rounded-lg bg-zinc-900 text-white text-[12px] font-bold disabled:opacity-40">
                        {out ? 'Unavailable' : 'Add to cart'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {status === 'denied' && (
            <div role="alert" className="mt-4 border border-amber-300 bg-amber-50 rounded-lg p-3 text-[12px] text-amber-900">
              <strong className="block">The microphone is blocked.</strong>
              Allow microphone access for this site in your browser settings, then tap the microphone again.
              You can keep shopping by typing below.
            </div>
          )}
          {status === 'unsupported' && (
            <div role="alert" className="mt-4 border border-zinc-300 bg-zinc-50 rounded-lg p-3 text-[12px] text-zinc-700">
              This browser cannot listen. Chrome on Android or a desktop works best. Type below instead — it does the same thing.
            </div>
          )}
        </div>

        <div className="border-t border-zinc-200 p-4 flex-shrink-0 space-y-3">
          {cart.length > 0 && (
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-zinc-600">{cartCount} item{cartCount === 1 ? '' : 's'} in cart</span>
              <span className="font-bold text-zinc-900">{money(cartTotal)}</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <button onClick={listen}
              aria-label={status === 'listening' ? 'Stop listening' : 'Start speaking'}
              className={`h-14 w-14 flex-shrink-0 rounded-full flex items-center justify-center border-2 transition ${
                status === 'listening' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-900 border-zinc-900'}`}>
              <Icon d={status === 'listening' ? StopIcon : MicIcon} size={24} />
            </button>
            <form className="flex-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = typed; setTyped(''); handle(v) }}>
              <label className="sr-only" htmlFor="voice-typed">Type what you are looking for</label>
              <input id="voice-typed" value={typed} onChange={e => setTyped(e.target.value)}
                placeholder="or type here…"
                className="flex-1 h-12 px-3 border border-zinc-300 rounded-lg text-[14px]" />
              <button type="submit" className="h-12 px-4 rounded-lg bg-zinc-900 text-white text-[13px] font-bold">Send</button>
            </form>
          </div>
          <div className="flex gap-2">
            <button onClick={() => { try { speechSynthesis?.cancel() } catch { /* nothing playing */ } ; setStatus('idle') }}
              className="h-10 px-3 rounded-lg border border-zinc-300 text-[12px] font-semibold text-zinc-700">Stop talking</button>
            <button onClick={() => lastReply.current && speak(lastReply.current)}
              className="h-10 px-3 rounded-lg border border-zinc-300 text-[12px] font-semibold text-zinc-700">Repeat</button>
            <button onClick={() => { setTurns([]); setResults([]); lastResults.current = []; setHeard('') }}
              className="h-10 px-3 rounded-lg border border-zinc-300 text-[12px] font-semibold text-zinc-700">Start over</button>
          </div>
        </div>
      </div>
    </div>
  )
}
