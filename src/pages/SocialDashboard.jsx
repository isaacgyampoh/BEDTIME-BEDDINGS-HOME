import { useState, useEffect } from 'react'
import { useStore } from '../hooks/useStore'
import { getSupabase, callFunction } from '../lib/supabase'
import { askPin, askConfirm } from '../components/PromptDialog'
import { fetchConnections, fetchPosts } from '../lib/social'
import { fmtDateTime } from '../lib/utils'
import toast from 'react-hot-toast'

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

const RULE_LABEL = {
  new_product: 'New product', price_change: 'Price change',
  restock: 'Back in stock', low_stock: 'Low stock', sold_out: 'Sold out',
}

export default function SocialDashboard() {
  const { user, setPage } = useStore()
  const [conns, setConns] = useState([])
  const [posts, setPosts] = useState([])
  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const sb = getSupabase()
    const [c, p, r] = await Promise.all([
      fetchConnections(),
      fetchPosts({ limit: 12 }),
      sb.from('social_automation_rules').select('*').order('event').then(x => x.data || []),
    ])
    setConns(c); setPosts(p); setRules(r); setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Ask TikTok for the real outcome of anything still processing. Nothing is
  // marked Published unless TikTok says so.
  useEffect(() => {
    const anyPublishing = posts.some(p => p.status === 'publishing')
    if (!anyPublishing) return
    const iv = setInterval(async () => {
      try { const r = await callFunction('tiktok-status'); if (r?.confirmed || r?.failed) load() } catch {}
    }, 15000)
    return () => clearInterval(iv)
  }, [posts])

  const tiktok = conns.find(c => c.platform === 'tiktok')
  const tiktokOn = !!tiktok && tiktok.status === 'connected' && tiktok.has_token

  const connectTikTok = async () => {
    const pin = await askPin('Confirm with your admin PIN', 'Connecting a TikTok account.')
    if (!pin) return
    setBusy(true)
    const r = await callFunction('tiktok-oauth-start', { adminPin: pin, actor: user?.name || '' })
    setBusy(false)
    if (!r?.success) return toast.error(r?.error || 'Could not start the TikTok connection')
    // TikTok's consent screen must be a real navigation, not an iframe.
    window.location.href = r.url
  }

  const disconnectTikTok = async () => {
    if (!(await askConfirm('Disconnect TikTok?', 'Drafts and history are kept. You can reconnect at any time.'))) return
    const pin = await askPin('Confirm with your admin PIN', 'Disconnecting TikTok.')
    if (!pin) return
    setBusy(true)
    const r = await callFunction('tiktok-disconnect', { adminPin: pin, actor: user?.name || '' })
    setBusy(false)
    if (r?.success) { toast.success('TikTok disconnected'); load() }
    else toast.error(r?.error || 'Could not disconnect')
  }

  const setRule = async (event, action) => {
    const pin = await askPin('Confirm with your admin PIN', `Changing the "${RULE_LABEL[event]}" rule.`)
    if (!pin) return
    const { data, error } = await getSupabase().rpc('set_social_rule', {
      p_admin_pin: pin, p_event: event, p_action: action,
    })
    if (error || data?.success === false) return toast.error(data?.error || error?.message || 'Could not save')
    toast.success('Automation updated'); load()
  }

  return (
    <div>
      <div className="flex justify-between items-start flex-wrap gap-3 mb-5">
        <div>
          <h1 className="text-[22px] md:text-[26px] font-bold tracking-tight">Social Commerce</h1>
          <p className="text-gray-400 text-sm mt-0.5">Promote products to TikTok and WhatsApp</p>
        </div>
        <button onClick={() => setPage('promotions')}
          className="h-11 px-4 bg-white border border-gray-200 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 transition">
          Promotion History
        </button>
      </div>

      {/* Channels */}
      <div className="grid md:grid-cols-2 gap-3.5 mb-6">
        <div className="bg-white rounded-2xl border border-gray-200/70 p-5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[15px] font-bold text-gray-900">TikTok</div>
            <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${tiktokOn ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              {tiktokOn ? 'Connected' : 'Not connected'}
            </span>
          </div>
          <div className="text-[13px] text-gray-500 min-h-[20px]">
            {tiktokOn ? (tiktok.account_name || 'Account linked') : 'Link an account to publish'}
          </div>
          {tiktok?.last_published_at && (
            <div className="text-[11px] text-gray-400 mt-1">Last published {fmtDateTime(tiktok.last_published_at)}</div>
          )}
          {tiktok?.token_expired && (
            <div className="text-[11px] text-amber-700 mt-1">Session expired — reconnect to publish</div>
          )}
          <div className="mt-4">
            {tiktokOn
              ? <button onClick={disconnectTikTok} disabled={busy}
                  className="h-11 px-4 rounded-xl border border-gray-300 text-[13px] font-semibold text-gray-600 disabled:opacity-50">Disconnect</button>
              : <button onClick={connectTikTok} disabled={busy}
                  className="h-11 px-5 rounded-xl bg-[#16181d] text-white text-[13px] font-bold disabled:opacity-50 active:scale-[.98] transition">
                  {busy ? 'Starting…' : 'Connect TikTok'}
                </button>}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200/70 p-5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[15px] font-bold text-gray-900">WhatsApp</div>
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-green-100 text-green-700">Available</span>
          </div>
          <div className="text-[13px] text-gray-500">
            Share product messages straight from any product. No setup needed.
          </div>
          <div className="text-[11px] text-gray-400 mt-2">
            Uses the same WhatsApp sharing the POS already uses for orders.
          </div>
        </div>
      </div>

      {/* Automation */}
      <div className="bg-white rounded-2xl border border-gray-200/70 p-5 mb-6">
        <h3 className="text-sm font-bold text-gray-800 mb-1">Automation</h3>
        <p className="text-[12px] text-gray-400 mb-4">
          Inventory events can prepare promotional drafts for you. Automatic
          publishing stays off until you turn it on.
        </p>
        <div className="space-y-2.5">
          {rules.filter(r => r.event !== 'sold_out').map(r => (
            <div key={r.event} className="flex items-center justify-between gap-3 flex-wrap p-3 bg-gray-50 rounded-xl">
              <div className="text-[13px] font-semibold text-gray-700">{RULE_LABEL[r.event] || r.event}</div>
              <div className="flex gap-1.5">
                {['off', 'draft', 'publish'].map(a => (
                  <button key={a} onClick={() => setRule(r.event, a)}
                    className={`h-9 px-3 rounded-lg text-[12px] font-semibold capitalize transition ${
                      r.action === a ? 'bg-[#16181d] text-white' : 'bg-white border border-gray-200 text-gray-500'}`}>
                    {a === 'publish' ? 'Auto-publish' : a}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
            <div className="text-[13px] font-semibold text-gray-700">Sold out</div>
            <span className="text-[12px] text-gray-500">Cancels queued posts automatically</span>
          </div>
        </div>
      </div>

      {/* Recent */}
      <div className="bg-white rounded-2xl border border-gray-200/70 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100">
          <h3 className="text-[13px] font-bold text-gray-700 uppercase tracking-wide">Recent Promotions</h3>
        </div>
        {loading ? <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        : posts.length === 0 ? <div className="p-8 text-center text-gray-400 text-sm">Nothing promoted yet</div>
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead><tr className="bg-gray-50">
                {['Product', 'Channel', 'Status', 'Date'].map(h => (
                  <th key={h} className="p-3 text-left text-[11px] font-bold text-gray-400 uppercase tracking-wide">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {posts.map(p => (
                  <tr key={p.id} className="border-b border-gray-50">
                    <td className="p-3 text-sm font-semibold text-gray-800">{p.product_name || '—'}</td>
                    <td className="p-3 text-sm text-gray-600 capitalize">{p.platform}</td>
                    <td className="p-3">
                      <span className={`px-2.5 py-1 rounded-lg text-[11px] font-bold capitalize ${STATUS_STYLE[p.status] || 'bg-gray-100 text-gray-600'}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="p-3 text-sm text-gray-500">{fmtDateTime(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
