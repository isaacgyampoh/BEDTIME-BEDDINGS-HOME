import { useState, useEffect, useMemo } from 'react'
import { fetchPosts } from '../lib/social'
import { fmtDateTime, money, isoDate } from '../lib/utils'
import { useStore } from '../hooks/useStore'

const STATUS_STYLE = {
  published: 'bg-green-100 text-green-700',
  shared:    'bg-green-50 text-green-600',
  draft:     'bg-gray-100 text-gray-600',
  ready:     'bg-blue-50 text-blue-600',
  scheduled: 'bg-blue-50 text-blue-600',
  publishing:'bg-amber-100 text-amber-700',
  failed:    'bg-red-100 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
}
const STATUSES = ['all', 'draft', 'ready', 'publishing', 'published', 'shared', 'failed', 'cancelled']

export default function PromotionHistory() {
  const { setPage } = useStore()
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [platform, setPlatform] = useState('all')
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [open, setOpen] = useState(null)

  useEffect(() => { fetchPosts({ limit: 300 }).then(p => { setPosts(p); setLoading(false) }) }, [])

  const filtered = useMemo(() => posts.filter(p => {
    if (platform !== 'all' && p.platform !== platform) return false
    if (status !== 'all' && p.status !== status) return false
    if (from && isoDate(p.created_at) < from) return false
    const q = query.trim().toLowerCase()
    if (q && !(p.product_name || '').toLowerCase().includes(q)) return false
    return true
  }), [posts, platform, status, query, from])

  const Chip = ({ active, onClick, children }) => (
    <button onClick={onClick}
      className={`h-9 px-3.5 rounded-full text-[12px] font-semibold whitespace-nowrap capitalize transition ${
        active ? 'bg-[#16181d] text-white' : 'bg-white border border-gray-200 text-gray-500'}`}>
      {children}
    </button>
  )

  return (
    <div>
      <div className="flex justify-between items-start flex-wrap gap-3 mb-5">
        <div>
          <h1 className="text-[22px] md:text-[26px] font-bold tracking-tight">Promotion History</h1>
          <p className="text-gray-400 text-sm mt-0.5">{filtered.length} of {posts.length} promotions</p>
        </div>
        <button onClick={() => setPage('social')}
          className="h-11 px-4 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 transition">
          Social Commerce
        </button>
      </div>

      <div className="space-y-2.5 mb-5">
        <div className="flex gap-2 flex-wrap">
          {['all', 'tiktok', 'whatsapp'].map(p => (
            <Chip key={p} active={platform === p} onClick={() => setPlatform(p)}>{p}</Chip>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
          {STATUSES.map(s => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{s}</Chip>)}
        </div>
        <div className="flex gap-2 flex-wrap">
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search product…"
            className="flex-1 min-w-[180px] h-11 px-4 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400" />
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="h-11 px-3.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:border-gray-400" />
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200/70 overflow-hidden">
        {loading ? <div className="p-10 text-center text-gray-400 text-sm">Loading…</div>
        : filtered.length === 0 ? <div className="p-10 text-center text-gray-400 text-sm">No promotions match these filters</div>
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead><tr className="bg-gray-50">
                {['Product', 'Channel', 'Status', 'Unit', 'Stock then', 'Created', 'TikTok ID'].map(h => (
                  <th key={h} className="p-3 text-left text-[11px] font-bold text-gray-400 uppercase tracking-wide">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.id} onClick={() => setOpen(open === p.id ? null : p.id)}
                    className="border-b border-gray-50 hover:bg-gray-50/60 transition cursor-pointer">
                    <td className="p-3 text-sm font-semibold text-gray-800">{p.product_name || '—'}</td>
                    <td className="p-3 text-sm text-gray-600 capitalize">{p.platform}</td>
                    <td className="p-3">
                      <span className={`px-2.5 py-1 rounded-lg text-[11px] font-bold capitalize ${STATUS_STYLE[p.status] || 'bg-gray-100 text-gray-600'}`}>
                        {p.status}
                      </span>
                      {p.status === 'failed' && p.error && (
                        <div className="text-[11px] text-red-500 mt-1 max-w-[220px] truncate" title={p.error}>{p.error}</div>
                      )}
                    </td>
                    <td className="p-3 text-sm text-gray-600">
                      {p.unit_price != null ? <>{money(p.unit_price)}<span className="text-gray-400 text-[11px] capitalize"> · {p.unit}</span></> : '—'}
                    </td>
                    <td className="p-3 text-sm text-gray-600">{p.stock_at_creation ?? '—'}</td>
                    <td className="p-3 text-sm text-gray-500">{fmtDateTime(p.created_at)}</td>
                    <td className="p-3 text-[11px] text-gray-400 font-mono">{p.external_post_id || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open && (() => {
        const p = filtered.find(x => x.id === open)
        if (!p) return null
        return (
          <div className="mt-4 bg-white rounded-2xl border border-gray-200/70 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[13px] font-bold text-gray-700 uppercase tracking-wide">Content sent</h3>
              <button onClick={() => setOpen(null)} className="text-[12px] font-semibold text-gray-500">Close</button>
            </div>
            <pre className="text-[13px] text-gray-700 whitespace-pre-wrap font-sans leading-relaxed bg-gray-50 rounded-xl p-4">{p.caption || '—'}</pre>
            {p.hashtags && <div className="text-[12px] text-[#0e7c86] mt-2">{p.hashtags}</div>}
          </div>
        )
      })()}
    </div>
  )
}
