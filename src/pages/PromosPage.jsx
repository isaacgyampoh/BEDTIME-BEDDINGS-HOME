import { useState, useMemo } from 'react'
import { useStore } from '../hooks/useStore'
import { getSupabase } from '../lib/supabase'
import { money, num, fmtDate, today } from '../lib/utils'
import Modal from '../components/Modal'
import toast from 'react-hot-toast'
import { adminDelete } from '../lib/adminActions'
import { matchProducts, toItem, applyPercent, applyFixed, validate, summarise } from '../lib/promoBuilder'

/** Matches shown at once. The shop has 652 products; the list is for picking
 *  from, not for reading, and "Add all" does not care how many are drawn. */
const PICK_MAX = 60

export default function PromosPage() {
  const { promos, bundles, products, refreshPromos, refreshBundles, setLoading } = useStore()
  const [tab, setTab] = useState('promos')
  // Promo state
  const [modal, setModal] = useState(false)
  const [form, setForm] = useState({ id: '', name: '', startDate: '', endDate: '', items: [] })
  // Bundle state
  const [bunModal, setBunModal] = useState(false)
  const [bunForm, setBunForm] = useState({ id: '', name: '', price: '', items: [] })
  // Picking products for a promo: what is being searched for, and the bulk
  // price about to be applied to everything picked.
  const [pick, setPick] = useState({ query: '', category: 'all' })
  const [bulk, setBulk] = useState({ pct: '', price: '' })
  // Which promos have had their full item list opened.
  const [expanded, setExpanded] = useState(() => new Set())

  const isActive = (p) => { const t = today(); return p.active && p.startDate <= t && p.endDate >= t }
  const activeCount = promos.filter(isActive).length

  // Promo functions
  const resetPicker = () => { setPick({ query: '', category: 'all' }); setBulk({ pct: '', price: '' }) }
  const openNewPromo = () => { setForm({ id: '', name: '', startDate: today(), endDate: '', items: [] }); resetPicker(); setModal(true) }
  const openEditPromo = (p) => { setForm({ id: p.id, name: p.name, startDate: p.startDate || '', endDate: p.endDate || '', items: [...p.items] }); resetPicker(); setModal(true) }

  // Which products the search is offering, and which of them are already in.
  const cats = useMemo(() => [...new Set(products.map(p => p.category).filter(Boolean))].sort(), [products])
  const problems = useMemo(() => (form.items.length || form.name ? validate(form) : []), [form])
  const chosen = useMemo(() => new Set(form.items.map(i => i.productId)), [form.items])
  const matches = useMemo(() => matchProducts(products, pick), [products, pick])
  const unchosen = useMemo(() => matches.filter(p => !chosen.has(p.id)), [matches, chosen])

  const togglePromoItem = (prod) => setForm(f => chosen.has(prod.id)
    ? { ...f, items: f.items.filter(i => i.productId !== prod.id) }
    : { ...f, items: [...f.items, toItem(prod)] })
  // The whole point: forty colours of one bedsheet go in with one tap.
  const addAllMatching = () => setForm(f => ({ ...f, items: [...f.items, ...unchosen.map(toItem)] }))
  const applyBulkPct = () => { setForm(f => ({ ...f, items: applyPercent(f.items, bulk.pct) })); setBulk(b => ({ ...b, pct: '' })) }
  const applyBulkPrice = () => { setForm(f => ({ ...f, items: applyFixed(f.items, bulk.price) })); setBulk(b => ({ ...b, price: '' })) }
  const savePromo = async () => {
    const problems = validate(form)
    if (problems.length) { toast.error(problems[0]); return }
    setLoading(true, 'Saving...'); const sb = getSupabase()
    const data = { name: form.name.trim(), start_date: form.startDate, end_date: form.endDate, items: form.items.map(i => ({ productId: i.productId, name: i.name, originalPrice: num(i.originalPrice), promoPrice: num(i.promoPrice) })), active: true }
    if (form.id) await sb.from('promos').update(data).eq('id', form.id); else await sb.from('promos').insert(data)
    await refreshPromos(); setLoading(false); setModal(false); toast.success('Saved')
  }
  const togglePromo = async (id, active) => { const sb = getSupabase(); await sb.from('promos').update({ active: !active }).eq('id', id); refreshPromos() }
  const delPromo = async (p) => {
    if (!(await adminDelete('promos', p.id, p.name))) return
    setLoading(true); await refreshPromos(); setLoading(false)
  }

  // Bundle functions
  const openNewBundle = () => { setBunForm({ id: '', name: '', price: '', items: [] }); setBunModal(true) }
  const openEditBundle = (b) => { setBunForm({ id: b.id, name: b.name, price: b.bundlePrice, items: [...b.products] }); setBunModal(true) }
  const addBunItem = (pid) => { if (!pid) return; const items = [...bunForm.items]; const ex = items.find(x => x.productId === pid); if (ex) ex.qty++; else items.push({ productId: pid, qty: 1 }); setBunForm({ ...bunForm, items }) }
  const saveBundle = async () => {
    if (!bunForm.name.trim() || !bunForm.items.length || !num(bunForm.price)) { toast.error('Fill all fields'); return }
    setLoading(true, 'Saving...'); const sb = getSupabase()
    const data = { name: bunForm.name.trim(), bundle_price: num(bunForm.price), products: bunForm.items, active: true }
    if (bunForm.id) await sb.from('bundles').update(data).eq('id', bunForm.id); else await sb.from('bundles').insert(data)
    await refreshBundles(); setLoading(false); setBunModal(false); toast.success('Saved')
  }
  const delBundle = async (b) => {
    if (!(await adminDelete('bundles', b.id, b.name))) return
    setLoading(true); await refreshBundles(); setLoading(false)
  }

  return (
    <div >
      <div className="flex justify-between items-start flex-wrap gap-4 mb-5">
        <div>
          <h1 className="text-[22px] md:text-[26px] font-bold tracking-tight">Promos &amp; Bundles</h1>
          <p className="text-gray-400 text-sm mt-0.5">Manage promotions and product bundles</p>
        </div>
        <div className="flex gap-2">
          {tab === 'promos' && <button onClick={openNewPromo} className="h-11 px-5 bg-gray-700 text-white rounded-xl text-sm font-semibold hover:bg-gray-800 transition">New Promo</button>}
          {tab === 'bundles' && <button onClick={openNewBundle} className="h-11 px-5 bg-gray-700 text-white rounded-xl text-sm font-semibold hover:bg-gray-800 transition">New Bundle</button>}
        </div>
      </div>

      {/* Hero stat */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="bg-gray-800 rounded-2xl p-5 text-white relative overflow-hidden">
          <div className="relative z-10"><div className="text-xs opacity-70">Active Promos</div><div className="text-[22px] md:text-[26px] font-bold mt-1">{activeCount}</div></div>
        </div>
        <div className="bg-gray-800 rounded-2xl p-5 text-white relative overflow-hidden">
          <div className="relative z-10"><div className="text-xs opacity-70">Active Bundles</div><div className="text-[22px] md:text-[26px] font-bold mt-1">{bundles.filter(b => b.active).length}</div></div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white rounded-2xl p-1 mb-5 border border-gray-100 w-fit">
        <button onClick={() => setTab('promos')} className={`h-9 px-5 rounded-xl text-sm font-semibold transition ${tab === 'promos' ? 'bg-gray-800 text-white' : 'text-stone-500 hover:text-stone-700'}`}>Promos</button>
        <button onClick={() => setTab('bundles')} className={`h-9 px-5 rounded-xl text-sm font-semibold transition ${tab === 'bundles' ? 'bg-gray-800 text-white' : 'text-stone-500 hover:text-stone-700'}`}>Bundles</button>
      </div>

      {/* Promos Tab */}
      {tab === 'promos' && (
        <div className="space-y-3">
          {promos.length === 0 && <div className="text-center py-16 text-gray-300"><span className="text-xl opacity-15">—</span>No promotions</div>}
          {promos.map(p => {
            const active = isActive(p)
            return (
              <div key={p.id} className={`bg-white rounded-2xl p-5 border-l-4 ${active ? 'border-gray-500' : 'border-gray-300 opacity-60'}`}>
                <div className="flex justify-between items-start flex-wrap gap-3 mb-3">
                  <div><h3 className="font-bold">{p.name}</h3><p className="text-xs text-gray-400">{fmtDate(p.startDate)} → {fmtDate(p.endDate)}</p></div>
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${active ? 'bg-gray-50 text-gray-700' : 'bg-gray-100 text-gray-500'}`}>{active ? 'Active' : 'Off'}</span>
                </div>
                {/* Forty colours of one bedsheet at one price is a single fact,
                    not forty rows that bury every other promotion below them. */}
                {(() => {
                  const sum = summarise(p.items)
                  const open = expanded.has(p.id)
                  const long = p.items.length > 4
                  if (long && !open) return (
                    <button onClick={() => setExpanded(prev => new Set(prev).add(p.id))}
                      className="w-full flex items-center justify-between py-2 text-sm text-left hover:bg-gray-50 rounded-lg px-1 -mx-1">
                      <span className="text-gray-600">
                        <b>{p.items.length} items</b>
                        {sum.uniform
                          ? <> · <s className="text-gray-400">{money(sum.from)}</s> <b className="text-gray-700">{money(sum.to)}</b></>
                          : sum.maxPct > 0 ? <> · up to <b className="text-gray-700">{sum.maxPct}% off</b></> : null}
                      </span>
                      <span className="text-xs text-gray-400">Show all</span>
                    </button>
                  )
                  return (<>
                    {p.items.map((it, i) => (
                      <div key={i} className="flex justify-between py-1.5 border-b border-dashed border-gray-100 last:border-0 text-sm">
                        <span className="truncate pr-3">{it.name}</span><span className="shrink-0"><s className="text-gray-400 mr-2">{money(it.originalPrice)}</s><b className="text-gray-700">{money(it.promoPrice)}</b></span>
                      </div>
                    ))}
                    {long && <button onClick={() => setExpanded(prev => { const n = new Set(prev); n.delete(p.id); return n })}
                      className="mt-2 text-xs text-gray-400 hover:text-gray-600">Show less</button>}
                  </>)
                })()}
                <div className="flex gap-2 mt-3">
                  <button onClick={() => togglePromo(p.id, p.active)} className={`h-8 px-3 rounded-lg text-xs font-semibold ${p.active ? 'bg-gray-100' : 'bg-green-50 text-green-500'}`}>{p.active ? 'Deactivate' : 'Activate'}</button>
                  <button onClick={() => openEditPromo(p)} className="h-8 px-3 border border-stone-300 rounded-lg text-xs font-medium text-stone-600 hover:bg-stone-100 transition">Edit</button>
                  <button onClick={() => delPromo(p)} className="h-8 px-3 bg-[#c0492f] text-white rounded-lg text-xs font-medium hover:bg-[#a83d27] transition">Delete</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Bundles Tab */}
      {tab === 'bundles' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <table className="w-full min-w-[400px]">
            <thead><tr><th className="p-3 bg-gray-50 text-left text-[11px] font-bold text-gray-400 uppercase">Bundle</th><th className="p-3 bg-gray-50 text-left text-[11px] font-bold text-gray-400 uppercase">Products</th><th className="p-3 bg-gray-50 text-left text-[11px] font-bold text-gray-400 uppercase">Price</th><th className="p-3 bg-gray-50"></th></tr></thead>
            <tbody>{bundles.length === 0 ? <tr><td colSpan={4} className="text-center py-16 text-gray-300">No bundles</td></tr> : bundles.map(b => {
              const names = b.products.map(p => { const pr = products.find(x => x.id === p.productId); return pr ? p.qty + 'x ' + pr.name : '?' }).join(', ')
              return (<tr key={b.id} className="border-b border-gray-50"><td className="p-3 text-sm font-semibold">{b.name}</td><td className="p-3 text-xs text-gray-500 max-w-[200px] truncate">{names}</td><td className="p-3 font-bold text-sm">{money(b.bundlePrice)}</td><td className="p-3"><div className="flex gap-2"><button onClick={() => openEditBundle(b)} className="h-8 px-3 border border-stone-300 rounded-lg text-xs font-medium text-stone-600 hover:bg-stone-100 transition">Edit</button><button onClick={() => delBundle(b)} className="h-8 px-3 bg-[#c0492f] text-white rounded-lg text-xs font-medium hover:bg-[#a83d27] transition">Delete</button></div></td></tr>)
            })}</tbody>
          </table>
        </div>
      )}

      {/* Promo Modal */}
      <Modal open={modal} onClose={() => setModal(false)} title={form.id ? 'Edit Promo' : 'New Promo'}
        footer={<><button onClick={() => setModal(false)} className="h-11 px-5 border border-stone-300 rounded-xl text-sm font-semibold text-stone-600">Cancel</button><button onClick={savePromo} className="flex-1 h-11 bg-gray-700 text-white rounded-xl text-sm font-bold">Save</button></>}>
        <div className="space-y-4">
          <input className="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Promo name" />
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-semibold text-gray-500 mb-1">Start</label><input type="date" className="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></div>
            <div><label className="block text-xs font-semibold text-gray-500 mb-1">End</label><input type="date" className="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></div>
          </div>
          {/* ── Pick the products ───────────────────────────────────────
              One bedsheet in forty colours is forty products. Searching once
              and adding everything that matches is the difference between a
              minute and a quarter of an hour. */}
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex gap-2 p-2.5 bg-gray-50 border-b border-gray-200">
              <input
                className="flex-1 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm"
                placeholder="Search products, e.g. bedsheet"
                value={pick.query}
                onChange={e => setPick({ ...pick, query: e.target.value })} />
              <select
                className="h-10 px-2 bg-white border border-gray-200 rounded-lg text-sm max-w-[9rem]"
                value={pick.category}
                onChange={e => setPick({ ...pick, category: e.target.value })}>
                <option value="all">All categories</option>
                {cats.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div className="flex items-center justify-between px-3 py-2 text-xs border-b border-gray-100">
              <span className="text-gray-500">
                {matches.length} match{matches.length === 1 ? '' : 'es'}
                {matches.length > PICK_MAX && <span className="text-gray-400"> · showing {PICK_MAX}</span>}
              </span>
              <button type="button" onClick={addAllMatching} disabled={!unchosen.length}
                className="h-7 px-3 rounded-lg text-xs font-bold bg-gray-800 text-white disabled:opacity-30">
                Add all {unchosen.length || ''}
              </button>
            </div>

            <div className="max-h-44 overflow-y-auto">
              {matches.length === 0 && <div className="text-center text-gray-400 py-6 text-sm">Nothing matches that</div>}
              {matches.slice(0, PICK_MAX).map(p => {
                const on = chosen.has(p.id)
                return (
                  <button type="button" key={p.id} onClick={() => togglePromoItem(p)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-left border-b border-gray-50 last:border-0 ${on ? 'bg-gray-50' : 'hover:bg-gray-50'}`}>
                    <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] ${on ? 'bg-gray-800 border-gray-800 text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                    <span className="flex-1 text-sm truncate">{p.name}</span>
                    <span className="text-xs text-gray-400 shrink-0">{money(p.price)}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* ── Price them, all at once ─────────────────────────────────── */}
          {form.items.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 p-2.5 bg-gray-50 border border-gray-200 rounded-xl">
              <span className="text-xs font-bold text-gray-600 mr-auto">{form.items.length} selected</span>
              <div className="flex items-center gap-1">
                <input type="number" min="1" max="99" placeholder="20" value={bulk.pct}
                  onChange={e => setBulk({ ...bulk, pct: e.target.value })}
                  className="w-14 h-9 px-2 text-center bg-white border border-gray-200 rounded-lg text-sm" />
                <button type="button" onClick={applyBulkPct} disabled={!num(bulk.pct)}
                  className="h-9 px-3 rounded-lg text-xs font-bold bg-white border border-gray-300 disabled:opacity-30">% off all</button>
              </div>
              <div className="flex items-center gap-1">
                <input type="number" min="0" placeholder="75" value={bulk.price}
                  onChange={e => setBulk({ ...bulk, price: e.target.value })}
                  className="w-16 h-9 px-2 text-center bg-white border border-gray-200 rounded-lg text-sm" />
                <button type="button" onClick={applyBulkPrice} disabled={!num(bulk.price)}
                  className="h-9 px-3 rounded-lg text-xs font-bold bg-white border border-gray-300 disabled:opacity-30">Set all to</button>
              </div>
              <button type="button" onClick={() => setForm({ ...form, items: [] })}
                className="h-9 px-3 rounded-lg text-xs font-semibold text-red-500 hover:bg-red-50">Clear</button>
            </div>
          )}

          {/* ── What is in it, and for how much ─────────────────────────── */}
          <div className="bg-gray-50 rounded-xl p-3 min-h-[60px] max-h-56 overflow-y-auto">
            {form.items.length === 0 ? <div className="text-center text-gray-400 py-5 text-sm">No products yet — search above</div> : form.items.map((it, i) => (
              <div key={it.productId} className="flex items-center gap-2 p-2.5 bg-white rounded-lg mb-2">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate">{it.name}</div>
                  <div className="text-xs text-gray-400">Was: {money(it.originalPrice)}</div>
                </div>
                <input type="number" className="w-20 h-8 px-2 text-center border border-gray-300 rounded-lg text-sm font-bold text-gray-700" placeholder="Price" value={it.promoPrice} onChange={e => { const items = [...form.items]; items[i].promoPrice = e.target.value; setForm({ ...form, items }) }} />
                <button onClick={() => { const items = [...form.items]; items.splice(i, 1); setForm({ ...form, items }) }} className="w-7 h-7 bg-red-50 text-red-500 rounded-md text-xs flex items-center justify-center">✕</button>
              </div>
            ))}
          </div>

          {/* Said before the Save button is pressed, not after. */}
          {problems.length > 0 && (
            <ul className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
              {problems.map((m, i) => <li key={i}>• {m}</li>)}
            </ul>
          )}
        </div>
      </Modal>

      {/* Bundle Modal */}
      <Modal open={bunModal} onClose={() => setBunModal(false)} title={bunForm.id ? 'Edit Bundle' : 'New Bundle'}
        footer={<><button onClick={() => setBunModal(false)} className="h-11 px-5 border border-stone-300 rounded-xl text-sm font-semibold text-stone-600">Cancel</button><button onClick={saveBundle} className="flex-1 h-11 bg-gray-700 text-white rounded-xl text-sm font-bold">Save</button></>}>
        <div className="space-y-4">
          <input className="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={bunForm.name} onChange={e => setBunForm({...bunForm, name: e.target.value})} placeholder="Bundle name" />
          <input type="number" className="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={bunForm.price} onChange={e => setBunForm({...bunForm, price: e.target.value})} placeholder="Bundle price (GHS)" />
          <select className="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm" onChange={e => { addBunItem(e.target.value); e.target.value = '' }}><option value="">Add product...</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <div className="bg-gray-50 rounded-xl p-3 min-h-[60px]">
            {bunForm.items.length === 0 ? <div className="text-center text-gray-400 py-5 text-sm">No products</div> : bunForm.items.map((it, i) => {
              const p = products.find(x => x.id === it.productId)
              return p ? <div key={i} className="flex items-center gap-2 p-2.5 bg-white rounded-lg mb-2"><span className="flex-1 text-sm font-semibold">{p.name}</span><input type="number" value={it.qty} min={1} className="w-12 h-8 text-center border border-gray-200 rounded-lg text-sm font-bold" onChange={e => { const items = [...bunForm.items]; items[i].qty = parseInt(e.target.value) || 1; setBunForm({...bunForm, items}) }} /><button onClick={() => { const items = [...bunForm.items]; items.splice(i, 1); setBunForm({...bunForm, items}) }} className="w-7 h-7 bg-red-50 text-red-500 rounded-md text-xs flex items-center justify-center">✕</button></div> : null
            })}
          </div>
        </div>
      </Modal>
    </div>
  )
}
