import { suite } from './harness.mjs'
import { orderCounts, countWhere, figure, ORDER_STATES, AWAITING_PAYMENT, anyStatus, statusIs, unbookedPaid, tableCount } from '../src/lib/counts.js'
const t = suite('POS: figures counted in the database, not in memory')

// A stand-in for the Supabase client that records what was asked and answers
// from a full table — the point being that the answer must not depend on how
// much of the table the app has loaded.
const fakeSb = (rows, { failOn = null } = {}) => {
  const calls = []
  return {
    calls,
    from(table) {
      const state = { table, filters: [] }
      const api = {
        select(_cols, opts) { state.opts = opts; return api },
        in(col, vals) { state.filters.push(['in', col, vals]); return api },
        is(col, val) { state.filters.push(['is', col, val]); return api },
        // The real client's or() takes PostgREST's filter grammar as a string.
        // Parsing it here is what makes the test prove the string the app
        // actually sends, rather than a convenient object.
        or(expr) { state.filters.push(['or', null, expr]); state.or = expr; return api },
        then(resolve) {
          calls.push(state)
          if (failOn && failOn(state)) return resolve({ count: null, error: { message: 'boom' } })
          let out = rows
          for (const [kind, col, val] of state.filters) {
            if (kind === 'in') out = out.filter(r => val.includes(r[col]))
            else if (kind === 'is') out = out.filter(r => r[col] === val)
            else if (kind === 'or') {
              // e.g. "status.ilike.Paid,status.ilike.Completed" — ilike with
              // no wildcard is a case-insensitive equality test.
              const terms = String(val).split(',').map(term => {
                const [c, op, ...rest] = term.split('.')
                return { c, op, v: rest.join('.') }
              })
              out = out.filter(r => terms.some(({ c, op, v }) =>
                op === 'ilike'
                  ? String(r[c] ?? '').toLowerCase() === v.toLowerCase()
                  : String(r[c] ?? '') === v))
            }
          }
          return resolve({ count: out.length, error: null })
        },
      }
      return api
    },
  }
}

const ORDERS = [
  ...Array.from({ length: 53 }, () => ({ status: 'Paid', paid_at: '2026-11-01' })),
  ...Array.from({ length: 31 }, () => ({ status: 'Pending', paid_at: null })),
  ...Array.from({ length: 7 },  () => ({ status: 'Awaiting Payment', paid_at: null })),
  ...Array.from({ length: 12 }, () => ({ status: 'Completed', paid_at: '2026-10-30' })),
  ...Array.from({ length: 4 },  () => ({ status: 'Cancelled', paid_at: null })),
]

// ── the reported bug: the same figure read 53, then 42, then 23 ───────────
// Those were honest counts of the newest 200 or newest 500 rows. Counting in
// the database gives the same answer however much is loaded.
{
  const counts = await orderCounts(fakeSb(ORDERS))
  t.eq('paid is the whole table, not a window', counts.paid, 53)
  t.eq('pending includes orders awaiting payment', counts.pending, 38)   // 31 + 7
  t.eq('completed', counts.completed, 12)
  t.eq('cancelled', counts.cancelled, 4)
  t.eq('total', counts.total, 107)
  t.eq('awaiting payment excludes anything already paid', counts.awaiting, 38)

  // Asking twice must give the same answer — that is the whole complaint.
  const again = await orderCounts(fakeSb(ORDERS))
  t.eq('asking again gives the same paid figure', again.paid, counts.paid)
  t.eq('and the same pending figure', again.pending, counts.pending)
}

// ── no rows are transferred to count them ─────────────────────────────────
{
  const sb = fakeSb(ORDERS)
  await orderCounts(sb)
  t.ok('every count asks for a count only', sb.calls.every(c => c.opts && c.opts.count === 'exact'))
  t.ok('and fetches no rows at all', sb.calls.every(c => c.opts && c.opts.head === true))
  t.eq('one request per figure', sb.calls.length, 6)
}

// ── a failure must not look like a quiet day ──────────────────────────────
{
  const sb = fakeSb(ORDERS, { failOn: s => s.filters.some(f => f[2] && f[2].includes && f[2].includes('Paid')) })
  const counts = await orderCounts(sb)
  t.eq('a failed count is null, not zero', counts.paid, null)
  t.ok('the others still answer', counts.completed === 12 && counts.cancelled === 4)
  t.eq('no client at all gives nulls', (await orderCounts(null)).paid, null)
  t.eq('a thrown error gives null', await countWhere({ from() { throw new Error('x') } }, 'whatsapp_orders', null), null)
}

// ── a screen can tell an exact figure from a guess ────────────────────────
{
  t.eq('a counted figure is exact', figure(53, 42).value, 53)
  t.ok('and says so', figure(53, 42).exact)
  t.eq('with no count, what is loaded is shown', figure(null, 42).value, 42)
  t.ok('but not claimed as exact', !figure(null, 42).exact)
  t.eq('with neither, nothing is claimed', figure(null, null).value, null)
  t.eq('zero is a real count, not a missing one', figure(0, 42).value, 0)
  t.ok('and it is exact', figure(0, 42).exact)
}

// ── the definitions live in one place ─────────────────────────────────────
t.eq('pending covers both wordings', ORDER_STATES.pending.statuses.join(','), 'Pending,Awaiting Payment')
t.eq('awaiting payment uses the same rule as the reminder job', AWAITING_PAYMENT.join(','), 'Pending,Awaiting Payment')


// ── the row no filter could see ──────────────────────────────────────────────
// Production holds 193 orders spelled 'Cancelled' and one spelled 'cancelled'.
// Every comparison in the app used ===, so that order was absent from the
// Cancelled list and from the counts: the four status figures summed to 527
// while the table held 528. Counting in the database fixed where the figure
// came from; it did not fix a count that cannot match its own data.
{
  const MIXED = [
    ...Array.from({ length: 193 }, () => ({ status: 'Cancelled', paid_at: null })),
    { status: 'cancelled', paid_at: null },
    ...Array.from({ length: 100 }, () => ({ status: 'Pending', paid_at: null })),
    ...Array.from({ length: 50 },  () => ({ status: 'Paid', paid_at: '2026-11-03' })),
    ...Array.from({ length: 185 }, () => ({ status: 'Completed', paid_at: '2026-10-30' })),
  ]
  const sb = fakeSb(MIXED)
  const c = await orderCounts(sb)
  t.eq('a lowercase status is still a cancelled order', c.cancelled, 194)
  t.eq('pending unaffected', c.pending, 100)
  t.eq('paid unaffected', c.paid, 50)
  t.eq('completed unaffected', c.completed, 185)
  t.eq('and the total is the whole table', c.total, MIXED.length)
  // The real test of a set of figures: they add up to the table.
  t.eq('the status figures account for every order, with none counted twice',
    c.pending + c.paid + c.completed + c.cancelled, c.total)
}

// The filter string itself, because this is what goes over the wire.
t.eq('one status', anyStatus(['Paid']), 'status.ilike.Paid')
t.eq('two, comma separated', anyStatus(['Pending', 'Awaiting Payment']),
  'status.ilike.Pending,status.ilike.Awaiting Payment')
t.ok('a comma inside a value is escaped, not treated as a separator', anyStatus(['a,b']).includes('a\\,b'))

// statusIs is the in-memory half of the same rule, so an array filtered in the
// browser and a count made in the database cannot disagree about a row.
t.ok('lowercase matches', statusIs('cancelled', ['Cancelled']))
t.ok('surrounding space does not change the status', statusIs('  Paid  ', ['Paid']))
t.ok('different statuses still differ', !statusIs('Paid', ['Cancelled']))
t.ok('a missing status matches nothing', !statusIs(null, ['Pending']))
t.ok('nor an empty one', !statusIs('', ['Pending']))

// ── paid orders never booked as a sale ───────────────────────────────────────
// GHS 20,593 across 50 orders in production at the time of writing. The
// dashboard read this from an array capped at 500 rows of 529, so it quoted a
// fraction of it.
{
  const rows = [
    ...Array.from({ length: 50 }, () => ({ status: 'Paid', sale_receipt_no: null })),
    ...Array.from({ length: 185 }, (_, i) => ({ status: 'Completed', sale_receipt_no: 'RCP' + i })),
    ...Array.from({ length: 100 }, () => ({ status: 'Pending', sale_receipt_no: null })),
  ]
  t.eq('paid and completed orders with no sale row', await unbookedPaid(fakeSb(rows)), 50)
  t.eq('a bare table total', await tableCount(fakeSb(rows), 'whatsapp_orders'), 335)
  t.eq('and no client means not known, not zero', await unbookedPaid(null), null)
}
