import { useState, useMemo } from 'react'
import { useStore } from '../hooks/useStore'
import { getSupabase } from '../lib/supabase'
import { money, num, fmtDate, today } from '../lib/utils'
import Modal from '../components/Modal'
import toast from 'react-hot-toast'
import { adminDelete } from '../lib/adminActions'
import { matchProducts, toItem, applyPercent, applyFixed, validate, summarise, groupProducts } from '../lib/promoBuilder'

/** Matches shown at once. The shop has 652 products; the list is for picking
 *  from, not for reading, and "Add all" does not care how many are drawn. */
const PICK_MAX = 60

/** A product's picture. For "(color 31)" it is the only way to tell them apart. */
function Thumb({ src }) {
  if (!src) return <span className="w-9 h-9 shrink-0 rounded-lg bg-gray-100" />
  return <img src={src} alt="" loading="lazy" className="w-9 h-9 shrink-0 rounded-lg object-cover bg-gray-100"
    onError={e => { e.target.style.visibility = 'hidden' }} />
}

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
  // Forty colours of one bedsheet are one row here, because that is how the
  // shop already tags them for wholesale pricing.
  const rows = useMemo(() => groupProducts(matches), [matches])
  const picked = useMemo(() => summarise(form.items), [form.items])
  // Forty lines reading "1 Double Bedsheet with 2 pillow ca…" tell nobody
  // anything. The chosen side groups exactly as the picker does, with one
  // price box for the set, and opens if a colour needs its own price.
  const chosenRows = useMemo(() => {
    const prods = form.items.map(i => products.find(p => p.id === i.productId)).filter(Boolean)
    return groupProducts(prods).map(row => {
      const lines = row.items.map(p => form.items.find(i => i.productId === p.id)).filter(Boolean)
      const prices = [...new Set(lines.map(l => String(l.promoPrice ?? '')))]
      return { ...row, lines, price: prices.length === 1 ? prices[0] : '', mixed: prices.length > 1 }
    })
  }, [form.items, products])
  const [openRows, setOpenRows] = useState(() => new Set())
  const setRowPrice = (row, value) =>
    setForm(f => ({ ...f, items: f.items.map(i =>
      row.items.some(p => p.id === i.productId) ? { ...i, promoPrice: value } : i) }))
  const removeRow = (row) => setForm(f => ({ ...f, items: f.items.filter(i => !row.items.some(p => p.id === i.productId)) }))

  // A row is a product or a whole variant group; tapping it takes the lot in
  // or out, which is the difference between one tap and forty.
  const toggleRow = (row) => setForm(f => {
    const ids = new Set(row.items.map(p => p.id))
    const already = row.items.every(p => chosen.has(p.id))
    return already
      ? { ...f, items: f.items.filter(i => !ids.has(i.productId)) }
      : { ...f, items: [...f.items, ...row.items.filter(p => !chosen.has(p.id)).map(toItem)] }
  })
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
      <Modal open={modal} wide onClose={() => setModal(false)} title={form.id ? 'Edit Promo' : 'New Promo'}
        footer={<><button onClick={() => setModal(false)} className="h-11 px-5 border border-stone-300 rounded-xl text-sm font-semibold text-stone-600">Cancel</button><button onClick={savePromo} className="flex-1 h-11 bg-gray-700 text-white rounded-xl text-sm font-bold">Save</button></>}>
        <div className="space-y-4">
          <div className="grid md:grid-cols-[1fr_auto_auto] gap-3">
            <input className="h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Promo name" />
            <div><label className="block text-[11px] font-semibold text-gray-500 mb-1">Start</label><input type="date" className="h-10 px-3 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></div>
            <div><label className="block text-[11px] font-semibold text-gray-500 mb-1">End</label><input type="date" className="h-10 px-3 bg-gray-50 border border-gray-200 rounded-xl text-sm" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            {/* ── Choose ─────────────────────────────────────────────────
                A bedsheet sold in forty colours is one row with one button.
                The picture is how a colour is actually told apart; the name
                only says "(color 31)". */}
            <div className="border border-gray-200 rounded-xl flex flex-col overflow-hidden">
              <div className="flex gap-2 p-2.5 bg-gray-50 border-b border-gray-200">
                <input
                  className="flex-1 min-w-0 h-10 px-3 bg-white border border-gray-200 rounded-lg text-sm"
                  placeholder="Search products, e.g. bedsheet"
                  value={pick.query}
                  onChange={e => setPick({ ...pick, query: e.target.value })} />
                <select
                  className="h-10 px-2 bg-white border border-gray-200 rounded-lg text-sm max-w-[8rem]"
                  value={pick.category}
                  onChange={e => setPick({ ...pick, category: e.target.value })}>
                  <option value="all">All</option>
                  {cats.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div className="flex items-center justify-between px-3 py-2 text-xs border-b border-gray-100">
                <span className="text-gray-500">
                  {matches.length} match{matches.length === 1 ? '' : 'es'}
                  {rows.length !== matches.length && <span className="text-gray-400"> in {rows.length} row{rows.length === 1 ? '' : 's'}</span>}
                </span>
                <button type="button" onClick={addAllMatching} disabled={!unchosen.length}
                  className="h-7 px-3 rounded-lg text-xs font-bold bg-gray-800 text-white disabled:opacity-30">
                  {unchosen.length < matches.length ? 'Add remaining' : 'Add all'} {unchosen.length || ''}
                </button>
              </div>

              <div className="overflow-y-auto" style={{ maxHeight: '19rem' }}>
                {rows.length === 0 && <div className="text-center text-gray-400 py-8 text-sm">Nothing matches that</div>}
                {rows.slice(0, PICK_MAX).map(row => {
                  const all = row.items.every(p => chosen.has(p.id))
                  const some = !all && row.items.some(p => chosen.has(p.id))
                  const n = row.items.length
                  return (
                    <button type="button" key={row.key} onClick={() => toggleRow(row)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left border-b border-gray-50 last:border-0 transition ${all ? 'bg-gray-50' : 'hover:bg-gray-50'}`}>
                      <span className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] ${all ? 'bg-gray-800 border-gray-800 text-white' : some ? 'bg-gray-300 border-gray-400 text-white' : 'border-gray-300'}`}>{all ? '✓' : some ? '–' : ''}</span>
                      <Thumb src={row.image} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm truncate">{row.label}</span>
                        <span className="block text-[11px] text-gray-400">
                          {n > 1 && <>{n} variants · </>}
                          {row.priceFrom === row.priceTo ? money(row.priceFrom) : `${money(row.priceFrom)}–${money(row.priceTo)}`}
                        </span>
                      </span>
                      {n > 1 && <span className="shrink-0 text-[11px] font-bold text-gray-500">{all ? 'Added' : `Add ${n}`}</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* ── In the promotion ───────────────────────────────────────── */}
            <div className="border border-gray-200 rounded-xl flex flex-col overflow-hidden">
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-gray-600 truncate">
                  {form.items.length === 0 ? 'Nothing added yet' : <>
                    {form.items.length} selected
                    {picked.count > 0 && picked.uniform && <> · <s className="text-gray-400 font-normal">{money(picked.from)}</s> {money(picked.to)}</>}
                    {picked.maxPct > 0 && <> · {picked.maxPct}% off</>}
                  </>}
                </span>
                {form.items.length > 0 && <button type="button" onClick={() => setForm({ ...form, items: [] })}
                  className="shrink-0 h-7 px-2 rounded-lg text-[11px] font-semibold text-red-500 hover:bg-red-50">Clear</button>}
              </div>

              {form.items.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-gray-100">
                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide w-full">Price them together</span>
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
                </div>
              )}

              <div className="overflow-y-auto flex-1" style={{ maxHeight: '15rem' }}>
                {form.items.length === 0
                  ? <div className="text-center text-gray-400 py-10 text-sm px-4">Search on the left, then add a product or a whole set of colours</div>
                  : chosenRows.map(row => {
                    const many = row.lines.length > 1
                    const open = openRows.has(row.key)
                    return (
                      <div key={row.key} className="border-b border-gray-50 last:border-0">
                        <div className="flex items-center gap-2 px-3 py-2">
                          <Thumb src={row.image} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate">{row.label}</div>
                            <div className="text-[11px] text-gray-400">
                              {many && <>{row.lines.length} variants · </>}
                              Was {row.priceFrom === row.priceTo ? money(row.priceFrom) : `${money(row.priceFrom)}–${money(row.priceTo)}`}
                              {many && <button onClick={() => setOpenRows(prev => { const n = new Set(prev); n.has(row.key) ? n.delete(row.key) : n.add(row.key); return n })}
                                className="ml-2 text-gray-500 hover:text-gray-700 font-semibold">{open ? 'Hide' : 'Price each'}</button>}
                            </div>
                          </div>
                          <input type="number" className="w-20 h-9 px-2 text-center border border-gray-300 rounded-lg text-sm font-bold text-gray-700"
                            placeholder={row.mixed ? 'Mixed' : 'Price'} value={row.price}
                            onChange={e => setRowPrice(row, e.target.value)} />
                          <button onClick={() => removeRow(row)} aria-label="Remove"
                            className="w-7 h-7 shrink-0 bg-red-50 text-red-500 rounded-md text-xs flex items-center justify-center">✕</button>
                        </div>
                        {many && open && row.lines.map(line => {
                          const i = form.items.findIndex(x => x.productId === line.productId)
                          return (
                            <div key={line.productId} className="flex items-center gap-2 pl-12 pr-3 py-1.5 bg-gray-50/60">
                              <span className="flex-1 min-w-0 text-[12px] text-gray-600 truncate">{line.name}</span>
                              <input type="number" className="w-20 h-8 px-2 text-center border border-gray-200 rounded-lg text-[13px]"
                                placeholder="Price" value={line.promoPrice}
                                onChange={e => { const items = [...form.items]; items[i].promoPrice = e.target.value; setForm({ ...form, items }) }} />
                              <button onClick={() => { const items = [...form.items]; items.splice(i, 1); setForm({ ...form, items }) }}
                                className="w-6 h-6 shrink-0 text-gray-400 hover:text-red-500 text-xs">✕</button>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
              </div>
            </div>
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
