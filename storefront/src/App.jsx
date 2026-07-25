import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from './lib/supabase'
import { money, thumb, SHOP, PAYMENTS_ENABLED, EDGE_URL } from './lib/utils'

const WA = SHOP.whatsapp
const I = {
  home: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  grid: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
  bag: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4zM3 6h18"/><path d="M16 10a4 4 0 01-8 0"/></svg>,
  search: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>,
  x: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  minus: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/></svg>,
  plus: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>,
  pin: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  phone: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>,
  arrow: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>,
  check: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>,
  fire: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 23c-3.6 0-7-2.4-7-7 0-3.1 2.1-5.7 3.4-7.1.4-.4 1-.1 1 .4v1.3c0 .5.5.8.9.5C12.5 9.5 15 6 15 3c0-.5.5-.8.9-.5C18.5 4.5 21 8.4 21 12.5 21 18.3 17.3 23 12 23z"/></svg>,
  track: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0112 2a8 8 0 018 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>,
}

function Timer({ endDate }) {
  const [t, setT] = useState({})
  useEffect(() => {
    const calc = () => { const d = new Date(endDate) - new Date(); if (d <= 0) return { d: 0, h: 0, m: 0, s: 0 }; return { d: Math.floor(d / 864e5), h: Math.floor((d % 864e5) / 36e5), m: Math.floor((d % 36e5) / 6e4), s: Math.floor((d % 6e4) / 1e3) } }
    setT(calc()); const i = setInterval(() => setT(calc()), 1000); return () => clearInterval(i)
  }, [endDate])
  const p = n => String(n).padStart(2, '0')
  return <div className="flex gap-1">{[['d',t.d],['h',t.h],['m',t.m],['s',t.s]].map(([l,v]) => <div key={l} className="bg-white text-[var(--color-promo)] text-[11px] font-bold px-1.5 py-0.5 rounded font-mono min-w-[22px] text-center">{p(v||0)}<span className="text-[8px] text-gray-400 ml-0.5">{l}</span></div>)}</div>
}

function Card({ p, promo, onOpen, onAdd }) {
  const [ok, setOk] = useState(false)
  const add = e => { e.stopPropagation(); onAdd(); setOk(true); setTimeout(() => setOk(false), 1200) }
  return (
    <div className="cursor-pointer group card-lift" onClick={onOpen}>
      <div className="aspect-[3/4] bg-stone-100 rounded-2xl overflow-hidden mb-2.5 relative">
        {p.image ? <img src={thumb(p.image, 500)} alt={p.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700 ease-out" loading="lazy" /> : <div className="w-full h-full bg-stone-100" />}
        {promo && <span className="absolute top-2.5 left-2.5 px-2.5 py-1 bg-[var(--color-promo)] text-white text-[8px] font-bold rounded-lg tracking-widest uppercase">Sale</span>}
        <button onClick={add} className={`absolute bottom-2.5 right-2.5 w-9 h-9 rounded-full flex items-center justify-center transition-all duration-300 ${ok ? 'bg-stone-700 text-white scale-110' : 'bg-white shadow-md text-stone-600 md:translate-y-2 md:opacity-0 md:group-hover:opacity-100 md:group-hover:translate-y-0'}`}>
          {ok ? I.check : I.plus}
        </button>
      </div>
      <div className="text-[9px] text-stone-400 uppercase tracking-[0.15em] font-medium">{p.category}</div>
      <div className="text-[13px] font-medium leading-snug mt-0.5 line-clamp-2 text-stone-800">{p.name}</div>
      <div className="flex items-center justify-between mt-1.5">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[14px] font-bold text-stone-900">{money(promo ? promo.price : p.price)}</span>
          {promo && <span className="text-[11px] text-stone-300 line-through">{money(p.price)}</span>}
        </div>
        <button onClick={add} className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all duration-200 btn-press ${ok ? 'bg-stone-700 text-white' : 'bg-stone-700 text-white hover:bg-stone-700'}`}>{ok ? '✓ Added' : 'Add'}</button>
      </div>
      {!promo && Number(p.wholesale_price || 0) > 0 && Number(p.wholesale_min_qty || 0) > 0 && (
        <div className="text-[9px] text-stone-400 mt-1">Buy {p.wholesale_min_qty}+ for {money(p.wholesale_price)} each</div>
      )}
    </div>
  )
}

export default function App() {
  const [products, setProducts] = useState([])
  const [promos, setPromos] = useState([])
  const [promoMap, setPromoMap] = useState({})
  const [bundles, setBundles] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState('home')
  const [sel, setSel] = useState(null)
  const [cart, setCart] = useState(() => { try { return JSON.parse(localStorage.getItem('etr_cart') || '[]') } catch { return [] } })
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState('all')
  const [showSearch, setShowSearch] = useState(false)
  const [custName, setCustName] = useState('')
  const [custPhone, setCustPhone] = useState('')
  const [custAddress, setCustAddress] = useState('')
  const [custNotes, setCustNotes] = useState('')
  const [fulfillment, setFulfillment] = useState('delivery') // 'delivery' or 'pickup'
  const [submitting, setSubmitting] = useState(false)
  const [orderResult, setOrderResult] = useState(null)
  const [retrying, setRetrying] = useState(false)
  const [retryWait, setRetryWait] = useState(0)
  const [checkoutStep, setCheckoutStep] = useState(1)
  const [trackQuery, setTrackQuery] = useState('')
  const [trackResult, setTrackResult] = useState(null)
  const [tracking, setTracking] = useState(false)
  const [toast, setToast] = useState('')
  const [recentlyViewed, setRecentlyViewed] = useState(() => { try { return JSON.parse(localStorage.getItem('etr_recent') || '[]') } catch { return [] } })
  const [zoomOpen, setZoomOpen] = useState(false)
  const [notifyPhone, setNotifyPhone] = useState('')
  const [notifySubmit, setNotifySubmit] = useState(false)
  const [notifyDone, setNotifyDone] = useState(false)
  const [shopOpen, setShopOpen] = useState(true)
  const [shopChecked, setShopChecked] = useState(false)
  const [closedMsg, setClosedMsg] = useState('We are currently closed. Please check back soon.')

  // Countdown before the customer can resend the prompt (avoids spamming).
  useEffect(() => {
    if (retryWait <= 0) return
    const t = setTimeout(() => setRetryWait(w => w - 1), 1000)
    return () => clearTimeout(t)
  }, [retryWait])

  const resendPrompt = async () => {
    if (!orderResult?.orderId || retrying || retryWait > 0) return
    setRetrying(true)
    try {
      const r = await fetch(EDGE_URL + '?action=nalopay-charge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: custPhone, amount: orderResult.total, reference: orderResult.orderNo + '-R' + Date.now().toString(36).toUpperCase(), orderNo: orderResult.orderNo, orderId: orderResult.orderId, customerName: custName, description: 'Order ' + orderResult.orderNo })
      })
      const j = await r.json()
      if (j.success) { setOrderResult(o => ({ ...o, promptOk: true })); setToast('Prompt sent again — check your phone'); setRetryWait(45) }
      else setToast(j.error || 'Could not resend. Please try again.')
    } catch { setToast('Network error — please try again') }
    setTimeout(() => setToast(''), 2500)
    setRetrying(false)
  }

  // Poll the order status while the customer approves the MoMo prompt, so the
  // page flips to "Payment received" by itself.
  useEffect(() => {
    if (page !== 'success' || !orderResult?.orderId) return
    if (orderResult.status === 'Paid' || orderResult.status === 'Completed') return
    let n = 0
    const iv = setInterval(async () => {
      n++
      if (n > 200) { clearInterval(iv); return } // ~10 min
      try {
        const { data } = await supabase.from('whatsapp_orders').select('status').eq('id', orderResult.orderId).limit(1)
        const st = data?.[0]?.status
        if (st === 'Paid' || st === 'Completed') { clearInterval(iv); setOrderResult(o => ({ ...o, status: st })) }
      } catch {}
    }, 3000)
    return () => clearInterval(iv)
  }, [page, orderResult?.orderId, orderResult?.status]) // eslint-disable-line

  // Broken product images (dead Cloudinary links) show a clean placeholder
  // instead of the browser's broken-image icon.
  useEffect(() => {
    const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#f1f0ee"/><path d="M30 62l12-14 8 9 6-7 10 12H30z" fill="#d6d3ce"/><circle cx="38" cy="36" r="6" fill="#d6d3ce"/></svg>'
    )
    const onErr = (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.src !== PLACEHOLDER) { t.src = PLACEHOLDER; t.style.objectFit = 'cover' } }
    window.addEventListener('error', onErr, true)
    return () => window.removeEventListener('error', onErr, true)
  }, [])

  // Read the shared on/off switch (set from the POS) + live updates
  useEffect(() => {
    console.log('[ERB] shop-switch build v2 active')
    let active = true
    const load = async () => {
      try {
        // limit(1) instead of single() so a missing/duplicate row can't throw;
        // only depend on shop_open so a missing closed_message column can't fail it.
        const { data, error } = await supabase.from('store_settings').select('shop_open,closed_message').limit(1)
        if (!active) return
        if (error) { console.error('store_settings read error:', error.message) }
        const row = Array.isArray(data) ? data[0] : null
        if (row) {
          setShopOpen(row.shop_open === true)
          if (row.closed_message) setClosedMsg(row.closed_message)
        }
      } catch (e) { console.error('store_settings load failed:', e) }
      if (active) setShopChecked(true)
    }
    load()
    const ch = supabase.channel('store_settings_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'store_settings' }, payload => {
        const r = payload.new || {}
        if ('shop_open' in r) setShopOpen(r.shop_open === true)
        if (r.closed_message) setClosedMsg(r.closed_message)
      })
      .subscribe()
    return () => { active = false; supabase.removeChannel(ch) }
  }, [])

  useEffect(() => { try { localStorage.setItem('etr_cart', JSON.stringify(cart)) } catch {} }, [cart])
  useEffect(() => { window.scrollTo(0, 0) }, [page])

  useEffect(() => {
    supabase.from('products').select('id,name,category,price,wholesale_price,wholesale_min_qty,quantity,image,created_at').order('created_at', { ascending: false }).then(({ data }) => {
      setProducts((data || []).filter(p => p.quantity > 0))
      setLoading(false)
    })
    supabase.from('promos').select('*').eq('active', true).then(({ data, error }) => {
      if (error) { console.error('Promo load error:', error); return }
      console.log('Raw promos:', JSON.stringify(data))
      if (!data?.length) { console.log('No active promos found'); return }
      const now = new Date(), map = {}, active = []
      for (const p of data) {
        // Skip future promos
        if (p.start_date && new Date(p.start_date) > now) { console.log('Skipping future promo:', p.name); continue }
        // Skip expired promos (but allow promos with no end date)
        if (p.end_date && new Date(p.end_date) < now) { console.log('Skipping expired promo:', p.name); continue }
        
        let items
        try {
          items = typeof p.items === 'string' ? JSON.parse(p.items) : p.items
        } catch (e) { console.log('Failed to parse items for:', p.name); continue }
        if (!Array.isArray(items)) { console.log('Items not array for:', p.name, typeof items); continue }
        
        active.push(p)
        for (const it of items) {
          const pid = it.productId || it.product_id || it.id
          const pp = Number(it.promoPrice || it.promo_price || it.price || 0)
          if (pid && pp > 0 && (!map[pid] || pp < map[pid].price)) {
            map[pid] = { price: pp, name: p.name }
          }
        }
      }
      console.log('Active promos:', active.length, 'Mapped products:', Object.keys(map).length)
      setPromoMap(map); setPromos(active)
    })
    supabase.from('bundles').select('id,name,bundle_price,products,active').eq('active', true).then(({ data }) => {
      if (data?.length) setBundles(data.map(b => ({ ...b, products: typeof b.products === 'string' ? JSON.parse(b.products) : b.products || [] })))
    })
  }, [])

  useEffect(() => {
    const handle = () => { const h = window.location.hash.slice(1); if (h.startsWith('/product/')) { const p = products.find(x => x.id === h.replace('/product/','')); if (p) { setSel(p); setPage('product') } } else if (h === '/shop') setPage('shop'); else if (h === '/cart') setPage('cart'); else if (h === '/track') setPage('track'); else if (h === '/checkout') setPage('checkout'); else if (h === '/success') { /* stay on success */ } else setPage('home') }
    window.addEventListener('hashchange', handle); handle(); return () => window.removeEventListener('hashchange', handle)
  }, [products])

  const go = (p, h) => { setPage(p); window.location.hash = h || '/' }
  const open = p => {
    setSel(p); go('product', `/product/${p.id}`); setZoomOpen(false); setNotifyDone(false); setNotifyPhone('')
    // Track recently viewed
    setRecentlyViewed(prev => {
      const filtered = prev.filter(x => x.id !== p.id)
      const updated = [{ id: p.id, name: p.name, price: p.price, image: p.image, category: p.category }, ...filtered].slice(0, 10)
      try { localStorage.setItem('etr_recent', JSON.stringify(updated)) } catch {}
      return updated
    })
  }
  const cats = useMemo(() => ['all', ...[...new Set(products.filter(p => p.category).map(p => p.category))].sort()], [products])
  // Category tiles: each category with the first in-stock product image as its cover.
  const catTiles = useMemo(() => {
    const seen = {}
    for (const p of products) {
      if (p.category && p.image && !seen[p.category]) seen[p.category] = p.image
    }
    return Object.entries(seen).map(([name, img]) => ({ name, img })).slice(0, 12)
  }, [products])
  const filtered = useMemo(() => { const q = search.toLowerCase(); return products.filter(p => (!q || p.name.toLowerCase().includes(q)) && (cat === 'all' || p.category === cat)) }, [products, search, cat])

  const addToCart = p => {
    setCart(prev => {
      const ex = prev.find(c => c.id === p.id)
      const promoPrice = promoMap[p.id] ? promoMap[p.id].price : null
      const wp = Number(p.wholesale_price || 0)
      const wm = Number(p.wholesale_min_qty || 0)
      const retailPrice = promoPrice || Number(p.price)

      let updated
      if (ex) {
        updated = prev.map(c => c.id === p.id ? { ...c, qty: c.qty + 1 } : c)
      } else {
        updated = [...prev, { id: p.id, name: p.name, price: retailPrice, retailPrice, wp, wm, qty: 1, img: p.image, category: p.category, isWholesale: false }]
      }

      // Recalculate wholesale across all items in same category
      return recalcWholesale(updated, products, promoMap)
    })
    setToast('Added to cart'); setTimeout(() => setToast(''), 1500)
  }

  const updQty = (id, d) => setCart(prev => {
    const updated = prev.map(c => c.id === id ? { ...c, qty: Math.max(0, c.qty + d) } : c).filter(c => c.qty > 0)
    return recalcWholesale(updated, products, promoMap)
  })

  const removeFromCart = id => setCart(prev => prev.filter(c => c.id !== id))
  const clearCart = () => { setCart([]); setToast('Cart cleared'); setTimeout(() => setToast(''), 1500) }
  const cc = cart.reduce((a, c) => a + c.qty, 0)
  const ct = cart.reduce((a, c) => a + c.price * c.qty, 0)
  const gp = p => promoMap[p.id] ? promoMap[p.id].price : Number(p.price)

  // Recalculate wholesale across category — if total qty in same category >= wholesale min, all get wholesale price
  const recalcWholesale = (cartItems, allProducts, promos) => {
    // Group cart items by category
    const catTotals = {}
    cartItems.forEach(c => {
      if (!c.category) return
      catTotals[c.category] = (catTotals[c.category] || 0) + c.qty
    })

    return cartItems.map(c => {
      const hasPromo = promos[c.id]
      if (hasPromo) return { ...c, price: hasPromo.price, isWholesale: false } // Promo takes priority

      const wp = Number(c.wp || 0)
      const wm = Number(c.wm || 0)
      if (wp <= 0 || wm <= 0) return { ...c, price: c.retailPrice, isWholesale: false }

      // Check if total qty in this category reaches wholesale minimum
      const categoryTotal = catTotals[c.category] || 0
      const useWholesale = categoryTotal >= wm

      return { ...c, price: useWholesale ? wp : c.retailPrice, isWholesale: useWholesale }
    })
  }

  // Share product
  const shareProduct = (p) => {
    const url = `${window.location.origin}/#/product/${p.id}`
    const text = `Check out ${p.name} — ${money(gp(p))} at BEDTIME BEDDINGS HOME`
    if (navigator.share) {
      navigator.share({ title: p.name, text, url }).catch(() => {})
    } else {
      navigator.clipboard?.writeText(`${text}\n${url}`)
      setToast('Link copied'); setTimeout(() => setToast(''), 1500)
    }
  }

  // Notify when back in stock
  const notifyBackInStock = async (productId) => {
    if (!notifyPhone.trim() || notifyPhone.trim().length < 10) { setToast('Enter a valid phone number'); setTimeout(() => setToast(''), 2000); return }
    setNotifySubmit(true)
    await supabase.from('stock_notifications').insert({ product_id: productId, phone: notifyPhone.trim() })
    setNotifyDone(true); setNotifySubmit(false)
    setToast('We\'ll notify you when it\'s back'); setTimeout(() => setToast(''), 2000)
  }

  // Promo products
  const promoProducts = useMemo(() => products.filter(p => promoMap[p.id]), [products, promoMap])
  // "Trending" — shuffle products deterministically by day
  const trending = useMemo(() => { const day = new Date().getDate(); return [...products].sort((a, b) => ((a.id.charCodeAt(0) + day) % 7) - ((b.id.charCodeAt(0) + day) % 7)).slice(0, 6) }, [products])

  // Hero slideshow — pick products with images for banner
  const heroProducts = useMemo(() => products.filter(p => p.image).slice(0, 5), [products])
  const [heroIdx, setHeroIdx] = useState(0)
  useEffect(() => {
    if (heroProducts.length <= 1) return
    const i = setInterval(() => setHeroIdx(prev => (prev + 1) % heroProducts.length), 4000)
    return () => clearInterval(i)
  }, [heroProducts.length])

  const placeOrder = async () => {
    const name = custName.trim().replace(/[<>]/g, '')
    const phone = custPhone.trim().replace(/[^0-9+\s]/g, '')
    const addr = custAddress.trim().replace(/[<>]/g, '')
    const notes = custNotes.trim().replace(/[<>]/g, '')
    if (!name || !phone) return
    if (phone.length < 10) { setToast('Enter a valid phone number'); setTimeout(() => setToast(''), 2000); return }
    if (fulfillment === 'delivery' && !custAddress.trim()) { setToast('Enter delivery address'); setTimeout(() => setToast(''), 2000); return }
    if (cart.length === 0) return

    // LIVE STOCK CHECK — the catalogue was loaded when the page opened, so during
    // a busy sale an item may have sold out since. Re-check right before taking
    // money so we never sell what we don't have.
    setSubmitting(true)
    try {
      const ids = cart.map(c => c.id).filter(Boolean)
      if (ids.length) {
        const { data: live } = await supabase.from('products').select('id,name,quantity').in('id', ids)
        const short = []
        for (const c of cart) {
          const p = (live || []).find(x => x.id === c.id)
          const have = p ? Number(p.quantity) || 0 : 0
          if (have < c.qty) short.push({ name: c.name, have })
        }
        if (short.length) {
          setSubmitting(false)
          const first = short[0]
          setToast(first.have === 0 ? `${first.name} just sold out` : `Only ${first.have} left of ${first.name}`)
          setTimeout(() => setToast(''), 4000)
          // Trim the cart to what's actually available so they can still check out.
          setCart(prev => prev.map(c => {
            const p = (live || []).find(x => x.id === c.id)
            const have = p ? Number(p.quantity) || 0 : 0
            return have <= 0 ? null : (c.qty > have ? { ...c, qty: have } : c)
          }).filter(Boolean))
          setProducts(prev => prev.map(p => {
            const l = (live || []).find(x => x.id === p.id)
            return l ? { ...p, quantity: Number(l.quantity) || 0 } : p
          }).filter(p => p.quantity > 0))
          return
        }
      }
    } catch { /* if the check fails, continue — don't block a sale on a network blip */ }

    const lastOrder = Number(sessionStorage.getItem('last_order') || 0)
    if (Date.now() - lastOrder < 30000) { setSubmitting(false); setToast('Please wait before placing another order'); setTimeout(() => setToast(''), 2000); return }

    setSubmitting(true)
    const orderNo = 'WEB-' + Date.now().toString(36).toUpperCase()
    const items = cart.map(c => ({ name: c.name.replace(/[<>]/g, ''), qty: c.qty, price: c.price, lineTotal: c.price * c.qty, productId: c.id }))
    const { data: mc } = await supabase.from('whatsapp_orders').select('ussd_code').order('ussd_code', { ascending: false }).limit(1)
    const uc = (mc?.[0]?.ussd_code || 0) + 1
    const orderNotes = ['DELIVERY', notes || ''].filter(Boolean).join(' | ')

    // Create order (Pending) and show USSD code
    const { data: inserted, error } = await supabase.from('whatsapp_orders').insert({ order_no: orderNo, date: new Date().toISOString(), customer_name: name, customer_phone: phone, items: JSON.stringify(items), subtotal: ct, total: ct, address: addr || null, notes: orderNotes, status: 'Pending', ussd_code: uc, source: 'web', details_filled: true }).select('id').single()

    if (error) { setSubmitting(false); setToast('Error placing order'); setTimeout(() => setToast(''), 2000); return }

    // Online payment (MoMo prompt) only if enabled for this brand. Otherwise the
    // order is placed and the shop contacts the customer to arrange payment.
    let promptOk = false, promptErr = ''
    if (PAYMENTS_ENABLED) {
      try {
        const r = await fetch(EDGE_URL + '?action=nalopay-charge', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, amount: ct, reference: orderNo, orderNo, orderId: inserted?.id, customerName: name, description: 'Order ' + orderNo })
        })
        const j = await r.json()
        promptOk = !!j.success
        if (!promptOk) promptErr = j.error || 'Could not send prompt'
      } catch (e) { promptErr = 'Network error' }
    }

    sessionStorage.setItem('last_order', String(Date.now()))
    setOrderResult({ orderNo, orderId: inserted?.id, ussdCode: uc, total: ct, fulfillment, promptOk, promptErr, status: 'Pending' })
    setCart([])
    setPage('success')
    window.location.hash = '/success'
    setSubmitting(false)
  }

  const trackOrder = async () => {
    if (!trackQuery.trim()) return; setTracking(true); const q = trackQuery.trim()
    const { data } = await supabase.from('whatsapp_orders').select('order_no,status,total,customer_name,tracking_no,delivery_status,delivery_guy,delivered_at,date').or(`customer_phone.ilike.%${q}%,order_no.ilike.%${q}%,tracking_no.ilike.%${q}%`).order('date', { ascending: false }).limit(5)
    setTrackResult(data || []); setTracking(false)
  }

  const activePromo = promos.find(p => p.end_date && new Date(p.end_date) > new Date())

  if (loading) return <div className="min-h-screen bg-white flex items-center justify-center"><div className="w-7 h-7 border-[2.5px] border-stone-200 border-t-stone-700 rounded-full animate-spin" /></div>

  // Shop turned OFF from the POS — show a closed screen, no ordering.
  if (shopChecked && !shopOpen) return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center text-center px-6" style={{ fontFamily: 'var(--font-body)' }}>
      <div className="text-[11px] tracking-[0.3em] uppercase text-stone-400 mb-6">{SHOP.name}</div>
      <div className="w-16 h-16 rounded-2xl bg-stone-900 flex items-center justify-center mb-7">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
      </div>
      <h1 className="text-3xl md:text-4xl font-bold text-stone-900 mb-3" style={{ fontFamily: 'var(--font-display, serif)' }}>We'll be right back</h1>
      <p className="text-stone-500 text-base max-w-sm mb-8">{closedMsg}</p>
      <a href={`https://wa.me/${SHOP.whatsapp}`} className="inline-flex items-center gap-2 px-6 py-3 bg-stone-900 text-white rounded-full text-sm font-semibold">
        Message us on WhatsApp
      </a>
    </div>
  )

  return (
    <div className="min-h-screen bg-white pb-16 md:pb-0" style={{ fontFamily: 'var(--font-body)' }}>

      {/* PROMO BANNER */}
      {activePromo && <div className="bg-[var(--color-promo)] relative overflow-hidden"><div className="max-w-7xl mx-auto px-4 h-10 flex items-center justify-center gap-3 text-xs text-white relative z-10"><span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /><span className="font-bold uppercase tracking-wide truncate">{activePromo.name}</span><span className="hidden sm:inline text-white/70">ends in</span><Timer endDate={activePromo.end_date} /><button onClick={() => go('shop', '/shop')} className="ml-1 h-6 px-3 bg-white text-[var(--color-promo)] rounded-full text-[10px] font-bold hover:bg-white/90 transition">Shop Now</button></div></div>}

      {/* TOAST */}
      {toast && <div className="fixed top-16 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-5 py-2 rounded-full text-sm font-medium z-[100] shadow-lg" style={{ animation: 'fadeIn 0.2s ease' }}>{toast}</div>}

      {/* NAV */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-stone-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <button onClick={() => go('home', '/')} className="font-bold text-base tracking-tight text-stone-900 shrink-0" style={{ fontFamily: 'var(--font-body)' }}>BEDTIME BEDDINGS HOME</button>
          <div className="hidden md:flex items-center gap-6">
            {[['Home','home','/'],['Shop','shop','/shop'],['Track','track','/track']].map(([l,p,h]) => <button key={p} onClick={() => go(p,h)} className={`text-xs font-semibold transition ${page === p ? 'text-stone-700' : 'text-stone-400 hover:text-stone-600'}`}>{l}</button>)}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => { setShowSearch(!showSearch); if (page !== 'shop') go('shop','/shop') }} className="w-10 h-10 flex items-center justify-center rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-50 transition">{I.search}</button>
            <button onClick={() => go('cart','/cart')} className="relative w-10 h-10 flex items-center justify-center rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-50 transition"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>{cc > 0 && <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 bg-stone-700 text-white text-[8px] font-bold rounded-full flex items-center justify-center px-1">{cc}</span>}</button>
          </div>
        </div>
        {showSearch && <div className="px-4 sm:px-6 pb-3 max-w-7xl mx-auto"><input autoFocus className="w-full h-11 px-4 bg-stone-50 rounded-xl text-sm focus:outline-none border border-stone-200 focus:border-stone-700 transition" placeholder="What are you looking for?" value={search} onChange={e => setSearch(e.target.value)} /></div>}
      </nav>

      {/* ═══ HOME ═══ */}
      {page === 'home' && <>
        {/* Hero — rotating product images */}
        <section className="relative overflow-hidden bg-[var(--color-brand)]" style={{ height: 'min(68vh, 520px)' }}>
          {heroProducts.map((p, i) => (
            <div key={p.id} className="absolute inset-0 transition-opacity duration-1000 ease-in-out" style={{ opacity: i === heroIdx ? 1 : 0 }}>
              <img src={thumb(p.image, 1200)} alt="" className="w-full h-full object-cover" style={{ filter: 'brightness(0.62) saturate(1.05)' }} />
            </div>
          ))}
          <div className="absolute inset-0 bg-gradient-to-t from-[#2a2521]/80 via-[#2a2521]/35 to-transparent z-[1]" />
          <div className="relative z-10 h-full flex flex-col justify-end max-w-7xl mx-auto px-4 sm:px-6 pb-10">
            <div className="inline-flex items-center gap-1.5 text-amber-200 text-[10px] font-semibold tracking-[0.25em] uppercase mb-3">
              Bedtime Beddings Home
            </div>
            <h1 className="text-white text-3xl md:text-5xl font-bold leading-tight mb-3" style={{ fontFamily: 'var(--font-display)' }}>Sleep better,<br />every single night.</h1>
            <p className="text-stone-200/60 text-sm max-w-md mb-6">Soft bedsheets, warm duvets and everything that makes your bed a place you look forward to.</p>
            <div className="flex items-center gap-3">
              <button onClick={() => go('shop', '/shop')} className="h-11 px-7 bg-white text-stone-700 rounded-full text-xs font-bold hover:bg-stone-100 transition btn-press flex items-center gap-2">Shop Collection {I.arrow}</button>
              <a href={`tel:${SHOP.phone.replace(/\s/g,'')}`} className="h-11 px-5 border border-amber-200/30 text-amber-200 rounded-full text-xs font-medium hover:bg-white/5 transition flex items-center gap-1.5">{I.phone} Call Us</a>
            </div>
            <div className="flex gap-2 mt-6">
              {heroProducts.map((_, i) => (
                <button key={i} onClick={() => setHeroIdx(i)} className={`rounded-full transition-all duration-500 ${i === heroIdx ? 'w-8 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/25 hover:bg-white/40'}`} />
              ))}
            </div>
          </div>
        </section>

        {/* Search bar on mobile */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-4 md:hidden">
          <button onClick={() => { setShowSearch(true); go('shop','/shop') }} className="w-full h-10 px-4 bg-gray-50 rounded-xl text-sm text-gray-400 text-left flex items-center gap-2 border border-gray-100">
            {I.search} Search products...
          </button>
        </div>

        {/* Big bold offer card — shows when there's an active promo */}
        {activePromo && (
          <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
            <div className="relative overflow-hidden rounded-3xl bg-[#1a1d29] text-white px-6 py-8 sm:px-10 sm:py-10 text-center">
              <div className="relative z-10">
                <div className="text-[10px] font-bold tracking-[0.3em] uppercase text-amber-200 mb-2">Limited offer</div>
                <div className="text-4xl sm:text-6xl font-black leading-none mb-2" style={{ fontFamily: 'var(--font-display)' }}>{activePromo.name}</div>
                {activePromo.end_date && <div className="flex justify-center mb-5"><Timer endDate={activePromo.end_date} /></div>}
                <button onClick={() => go('shop','/shop')} className="h-11 px-8 bg-[var(--color-brand)] text-white rounded-full text-sm font-bold hover:bg-[var(--color-brand-light)] transition inline-flex items-center gap-2">Shop the sale {I.arrow}</button>
              </div>
              <div className="absolute -left-10 -bottom-12 w-48 h-48 rounded-full bg-[var(--color-brand)]/20" />
              <div className="absolute -right-8 -top-10 w-36 h-36 rounded-full bg-[var(--color-brand)]/15" />
            </div>
          </section>
        )}

        {/* Category tiles — visual, tappable */}
        {catTiles.length > 0 && (
          <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold">Shop by category</h2>
              <button onClick={() => go('shop','/shop')} className="text-[11px] text-gray-400 font-medium flex items-center gap-0.5">All {I.arrow}</button>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
              {catTiles.map(({ name, img }) => (
                <button key={name} onClick={() => { setCat(name); setTimeout(() => go('shop','/shop'), 0) }} className="group relative aspect-square rounded-2xl overflow-hidden bg-gray-100">
                  {img && <img src={thumb(img, 300)} className="w-full h-full object-cover group-hover:scale-105 transition duration-500" />}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
                  <span className="absolute bottom-2 left-2 right-2 text-white text-[11px] font-bold leading-tight capitalize text-left">{name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Promo products — horizontal scroll */}
        {promoProducts.length > 0 && (
          <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
            <div className="flex items-center gap-2 mb-3">
              
              <h2 className="text-sm font-bold">Promo Deals</h2>
              <button onClick={() => go('shop','/shop')} className="ml-auto text-[11px] text-gray-400 font-medium">See All {I.arrow}</button>
            </div>
            <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-2">
              {promoProducts.map(p => (
                <div key={p.id} onClick={() => open(p)} className="min-w-[140px] max-w-[140px] flex-shrink-0 cursor-pointer group">
                  <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden relative mb-1.5">
                    {p.image && <img src={thumb(p.image, 300)} className="w-full h-full object-cover" />}
                    <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 bg-[var(--color-promo)] text-white text-[8px] font-bold rounded">PROMO</span>
                  </div>
                  <div className="text-[11px] font-medium line-clamp-2 leading-snug">{p.name}</div>
                  <div className="flex items-baseline gap-1 mt-0.5"><span className="text-[12px] font-bold">{money(promoMap[p.id].price)}</span><span className="text-[10px] text-gray-300 line-through">{money(p.price)}</span></div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Promo & Bundle Showcase — replaces trending */}
        {(promoProducts.length > 0 || bundles.length > 0) && (
          <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold">Deals For You</h2>
              <button onClick={() => go('shop','/shop')} className="text-[11px] text-gray-400 font-medium flex items-center gap-0.5">See All {I.arrow}</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {/* Bundles first */}
              {bundles.slice(0, 2).map(b => {
                const bundleProducts = b.products.map(bp => products.find(p => p.id === (bp.productId || bp.product_id))).filter(Boolean)
                const normalTotal = bundleProducts.reduce((sum, p) => sum + Number(p.price), 0)
                const savings = normalTotal - Number(b.bundle_price)
                const firstImg = bundleProducts.find(p => p.image)
                return (
                  <div key={b.id} className="bg-gray-50 rounded-xl overflow-hidden">
                    <div className="aspect-[4/3] bg-gray-100 relative">
                      {firstImg?.image && <img src={thumb(firstImg.image, 400)} className="w-full h-full object-cover" />}
                      <span className="absolute top-2 left-2 px-2 py-0.5 bg-stone-700 text-white text-[8px] font-bold rounded-md tracking-wide">BUNDLE</span>
                    </div>
                    <div className="p-2.5">
                      <div className="text-[11px] font-semibold line-clamp-2">{b.name}</div>
                      <div className="flex items-baseline gap-1.5 mt-1">
                        <span className="text-[13px] font-bold">{money(b.bundle_price)}</span>
                        {savings > 0 && <span className="text-[10px] text-gray-300 line-through">{money(normalTotal)}</span>}
                      </div>
                      {savings > 0 && <div className="text-[9px] font-bold text-stone-700 mt-0.5">Save {money(savings)}</div>}
                    </div>
                  </div>
                )
              })}
              {/* Then promo products */}
              {promoProducts.slice(0, bundles.length >= 2 ? 2 : 4).map(p => (
                <div key={p.id} onClick={() => open(p)} className="cursor-pointer group">
                  <div className="aspect-[4/3] bg-gray-100 rounded-xl overflow-hidden relative">
                    {p.image && <img src={thumb(p.image, 400)} className="w-full h-full object-cover group-hover:scale-[1.03] transition duration-500" />}
                    <span className="absolute top-2 left-2 px-2 py-0.5 bg-[var(--color-promo)] text-white text-[8px] font-bold rounded-md">PROMO</span>
                  </div>
                  <div className="mt-2">
                    <div className="text-[11px] font-medium line-clamp-2 leading-snug">{p.name}</div>
                    <div className="flex items-baseline gap-1.5 mt-0.5">
                      <span className="text-[13px] font-bold">{money(promoMap[p.id].price)}</span>
                      <span className="text-[10px] text-gray-300 line-through">{money(p.price)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* New Arrivals */}
        {products.length > 0 && (
          <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold">New arrivals</h2>
              <button onClick={() => go('shop','/shop')} className="text-[11px] text-gray-400 font-medium flex items-center gap-0.5">See all {I.arrow}</button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-3 gap-y-5">
              {products.slice(0, 10).map(p => <Card key={p.id} p={p} promo={promoMap[p.id]} onOpen={() => open(p)} onAdd={() => addToCart(p)} />)}
            </div>
          </section>
        )}

        {/* Recently Viewed on Home */}
        {recentlyViewed.length > 0 && (
          <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-6">
            <h2 className="text-sm font-bold mb-3">Recently Viewed</h2>
            <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-2">
              {recentlyViewed.map(r => {
                const p = products.find(x => x.id === r.id)
                if (!p) return null
                return (
                  <div key={r.id} onClick={() => open(p)} className="min-w-[120px] max-w-[120px] shrink-0 cursor-pointer">
                    <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden mb-1.5">{r.image && <img src={thumb(r.image, 250)} className="w-full h-full object-cover" />}</div>
                    <div className="text-[10px] font-medium line-clamp-1">{r.name}</div>
                    <div className="text-[10px] font-bold">{money(gp(p))}</div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* All products */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 pt-8 pb-6">
          {products.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-14 h-14 rounded-2xl bg-[var(--color-cream-dark)] flex items-center justify-center mx-auto mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand)" strokeWidth="1.5"><path d="M2 4h20v5H2zM4 9v11h16V9M9 13h6"/></svg>
              </div>
              <h2 className="text-base font-bold text-stone-800 mb-1" style={{ fontFamily: 'var(--font-display)' }}>New arrivals coming soon</h2>
              <p className="text-sm text-stone-500 max-w-xs mx-auto">We're getting our bedding collection ready. Check back shortly or call us to order.</p>
              <a href={`tel:${SHOP.phone.replace(/\s/g,'')}`} className="inline-flex items-center gap-2 mt-5 h-10 px-6 bg-[var(--color-brand)] text-white rounded-full text-xs font-bold">{I.phone} {SHOP.phone}</a>
            </div>
          ) : (<>
          <h2 className="text-sm font-bold mb-3">All Products</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-3 gap-y-5">
            {products.slice(0, 20).map(p => <Card key={p.id} p={p} promo={promoMap[p.id]} onOpen={() => open(p)} onAdd={() => addToCart(p)} />)}
          </div>
          {products.length > 20 && <div className="text-center mt-8"><button onClick={() => go('shop','/shop')} className="h-10 px-8 border border-gray-200 rounded-lg text-xs font-semibold text-gray-500 hover:bg-gray-50 transition">View all {products.length} products</button></div>}
          </>)}
        </section>
      </>}

      {/* ═══ SHOP ═══ */}
      {page === 'shop' && <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
        <div className="flex items-center justify-between mb-4"><h1 className="text-base font-bold" style={{ fontFamily: 'var(--font-display)' }}>{cat === 'all' ? 'All Products' : cat}</h1><span className="text-xs text-gray-300">{filtered.length} items</span></div>
        <div className="flex gap-2 overflow-x-auto scrollbar-hide mb-5">{cats.map(c => <button key={c} onClick={() => setCat(c)} className={`h-8 px-4 rounded-lg text-[11px] font-semibold whitespace-nowrap shrink-0 transition ${cat === c ? 'bg-stone-700 text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}>{c === 'all' ? 'All' : c}</button>)}</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-3 gap-y-5">{filtered.map(p => <Card key={p.id} p={p} promo={promoMap[p.id]} onOpen={() => open(p)} onAdd={() => addToCart(p)} />)}</div>
        {filtered.length === 0 && <p className="text-center py-20 text-gray-300 text-sm">No products found</p>}
      </div>}

      {/* ═══ PRODUCT ═══ */}
      {page === 'product' && sel && <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
        <button onClick={() => window.history.back()} className="text-[11px] text-gray-400 hover:text-gray-600 mb-4 inline-block">&larr; Back</button>
        <div className="grid md:grid-cols-2 gap-5 md:gap-10">
          {/* Image with zoom */}
          <div className="relative">
            <div onClick={() => setZoomOpen(true)} className="aspect-square bg-gray-100 rounded-2xl overflow-hidden cursor-zoom-in">
              {sel.image ? <img src={thumb(sel.image, 900)} alt={sel.name} className="w-full h-full object-cover" /> : <div className="w-full h-full" />}
            </div>
            <button onClick={() => setZoomOpen(true)} className="absolute bottom-3 right-3 w-8 h-8 bg-white/80 rounded-full flex items-center justify-center text-gray-500 shadow-sm backdrop-blur-sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>
            </button>
          </div>

          {/* Fullscreen zoom modal */}
          {zoomOpen && sel.image && (
            <div className="fixed inset-0 z-[200] bg-black/95 flex items-center justify-center" onClick={() => setZoomOpen(false)}>
              <button className="absolute top-4 right-4 w-10 h-10 bg-white/10 rounded-full flex items-center justify-center text-white">{I.x}</button>
              <img src={thumb(sel.image, 1400)} alt={sel.name} className="max-w-[95vw] max-h-[90vh] object-contain" />
            </div>
          )}

          <div className="flex flex-col justify-center">
            {sel.category && <p className="text-[10px] tracking-[0.2em] uppercase text-gray-400 mb-1.5">{sel.category}</p>}
            <h1 className="text-lg md:text-xl font-bold mb-3" style={{ fontFamily: 'var(--font-display)' }}>{sel.name}</h1>
            <div className="flex items-baseline gap-2 mb-6">
              <span className="text-xl font-bold">{money(gp(sel))}</span>
              {promoMap[sel.id] && <><span className="text-sm text-gray-300 line-through">{money(sel.price)}</span><span className="text-[10px] font-bold text-[var(--color-promo)] bg-red-50 px-1.5 py-0.5 rounded">PROMO</span></>}
            </div>

            {/* Wholesale info */}
            {Number(sel.wholesale_price || 0) > 0 && Number(sel.wholesale_min_qty || 0) > 0 && !promoMap[sel.id] && (
              <div className="mt-3 p-3 bg-gray-50 rounded-lg border border-gray-100">
                <div className="text-[11px] font-bold text-gray-700">Wholesale Available</div>
                <div className="text-[11px] text-gray-500 mt-0.5">Buy {sel.wholesale_min_qty}+ units at {money(sel.wholesale_price)} each</div>
              </div>
            )}

            {/* Quantity + Action buttons */}
            <div className="flex gap-2 items-center mb-3">
              <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
                <button onClick={() => { const c = cart.find(x => x.id === sel.id); if (c && c.qty > 1) updQty(sel.id, -1) }} className="w-9 h-11 flex items-center justify-center text-gray-400 hover:bg-gray-50">{I.minus}</button>
                <span className="w-8 text-center text-sm font-bold">{cart.find(x => x.id === sel.id)?.qty || 1}</span>
                <button onClick={() => { const c = cart.find(x => x.id === sel.id); if (c) updQty(sel.id, 1); else addToCart(sel) }} className="w-9 h-11 flex items-center justify-center text-gray-400 hover:bg-gray-50">{I.plus}</button>
              </div>
              <button onClick={() => addToCart(sel)} className="flex-1 h-11 bg-stone-700 text-white rounded-lg text-sm font-semibold hover:bg-stone-700 transition">Add to Cart</button>
              <a href={`https://wa.me/${WA}?text=${encodeURIComponent(`Hi, I'm interested in: ${sel.name} — ${money(gp(sel))}`)}`} target="_blank" className="h-11 px-3 bg-gray-100 text-gray-600 rounded-lg text-xs font-semibold hover:bg-gray-200 transition flex items-center gap-1">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#25d366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
              </a>
            </div>

            {/* Share button */}
            <button onClick={() => shareProduct(sel)} className="mt-3 w-full h-9 bg-gray-50 text-gray-500 rounded-lg text-xs font-semibold hover:bg-gray-100 transition flex items-center justify-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              Share this product
            </button>

            <div className="mt-5 pt-5 border-t border-gray-100 space-y-2 text-xs text-gray-400">
              <p className="flex items-center gap-1.5">{I.check} Fast delivery</p>
              <p className="flex items-center gap-1.5">{I.check} Secure MoMo payment</p>
              <p className="flex items-center gap-1.5">{I.phone} Call {SHOP.phone}</p>
            </div>
          </div>
        </div>

        {/* Similar products */}
        {products.filter(p => p.category === sel.category && p.id !== sel.id).length > 0 && <div className="mt-12"><h2 className="text-sm font-bold mb-3">Similar</h2><div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-3 gap-y-5">{products.filter(p => p.category === sel.category && p.id !== sel.id).slice(0, 5).map(p => <Card key={p.id} p={p} promo={promoMap[p.id]} onOpen={() => open(p)} onAdd={() => addToCart(p)} />)}</div></div>}

        {/* Recently Viewed */}
        {recentlyViewed.filter(r => r.id !== sel.id).length > 0 && (
          <div className="mt-12">
            <h2 className="text-sm font-bold mb-3">Recently Viewed</h2>
            <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-2">
              {recentlyViewed.filter(r => r.id !== sel.id).map(r => {
                const p = products.find(x => x.id === r.id)
                if (!p) return null
                return (
                  <div key={r.id} onClick={() => open(p)} className="min-w-[120px] max-w-[120px] shrink-0 cursor-pointer">
                    <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden mb-1.5">{r.image && <img src={thumb(r.image, 250)} className="w-full h-full object-cover" />}</div>
                    <div className="text-[10px] font-medium line-clamp-1">{r.name}</div>
                    <div className="text-[10px] font-bold">{money(gp(p))}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>}

      {/* ═══ CART ═══ */}
      {page === 'cart' && <div className="max-w-xl mx-auto px-4 sm:px-6 py-6 page-enter">
        <h1 className="text-lg font-bold mb-1" style={{ fontFamily: 'var(--font-display)' }}>Your Cart</h1>
        <p className="text-xs text-gray-400 mb-5">{cc > 0 ? `${cc} item${cc !== 1 ? 's' : ''} ready for checkout` : ''}</p>
        {cart.length === 0 ? <div className="text-center py-16"><div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center mx-auto mb-4"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="1.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg></div><p className="text-stone-800 text-sm mb-1">Nothing here yet</p><p className="text-gray-400 text-xs mb-5">Browse our collection and add items you love</p><button onClick={() => go('shop','/shop')} className="h-10 px-6 bg-stone-700 text-white rounded-full text-xs font-bold hover:bg-stone-700 transition btn-press">Start Shopping</button></div> : <>
          <div className="flex justify-end mb-3"><button onClick={clearCart} className="text-[11px] text-gray-400 hover:text-red-500 transition">Clear all</button></div>
          <div className="space-y-2.5 mb-5">{cart.map(c => <div key={c.id} className="flex gap-3 items-center p-3 rounded-xl bg-stone-50 border border-stone-100 relative group">
            <button onClick={() => removeFromCart(c.id)} className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-300 hover:bg-red-500 text-white rounded-full flex items-center justify-center transition opacity-0 group-hover:opacity-100 md:opacity-0">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
            <div className="w-14 h-14 bg-stone-100 rounded-xl overflow-hidden shrink-0">{c.img ? <img src={thumb(c.img, 150)} className="w-full h-full object-cover" /> : <div className="w-full h-full" />}</div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold truncate text-stone-800">{c.name}</div>
              <div className="flex items-center gap-1.5 mt-1">
                <span className="text-[13px] font-bold text-stone-900">{money(c.price)}</span>
                {c.isWholesale && <span className="text-[8px] font-bold bg-stone-100 text-stone-700 px-1.5 py-0.5 rounded-full">WHOLESALE</span>}
              </div>
            </div>
            <div className="flex items-center gap-1"><button onClick={() => updQty(c.id,-1)} className="w-7 h-7 rounded-lg bg-white flex items-center justify-center text-stone-600 border border-stone-200 hover:border-stone-700 transition">{I.minus}</button><span className="w-6 text-center text-[12px] font-bold text-stone-900">{c.qty}</span><button onClick={() => updQty(c.id,1)} className="w-7 h-7 rounded-lg bg-white flex items-center justify-center text-stone-600 border border-stone-200 hover:border-stone-700 transition">{I.plus}</button></div>
          </div>)}</div>
          <div className="bg-stone-700 text-white rounded-xl p-4 mb-4 flex justify-between items-center"><span className="text-sm text-stone-200">Total</span><span className="text-lg font-bold">{money(ct)}</span></div>
          <button onClick={() => { setCheckoutStep(1); setPage('checkout'); window.location.hash = '/checkout' }} className="w-full h-12 bg-stone-700 text-white rounded-full text-sm font-bold hover:bg-stone-700 transition btn-press flex items-center justify-center gap-2">Proceed to Checkout {I.arrow}</button>
          <p className="text-[10px] text-gray-300 text-center mt-3">Delivery arranged after checkout</p>
        </>}
      </div>}

      {/* ═══ CHECKOUT ═══ */}
      {page === 'checkout' && <div className="max-w-md mx-auto px-4 sm:px-6 py-6">
          <button onClick={() => go('cart','/cart')} className="text-[11px] text-gray-400 hover:text-stone-700 mb-5 inline-flex items-center gap-1">&larr; Back to cart</button>

          <h2 className="text-lg font-bold text-stone-700 mb-5" style={{ fontFamily: 'var(--font-display)' }}>Checkout</h2>

          {/* Delivery only (no pickup location yet) */}

          {/* Form */}
          <div className="space-y-3 mb-5">
            <input className="w-full h-11 px-3.5 bg-white border border-stone-200 rounded-xl text-sm text-stone-800 focus:outline-none focus:border-stone-700 transition" value={custName} onChange={e => setCustName(e.target.value)} placeholder="Full name" />
            <input className="w-full h-11 px-3.5 bg-white border border-stone-200 rounded-xl text-sm text-stone-800 focus:outline-none focus:border-stone-700 transition" value={custPhone} onChange={e => setCustPhone(e.target.value)} placeholder="Phone number" type="tel" />
            <textarea className="w-full h-16 px-3.5 py-2.5 bg-white border border-stone-200 rounded-xl text-sm text-stone-800 focus:outline-none focus:border-stone-700 transition resize-none" value={custAddress} onChange={e => setCustAddress(e.target.value)} placeholder="Delivery address (area, landmark)" />
            <input className="w-full h-11 px-3.5 bg-white border border-stone-200 rounded-xl text-sm text-stone-800 focus:outline-none focus:border-stone-700 transition" value={custNotes} onChange={e => setCustNotes(e.target.value)} placeholder="Notes (optional)" />
          </div>

          {/* Order summary */}
          <div className="bg-stone-50 border border-stone-100 rounded-xl p-4 mb-4">
            {cart.map(c => <div key={c.id} className="flex justify-between text-[12px] py-0.5"><span className="text-gray-500">{c.qty}× {c.name}</span><span className="font-semibold text-stone-800">{money(c.price*c.qty)}</span></div>)}
            <div className="flex justify-between font-bold text-sm border-t border-stone-200 pt-2 mt-2 text-stone-900"><span>Total</span><span>{money(ct)}</span></div>
          </div>

          <p className="text-xs text-gray-500 text-center mb-3">{PAYMENTS_ENABLED ? 'A Mobile Money request will be sent to your phone to approve.' : "We'll call you to confirm your order and arrange payment."}</p>

          <button onClick={placeOrder} disabled={!custName.trim() || !custPhone.trim() || (fulfillment === 'delivery' && !custAddress.trim()) || submitting} className="w-full h-12 bg-stone-700 text-white rounded-full text-sm font-bold hover:bg-stone-700 transition btn-press disabled:opacity-30 flex items-center justify-center gap-2">
            {submitting ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {PAYMENTS_ENABLED ? 'Sending request…' : 'Placing order…'}</> : <>{PAYMENTS_ENABLED ? `Pay ${money(ct)}` : `Place Order · ${money(ct)}`}</>}
          </button>
        </div>}

      {/* ═══ SUCCESS ═══ */}
      {page === 'success' && orderResult && (() => {
        const paid = orderResult.status === 'Paid' || orderResult.status === 'Completed'
        return (
        <div className="max-w-sm mx-auto px-5 py-12">

          {!PAYMENTS_ENABLED ? (
            <>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-9 h-9 rounded-full bg-stone-700 flex items-center justify-center flex-shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                </div>
                <div>
                  <h1 className="text-lg font-bold text-gray-900" style={{ fontFamily: 'var(--font-display)' }}>Order received</h1>
                  <p className="text-xs text-gray-500">{money(orderResult.total)} · {orderResult.orderNo}</p>
                </div>
              </div>
              <div className="border-t border-gray-100 pt-5 mb-6">
                <p className="text-sm text-gray-600 leading-relaxed">
                  Thank you. We've received your order and will call you on <span className="text-gray-900 font-medium">{custPhone}</span> shortly to confirm and arrange payment and delivery.
                </p>
              </div>
            </>
          ) : paid ? (
            <>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-9 h-9 rounded-full bg-stone-700 flex items-center justify-center flex-shrink-0">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                </div>
                <div>
                  <h1 className="text-lg font-bold text-gray-900" style={{ fontFamily: 'var(--font-display)' }}>Payment received</h1>
                  <p className="text-xs text-gray-500">{money(orderResult.total)} · {orderResult.orderNo}</p>
                </div>
              </div>

              <div className="border-t border-gray-100 pt-5 mb-6">
                <p className="text-sm text-gray-600 leading-relaxed">
                  {orderResult.fulfillment === 'pickup'
                    ? <>We're preparing your order. Our delivery team will call you on <span className="text-gray-900 font-medium">{custPhone}</span> to arrange delivery.</>
                    : <>We're preparing your order. Our delivery team will call you on <span className="text-gray-900 font-medium">{custPhone}</span> to arrange delivery.</>}
                </p>
                <p className="text-sm text-gray-600 mt-3">We've sent your order details by SMS.</p>
              </div>
            </>
          ) : orderResult.promptOk ? (
            <>
              <div className="mb-7">
                <h1 className="text-lg font-bold text-gray-900 mb-1.5" style={{ fontFamily: 'var(--font-display)' }}>Approve the payment on your phone</h1>
                <p className="text-sm text-gray-500 leading-relaxed">We sent a Mobile Money request to <span className="text-gray-900 font-medium">{custPhone}</span>. Enter your MoMo PIN to complete the order.</p>
              </div>

              <div className="flex items-baseline justify-between border-y border-gray-100 py-4 mb-6">
                <span className="text-sm text-gray-500">Amount</span>
                <span className="text-2xl font-bold text-gray-900">{money(orderResult.total)}</span>
              </div>

              <div className="flex items-center gap-2.5 text-sm text-gray-500 mb-7">
                <div className="w-4 h-4 border-2 border-gray-200 border-t-gray-700 rounded-full animate-spin flex-shrink-0" />
                <span>Waiting for your approval…</span>
              </div>

              <p className="text-sm text-gray-500 leading-relaxed mb-3">
                Didn't see it? Check your MoMo app under pending approvals, or send the request again.
              </p>
              <button onClick={resendPrompt} disabled={retrying || retryWait > 0} className="w-full h-11 border border-gray-300 text-gray-800 rounded-lg text-sm font-medium disabled:opacity-40 disabled:border-gray-200">
                {retrying ? 'Sending…' : retryWait > 0 ? `Send again in ${retryWait}s` : 'Send request again'}
              </button>
            </>
          ) : (
            <>
              <div className="mb-6">
                <h1 className="text-lg font-bold text-gray-900 mb-1.5" style={{ fontFamily: 'var(--font-display)' }}>We couldn't reach your phone</h1>
                <p className="text-sm text-gray-500 leading-relaxed">Your order is saved. Send the payment request again, or dial the code below to pay.</p>
              </div>

              <div className="flex items-baseline justify-between border-y border-gray-100 py-4 mb-5">
                <span className="text-sm text-gray-500">Amount</span>
                <span className="text-2xl font-bold text-gray-900">{money(orderResult.total)}</span>
              </div>

              <button onClick={resendPrompt} disabled={retrying || retryWait > 0} className="w-full h-11 bg-stone-700 text-white rounded-lg text-sm font-medium disabled:opacity-40 mb-3">
                {retrying ? 'Sending…' : retryWait > 0 ? `Send again in ${retryWait}s` : 'Send request again'}
              </button>
              <a href={`tel:*920*141*${orderResult.ussdCode}%23`} className="block w-full h-11 border border-gray-300 rounded-lg text-sm font-medium text-gray-800 flex items-center justify-center">
                Dial *920*141*{orderResult.ussdCode}#
              </a>
            </>
          )}

          <div className="border-t border-gray-100 pt-5 space-y-2.5">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Order</span>
              <button onClick={() => { navigator.clipboard?.writeText(orderResult.orderNo); setToast('Copied'); setTimeout(() => setToast(''), 1200) }} className="font-medium text-gray-900">{orderResult.orderNo}</button>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Check your order</span>
              <a href={`tel:*920*141*${orderResult.ussdCode}%23`} className="font-medium text-gray-900">*920*141*{orderResult.ussdCode}#</a>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Or online</span>
              <a href="#/track" onClick={() => go('track','/track')} className="font-medium text-stone-700">Track order</a>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Questions</span>
              <a href={`tel:${SHOP.phone}`} className="font-medium text-gray-900">{SHOP.phone}</a>
            </div>
          </div>

          <button onClick={() => go('home','/')} className="w-full h-11 mt-7 text-sm font-medium text-gray-500 hover:text-gray-900 transition">
            Continue shopping
          </button>
        </div>
      )})()}

      {/* ═══ TRACK ═══ */}
      {page === 'track' && <div className="max-w-md mx-auto px-4 sm:px-6 py-10">
        <h1 className="text-base font-bold mb-1" style={{ fontFamily: 'var(--font-display)' }}>Track Order</h1>
        <p className="text-xs text-gray-400 mb-5">Search by phone, order # or tracking #</p>
        <div className="flex gap-2 mb-6"><input className="flex-1 h-10 px-3 bg-gray-50 border border-gray-100 rounded-lg text-sm focus:outline-none focus:border-gray-300" value={trackQuery} onChange={e => setTrackQuery(e.target.value)} placeholder="Search..." onKeyDown={e => e.key === 'Enter' && trackOrder()} /><button onClick={trackOrder} disabled={tracking} className="h-10 px-4 bg-stone-700 text-white rounded-lg text-xs font-semibold">{tracking ? '...' : 'Find'}</button></div>
        {trackResult?.length === 0 && <p className="text-xs text-gray-300 text-center">No orders found</p>}
        {trackResult?.length > 0 && <div className="space-y-2">{trackResult.map(o => <div key={o.order_no} className="border border-gray-100 rounded-xl p-3.5"><div className="flex items-center justify-between mb-1.5"><span className="text-xs font-bold">{o.order_no}</span><span className={`px-2 py-0.5 rounded text-[9px] font-bold ${o.status==='Paid'||o.status==='Completed'?'bg-gray-800 text-white':o.status==='Cancelled'?'bg-red-50 text-red-500':'bg-gray-100 text-gray-500'}`}>{o.status}</span></div><div className="text-xs text-gray-400">{money(o.total)}</div>{o.tracking_no && <div className="text-[10px] text-gray-300 font-mono mt-1">{o.tracking_no}</div>}{o.delivery_status && <div className="mt-2 pt-2 border-t border-gray-50"><span className={`px-2 py-0.5 rounded text-[9px] font-bold ${o.delivery_status==='Delivered'||o.delivery_status==='Picked Up'?'bg-stone-100 text-stone-700':o.delivery_status==='Out for Delivery'?'bg-stone-100 text-stone-700':'bg-gray-100 text-gray-500'}`}>{o.delivery_status}</span></div>}</div>)}</div>}
      </div>}

      {/* ═══ FOOTER ═══ */}
      <footer className="bg-stone-700 mt-12 mb-16 md:mb-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="py-8 grid grid-cols-2 sm:grid-cols-4 gap-6">
            <div className="col-span-2 sm:col-span-1">
              <div className="text-white text-sm font-bold tracking-tight mb-2">BEDTIME BEDDINGS HOME</div>
              <p className="text-[11px] text-stone-200/50 leading-relaxed">Better sleep starts with better bedding.</p>
            </div>
            <div>
              <div className="text-[10px] text-amber-200/60 uppercase tracking-wider mb-3">Shop</div>
              <div className="space-y-2">
                <button onClick={() => go('shop','/shop')} className="block text-[12px] text-white/70 hover:text-white transition">All Products</button>
                <button onClick={() => go('cart','/cart')} className="block text-[12px] text-white/70 hover:text-white transition">My Cart</button>
                <button onClick={() => go('track','/track')} className="block text-[12px] text-white/70 hover:text-white transition">Track Order</button>
              </div>
            </div>
            <div>
              <div className="text-[10px] text-white/40 uppercase tracking-wider mb-3">Contact</div>
              <div className="space-y-2">
                <a href={`tel:${SHOP.phone.replace(/\s/g,'')}`} className="block text-[12px] text-white/70 hover:text-white transition">{SHOP.phone}</a>
                <a href={`https://wa.me/${WA}`} target="_blank" className="block text-[12px] text-white hover:text-white/80 transition font-medium">Chat on WhatsApp</a>
              </div>
            </div>
          </div>
          <div className="border-t border-white/15 py-4">
            <p className="text-[10px] text-white/40">&copy; {new Date().getFullYear()} BEDTIME BEDDINGS HOME. All rights reserved.</p>
          </div>
        </div>
      </footer>

      {/* ═══ MOBILE BOTTOM NAV ═══ */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-stone-100 z-50 px-2 pb-[env(safe-area-inset-bottom)]">
        <div className="flex justify-around h-[58px] items-center">
          {[
            ['Home','home','/',I.home],
            ['Shop','shop','/shop',I.grid],
            ['Cart','cart','/cart',<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>],
            ['Track','track','/track',I.track]
          ].map(([l,p,h,ic]) => (
            <button key={p} onClick={() => go(p,h)} className={`flex flex-col items-center gap-1 relative transition-colors ${page===p?'text-stone-700':'text-stone-400'}`}>
              <span className="relative">{ic}{p==='cart' && cc > 0 && <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 bg-stone-700 text-white text-[8px] font-bold rounded-full flex items-center justify-center px-1">{cc}</span>}</span>
              <span className={`text-[9px] ${page===p?'font-bold':'font-medium'}`}>{l}</span>
              {page===p && <span className="absolute -top-[1px] left-1/2 -translate-x-1/2 w-5 h-[2px] bg-stone-700 rounded-full" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
