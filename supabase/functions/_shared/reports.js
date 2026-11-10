/**
 * The SMS reports the shop receives, built from injected data.
 *
 * Plain JavaScript with no imports so Deno loads it inside the Edge Function
 * and Node loads it in the tests. The point is that the daily report can be
 * produced from real rows and read, without deploying anything and without
 * sending an SMS to a real phone.
 *
 * THE BUG THIS EXISTS TO FIX
 * Migration 018 schedules six reports:
 *
 *   sms-morning   07:00 daily       ?type=morning
 *   sms-midday    13:00 daily       ?type=midday
 *   sms-evening   20:00 daily       ?type=evening
 *   sms-lowstock  09:00 daily       ?type=lowstock
 *   sms-weekly    20:00 Saturdays   ?type=weekly
 *   sms-monthly   20:00 on the 28th ?type=monthly
 *
 * The function handled morning, afternoon, evening, weekly and test. So
 * `midday`, `lowstock` and `monthly` fell through to the default branch,
 * which returns HTTP 200 with a usage string — a success as far as the cron
 * job is concerned. Three of the six reports have been sending nothing, and
 * the 1pm one was handled under a name nothing calls.
 *
 * An unknown type is now a 400 rather than a 200, so the next time a schedule
 * and a handler disagree it is loud.
 */

const fmt = (n) => 'GHS ' + Number(n || 0).toFixed(2)
const dateStr = (d) => d.toISOString().slice(0, 10)

/** The five figures every report is built from. */
export function summarise(sales) {
  const s = sales || []
  const num = (x) => Number(x || 0)
  return {
    revenue: s.reduce((a, x) => a + num(x.total), 0),
    profit:  s.reduce((a, x) => a + num(x.profit), 0),
    cash:    s.filter(x => x.payment === 'Cash').reduce((a, x) => a + num(x.total), 0),
    momo:    s.filter(x => x.payment === 'Momo' || x.payment === 'Paystack').reduce((a, x) => a + num(x.total), 0),
    split:   s.filter(x => x.payment === 'Split').reduce((a, x) => a + num(x.total), 0),
    count:   s.length,
    sales:   s,
  }
}

/** The five best-selling items by quantity across these sales. */
export function topSellers(sales) {
  const map = {}
  for (const s of sales || []) {
    let items = s.items
    if (typeof items === 'string') { try { items = JSON.parse(items) } catch { items = [] } }
    for (const it of items || []) {
      const name = it.name || 'Unknown'
      if (!map[name]) map[name] = { qty: 0, rev: 0 }
      map[name].qty += Number(it.qty || 1)
      map[name].rev += Number(it.price || 0) * Number(it.qty || 1)
    }
  }
  return Object.entries(map).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5)
}

/** Which dates each report covers. Pure, so it can be tested on its own. */
export function windowFor(type, now = new Date()) {
  const d = (x) => dateStr(x)
  if (type === 'morning') {
    const y = new Date(now); y.setDate(y.getDate() - 1)
    return { from: d(y), to: d(y), label: y.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }) }
  }
  if (type === 'midday' || type === 'afternoon' || type === 'evening' || type === 'lowstock') {
    return { from: d(now), to: d(now), label: now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) }
  }
  if (type === 'weekly') {
    const mon = new Date(now); mon.setDate(now.getDate() - 7 - ((now.getDay() + 6) % 7))
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
    return { from: d(mon), to: d(sun),
             label: `${mon.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${sun.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
             days: 7 }
  }
  if (type === 'monthly') {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    return { from: d(first), to: d(last),
             label: first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
             days: last.getUTCDate() }
  }
  return null
}

/** Every report type a schedule may ask for. */
export const TYPES = ['morning', 'midday', 'afternoon', 'evening', 'lowstock', 'weekly', 'monthly', 'test']

/**
 * Build one report.
 *
 * `data` supplies the rows: { sales(from,to), expenses(from,to), lowStock() }.
 * Nothing here knows about Supabase, a database, or HTTP.
 */
export async function buildReport(type, data, now = new Date()) {
  if (type === 'test') {
    return 'BEDTIME BEDDINGS & HOME SMS Reports Active!\n\nYou will receive:\n7AM - Yesterday summary\n1PM - Today so far\n8PM - End of day\n9AM - Low stock\nSaturday 8PM - Weekly\n28th 8PM - Monthly\n\n- BEDTIME BEDDINGS & HOME'
  }
  const w = windowFor(type, now)
  if (!w) return null

  // The low-stock report needs no sales at all.
  if (type === 'lowstock') {
    const low = await data.lowStock()
    if (!low.length) return `Low Stock Check\n${w.label}\n\nNothing is running low. All good.\n\n- BEDTIME BEDDINGS & HOME`
    let msg = `Low Stock Check\n${w.label}\n\n${low.length} item${low.length === 1 ? '' : 's'} at or below 5:\n\n`
    for (const p of low) msg += `- ${p.name}: ${p.quantity} left\n`
    msg += `\n- BEDTIME BEDDINGS & HOME`
    return msg
  }

  const s = summarise(await data.sales(w.from, w.to))
  const e = await data.expenses(w.from, w.to)
  const net = s.profit - e.total

  if (type === 'morning') {
    let msg = `Good Morning!\nYesterday's Report (${w.label})\n\n`
    msg += `Revenue: ${fmt(s.revenue)}\nSales: ${s.count}\nProfit: ${fmt(s.profit)}\nExpenses: ${fmt(e.total)}\nNet: ${fmt(net)}\n\n`
    msg += `Cash: ${fmt(s.cash)}\nMomo: ${fmt(s.momo)}\n`
    if (s.split > 0) msg += `Split: ${fmt(s.split)}\n`
    const top = topSellers(s.sales)
    if (top.length) { msg += `\nTop Sellers:\n`; top.forEach(([n, d], i) => { msg += `${i + 1}. ${n} (${d.qty})\n` }) }
    const low = await data.lowStock()
    if (low.length) { msg += `\nLow Stock:\n`; low.slice(0, 5).forEach(p => { msg += `- ${p.name}: ${p.quantity} left\n` }) }
    return msg + `\n- BEDTIME BEDDINGS & HOME`
  }

  if (type === 'midday' || type === 'afternoon') {
    let msg = `Afternoon Update\nToday So Far\n\n`
    msg += `Revenue: ${fmt(s.revenue)}\nSales: ${s.count}\nProfit: ${fmt(s.profit)}\nExpenses: ${fmt(e.total)}\nNet: ${fmt(net)}\n\n`
    msg += `Cash: ${fmt(s.cash)}\nMomo: ${fmt(s.momo)}\n`
    if (s.count === 0) msg += `\nNo sales yet. Let's push!\n`
    return msg + `\n- BEDTIME BEDDINGS & HOME`
  }

  if (type === 'evening') {
    let msg = `End of Day Report\n${w.label}\n\n`
    msg += `Revenue: ${fmt(s.revenue)}\nTotal Sales: ${s.count}\nProfit: ${fmt(s.profit)}\nExpenses: ${fmt(e.total)} (${e.count})\nNet Profit: ${fmt(net)}\n\n`
    msg += `Cash: ${fmt(s.cash)}\nMomo: ${fmt(s.momo)}\n`
    if (s.split > 0) msg += `Split: ${fmt(s.split)}\n`
    const top = topSellers(s.sales)
    if (top.length) { msg += `\nBest Sellers:\n`; top.forEach(([n, d], i) => { msg += `${i + 1}. ${n} x${d.qty}\n` }) }
    return msg + `\nDay closed. Well done!\n- BEDTIME BEDDINGS & HOME`
  }

  if (type === 'weekly' || type === 'monthly') {
    const heading = type === 'weekly' ? 'WEEKLY REPORT' : 'MONTHLY REPORT'
    let msg = `${heading}\n${w.label}\n\n`
    msg += `Revenue: ${fmt(s.revenue)}\nSales: ${s.count}\nProfit: ${fmt(s.profit)}\nExpenses: ${fmt(e.total)}\nNet: ${fmt(net)}\nAvg/Day: ${fmt(s.revenue / w.days)}\n\n`
    msg += `Cash: ${fmt(s.cash)}\nMomo: ${fmt(s.momo)}\n`
    const top = topSellers(s.sales)
    if (top.length) { msg += `\nTop 5:\n`; top.forEach(([n, d], i) => { msg += `${i + 1}. ${n} x${d.qty}\n` }) }
    const low = await data.lowStock()
    if (low.length) { msg += `\nRestock:\n`; low.forEach(p => { msg += `- ${p.name}: ${p.quantity}\n` }) }
    msg += type === 'weekly' ? `\nNew week, new targets!\n` : `\nAnother month done.\n`
    return msg + `- BEDTIME BEDDINGS & HOME`
  }

  return null
}
