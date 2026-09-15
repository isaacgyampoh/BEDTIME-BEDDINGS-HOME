import { useState, useEffect } from 'react'
import { useStore } from '../hooks/useStore'
import { callFunction } from '../lib/supabase'
import { unknownCostExposure } from '../lib/dataHealth'
import { money, today, weekStartDate, monthStart, isoDate, fmtDateTime } from '../lib/utils'

// Module scope: components declared inside render are a new type every render,
// so React remounts them and any state or focus inside is lost.
const HealthRow = ({ ok, warn, label, detail }) => (
  <div className="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0">
    <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${warn ? 'bg-amber-500' : ok ? 'bg-green-500' : 'bg-gray-300'}`} />
    <span className="text-[13px] font-semibold text-gray-700 flex-1">{label}</span>
    <span className="text-[12px] text-gray-400 text-right">{detail}</span>
  </div>
)

/**
 * Scheduled reports, payment confirmations and delivery messages all run
 * unattended, and when one breaks it breaks quietly — which is how orders sat
 * Pending and the SMS key stayed dead for months. This makes that visible on
 * the screen the owner already looks at every morning.
 */
function SystemHealth({ health, waOrders }) {
  const calls = health?.recent_outbound_calls || []
  const lastCall = calls[0]
  const cronOk = calls.length > 0 && calls.slice(0, 3).every(c => c.code >= 200 && c.code < 300)
  const smsCount = health?.sms_last_24h ?? null
  const stuck = (waOrders || []).filter(o =>
    o.status === 'Pending' && o.date && (Date.now() - new Date(o.date).getTime()) > 2 * 3600 * 1000).length

  // Paid, closed out, but never recorded as a sale. This is the one that
  // silently costs money: the goods have gone and the revenue is missing from
  // every report. Two orders sat like this for eleven days.
  const unbooked = (waOrders || []).filter(o =>
    (o.status === 'Paid' || o.status === 'Completed') && !o.saleReceiptNo)
  const unbookedValue = unbooked.reduce((a, o) => a + (Number(o.total) || 0), 0)

  return (
    <div className="bg-white rounded-2xl p-5 border border-gray-200/70 mb-5">
      <h3 className="text-sm font-bold text-gray-800 mb-1">System health</h3>
      <p className="text-[12px] text-gray-400 mb-3">The parts that run on their own</p>
      <HealthRow ok={cronOk} label="Scheduled jobs reaching the server"
        detail={lastCall ? `last ${fmtDateTime(lastCall.at)} · ${lastCall.code}` : health ? 'no recent calls' : 'checking…'} />
      <HealthRow ok={smsCount > 0} label="SMS sent (last 24h)"
        detail={smsCount == null ? 'checking…' : `${smsCount} message${smsCount === 1 ? '' : 's'}`} />
      <HealthRow ok={stuck === 0} warn={stuck > 0} label="Orders paid but still Pending"
        detail={stuck === 0 ? 'none' : `${stuck} over 2h — check Orders`} />
      <HealthRow ok={unbooked.length === 0} warn={unbooked.length > 0} label="Paid orders missing from sales"
        detail={unbooked.length === 0 ? 'none'
          : `${unbooked.length} · GHS ${unbookedValue.toFixed(2)} — press Process & Package`} />
    </div>
  )
}

export default function Dashboard() {
  const { sales, expenses, products, user, waOrders } = useStore()

  // Automation health. Everything below runs unattended — scheduled reports,
  // payment confirmations, delivery messages — and when one breaks it breaks
  // quietly. This is the panel that makes that visible.
  const [health, setHealth] = useState(null)
  useEffect(() => {
    let live = true
    callFunction('cron-check').then(r => { if (live) setHealth(r?.sms || null) }).catch(() => {})
    return () => { live = false }
  }, [])
  const t = today(), ws = weekStartDate(), ms = monthStart()

  const todaySales = sales.filter(s => !s.voided && isoDate(s.date) === t)
  const weekSales = sales.filter(s => !s.voided && isoDate(s.date) >= ws)
  const monthSales = sales.filter(s => !s.voided && isoDate(s.date) >= ms)
  const allSales = sales.filter(s => !s.voided)
  const todayRev = todaySales.reduce((a, s) => a + s.total, 0)
  const weekRev = weekSales.reduce((a, s) => a + s.total, 0)
  const monthRev = monthSales.reduce((a, s) => a + s.total, 0)
  const allRev = allSales.reduce((a, s) => a + s.total, 0)
  const todayProfit = todaySales.reduce((a, s) => a + s.profit, 0)
  const monthProfit = monthSales.reduce((a, s) => a + s.profit, 0)
  const todayExp = expenses.filter(e => isoDate(e.date) === t).reduce((a, e) => a + e.amount, 0)
  const monthExp = expenses.filter(e => isoDate(e.date) >= ms).reduce((a, e) => a + e.amount, 0)
  // Payment split this month
  const monthCash = monthSales.filter(s => s.payment === 'Cash').reduce((a, s) => a + s.total, 0)
  const monthMomo = monthSales.filter(s => s.payment === 'Momo' || s.payment === 'Paystack').reduce((a, s) => a + s.total, 0)
  const monthSplit = monthSales.filter(s => s.payment === 'Split').reduce((a, s) => a + s.total, 0)

  // Profit margin
  const profitMargin = monthRev > 0 ? ((monthProfit / monthRev) * 100).toFixed(1) : 0

  // Stock value
  const stockValue = products.reduce((a, p) => a + p.price * p.quantity, 0)

  // How much of the month's profit figure rests on items with no cost price.
  // Profit is (price - cost), so a missing cost books the whole sale as profit.
  const exposure = unknownCostExposure(monthSales)

  const greetHour = new Date().getHours()
  const greet = greetHour < 12 ? 'Good Morning' : greetHour < 17 ? 'Good Afternoon' : 'Good Evening'

  return (
    <div>
      <div className="flex items-center justify-between mb-7">
        <div>
          <h1 className="text-[26px] md:text-[30px] font-bold tracking-tight text-gray-900">{greet}, {user?.name || 'Boss'}</h1>
          <p className="text-gray-400 text-sm mt-1">Here's what's happening in your shop today</p>
        </div>
      </div>

      {/* Revenue Cards — Cleara style: light, airy, one teal feature card */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-3.5">
        {[
          { label: "Today", value: money(todayRev), sub: todaySales.length + ' sales', feature: true },
          { label: "This Week", value: money(weekRev), sub: weekSales.length + ' sales', feature: false },
          { label: "This Month", value: money(monthRev), sub: monthSales.length + ' sales', feature: false },
          { label: "All Time", value: money(allRev), sub: allSales.length + ' total', feature: false },
        ].map((c, i) => (
          <div key={i} className={`rounded-2xl p-5 ${c.feature ? 'bg-[#0e7c86] text-white' : 'bg-white border border-gray-200/70 text-gray-900'}`}>
              <div className={`text-xs font-medium ${c.feature ? 'text-white/70' : 'text-gray-400'}`}>{c.label}</div>
              <div className="text-[24px] md:text-[26px] font-bold mt-2 tracking-tight">{c.value}</div>
              <div className={`text-[11px] font-medium mt-1 ${c.feature ? 'text-white/50' : 'text-gray-400'}`}>{c.sub}</div>
          </div>
        ))}
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-5">
        {[
          { label: "Today's Profit", value: money(todayProfit), color: 'text-gray-900' },
          { label: 'Net Today', value: money(todayProfit - todayExp), color: todayProfit - todayExp >= 0 ? 'text-gray-900' : 'text-red-500' },
          { label: 'Profit Margin', value: profitMargin + '%', color: Number(profitMargin) >= 30 ? 'text-[#0e7c86]' : Number(profitMargin) >= 15 ? 'text-amber-500' : 'text-red-500' },
          { label: 'Stock Value', value: money(stockValue), color: 'text-gray-900' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl p-4 border border-gray-200/70">
              <div className="text-[11px] text-gray-400 font-medium">{s.label}</div>
              <div className={`text-[20px] font-bold mt-1 tracking-tight ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      <SystemHealth health={health} waOrders={waOrders} />

      {/* Payment Split */}
      <div className="bg-white rounded-2xl p-5 border border-gray-200/70 mb-5">
        <h3 className="text-sm font-bold text-gray-800 mb-4">Payment Split (This Month)</h3>
        <div className="space-y-3">
          {[
            { label: 'Cash', amount: monthCash, color: 'bg-[#0e7c86]', pct: monthRev ? (monthCash / monthRev * 100) : 0 },
            { label: 'Momo', amount: monthMomo, color: 'bg-[#5bb3b9]', pct: monthRev ? (monthMomo / monthRev * 100) : 0 },
            { label: 'Split', amount: monthSplit, color: 'bg-[#b3dcdf]', pct: monthRev ? (monthSplit / monthRev * 100) : 0 },
          ].map((p, i) => (
            <div key={i}>
              <div className="flex justify-between text-xs mb-1">
                <span className="font-semibold text-gray-600">{p.label}</span>
                <span className="font-bold text-gray-800">{money(p.amount)} ({p.pct.toFixed(0)}%)</span>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${p.color}`} style={{ width: Math.max(1, p.pct) + '%' }} />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 pt-3 border-t border-gray-100 flex justify-between text-xs">
          <span className="text-gray-400">Month Expenses</span>
          <span className="font-bold text-red-500">{money(monthExp)}</span>
        </div>
        {exposure.value > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100 bg-amber-50 -mx-5 -mb-5 px-5 py-3 rounded-b-2xl">
            <div className="text-[12px] font-bold text-amber-900">Profit is overstated</div>
            <div className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
              GHS {exposure.value.toFixed(2)} across {exposure.affected} sale{exposure.affected === 1 ? '' : 's'} this month
              is counted as profit because those products have no cost price.
              Set them in Products → Catalogue health.
            </div>
          </div>
        )}
        <div className="flex justify-between text-xs mt-1">
          <span className="text-gray-400">Net Profit</span>
          <span className={`font-bold ${monthProfit - monthExp >= 0 ? 'text-[#0e7c86]' : 'text-red-500'}`}>{money(monthProfit - monthExp)}</span>
        </div>
      </div>
    </div>
  )
}
