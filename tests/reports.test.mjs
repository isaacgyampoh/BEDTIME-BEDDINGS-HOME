import { suite } from './harness.mjs'
import { buildReport, windowFor, summarise, topSellers, TYPES } from '../supabase/functions/_shared/reports.js'
const t = suite('The SMS reports the shop actually receives')

/**
 * Migration 018 schedules six reports. The function handled five names, and
 * only three of them matched: midday, lowstock and monthly fell through to a
 * default branch that returns HTTP 200 with a usage string. pg_cron recorded
 * six successes a day while three of them sent nothing, and the 1pm report
 * was implemented under the name `afternoon`, which nothing calls.
 */
const SCHEDULED = ['morning', 'midday', 'evening', 'lowstock', 'weekly', 'monthly']
const NOW = new Date('2026-11-10T20:00:00Z')   // a Tuesday

const SALES = [
  { total: 100, profit: 40, payment: 'Cash',     items: JSON.stringify([{ name: 'Duvet', qty: 2, price: 50 }]) },
  { total: 200, profit: 80, payment: 'Momo',     items: JSON.stringify([{ name: 'Sheet', qty: 1, price: 200 }]) },
  { total: 300, profit: 90, payment: 'Paystack', items: [{ name: 'Duvet', qty: 1, price: 300 }] },
  { total:  50, profit: 10, payment: 'Split',    items: null },
]
const data = {
  sales: async () => SALES,
  expenses: async () => ({ total: 30, count: 2 }),
  lowStock: async () => [{ name: 'Pillow', quantity: 1 }, { name: 'Towel', quantity: 0 }],
}
const noData = { sales: async () => [], expenses: async () => ({ total: 0, count: 0 }), lowStock: async () => [] }

// ── every scheduled type must produce a message ────────────────────────────
for (const type of SCHEDULED) {
  const msg = await buildReport(type, data, NOW)
  t.ok(`${type} produces a report`, typeof msg === 'string' && msg.length > 0)
  t.ok(`${type} is signed by the shop`, /BEDTIME BEDDINGS & HOME$/.test(msg || ''))
}

// ── the three that silently sent nothing ───────────────────────────────────
t.ok('midday is handled (13:00 daily, was not)', !!await buildReport('midday', data, NOW))
t.ok('lowstock is handled (09:00 daily, was not)', !!await buildReport('lowstock', data, NOW))
t.ok('monthly is handled (28th, was not)', !!await buildReport('monthly', data, NOW))

// ── an unknown type must be refusable, so the 400 path can fire ────────────
t.eq('an unknown type returns null rather than a report', await buildReport('quarterly', data, NOW), null)
t.eq('and an empty type too', await buildReport('', data, NOW), null)

// ── the windows each report covers ─────────────────────────────────────────
t.eq('morning covers yesterday', windowFor('morning', NOW).from, '2026-11-09')
t.eq('and only yesterday', windowFor('morning', NOW).to, '2026-11-09')
t.eq('midday covers today', windowFor('midday', NOW).from, '2026-11-10')
t.eq('evening covers today', windowFor('evening', NOW).to, '2026-11-10')
t.eq('weekly starts on the previous Monday', windowFor('weekly', NOW).from, '2026-11-02')
t.eq('and ends on that Sunday', windowFor('weekly', NOW).to, '2026-11-08')
t.eq('weekly averages over 7 days', windowFor('weekly', NOW).days, 7)
t.eq('monthly starts on the 1st', windowFor('monthly', NOW).from, '2026-11-01')
t.eq('and ends on the last day', windowFor('monthly', NOW).to, '2026-11-30')
t.eq('November has 30 days to average over', windowFor('monthly', NOW).days, 30)
t.eq('an unknown type has no window', windowFor('nonsense', NOW), null)

// midday and afternoon are the same report; the schedule calls it midday and
// the old code called it afternoon, which is how the 1pm report went missing.
t.eq('afternoon remains an alias for midday',
  await buildReport('afternoon', data, NOW), await buildReport('midday', data, NOW))

// ── the arithmetic ─────────────────────────────────────────────────────────
{
  const s = summarise(SALES)
  t.eq('revenue is the sum of totals', s.revenue, 650)
  t.eq('profit is the sum of profits', s.profit, 220)
  t.eq('cash counts only cash', s.cash, 100)
  t.eq('momo counts Momo and Paystack together', s.momo, 500)
  t.eq('split is its own figure', s.split, 50)
  t.eq('count is the number of sales', s.count, 4)
  t.eq('no sales means no revenue, not NaN', summarise([]).revenue, 0)
  t.eq('and a missing array is not a crash', summarise(null).count, 0)
}
{
  const top = topSellers(SALES)
  t.eq('the best seller is by quantity', top[0][0], 'Duvet')
  t.eq('quantities add across sales', top[0][1].qty, 3)
  t.ok('items stored as a JSON string are parsed', top.some(([n]) => n === 'Sheet'))
  t.eq('a sale with no items does not break it', topSellers([{ items: null }]).length, 0)
  t.eq('nor does unparseable JSON', topSellers([{ items: '{oops' }]).length, 0)
}

// ── a quiet day must read as a quiet day, not as a broken report ───────────
{
  const midday = await buildReport('midday', noData, NOW)
  t.ok('a day with no sales says so', /No sales yet/.test(midday))
  t.ok('and shows zero rather than nothing', /Revenue: GHS 0\.00/.test(midday))
  const low = await buildReport('lowstock', noData, NOW)
  t.ok('nothing low is stated plainly', /Nothing is running low/.test(low))
  const evening = await buildReport('evening', noData, NOW)
  t.ok('an empty evening report still closes the day', /Day closed/.test(evening))
}

// ── the low-stock report ───────────────────────────────────────────────────
{
  const msg = await buildReport('lowstock', data, NOW)
  t.ok('it counts the items', /2 items at or below 5/.test(msg))
  t.ok('and names them with their quantity', /- Pillow: 1 left/.test(msg))
  const one = await buildReport('lowstock', { ...data, lowStock: async () => [{ name: 'X', quantity: 2 }] }, NOW)
  t.ok('one item is not "1 items"', /1 item at or below 5/.test(one))
}

// ── the test message names what is actually scheduled ──────────────────────
{
  const msg = await buildReport('test', data, NOW)
  t.ok('it mentions the low-stock report', /Low stock/i.test(msg))
  t.ok('and the monthly one', /Monthly/i.test(msg))
}

t.ok('every scheduled type is in TYPES', SCHEDULED.every(x => TYPES.includes(x)))
