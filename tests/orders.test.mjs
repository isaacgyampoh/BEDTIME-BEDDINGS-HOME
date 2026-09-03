import { suite } from './harness.mjs'
const t = suite('Online order items and stock')

// Both clients insert `items: JSON.stringify(items)` into a jsonb column, so
// the value is a JSON *string*, not an array. Every consumer must cope, or it
// silently reads nothing — that is why online sales recorded profit 0.00 and
// why stock was never deducted.
const waItems = (v) => {
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}
const arr = [{ name: 'Chopping board', qty: 2, price: 35, lineTotal: 70, productId: '1eb514c8' }]

t.eq('real array passes through', waItems(arr).length, 1)
t.eq('double-encoded string decodes', waItems(JSON.stringify(arr)).length, 1)
t.eq('null is empty', waItems(null).length, 0)
t.eq('malformed json is empty, not a throw', waItems('{not json').length, 0)
t.eq('a json object (not array) is empty', waItems('{"a":1}').length, 0)

const profit = (items, costs) => waItems(items).reduce((a, i) => {
  const c = costs[i.productId] ?? costs[i.name]
  return c == null ? a : a + (Number(i.price) - c) * Number(i.qty)
}, 0)
const costs = { '1eb514c8': 25 }
t.eq('profit from a real array', profit(arr, costs), 20)
t.eq('profit from a double-encoded string', profit(JSON.stringify(arr), costs), 20)
t.eq('unknown product contributes nothing', profit(arr, {}), 0)
t.eq('matches by name when id is unknown', profit(arr, { 'Chopping board': 25 }), 20)

// complete_wa_order maps source to the reporting bucket.
const saleType = (s) => s === 'web' ? 'Online' : s === 'whatsapp' ? 'WhatsApp' : 'Retail'
t.eq('web -> Online', saleType('web'), 'Online')
t.eq('whatsapp -> WhatsApp', saleType('whatsapp'), 'WhatsApp')
t.eq('walkin -> Retail', saleType('walkin'), 'Retail')

// Idempotency is a link, not a status guard. The old guard was tripped by the
// caller's own status update, so the sale was never recorded at all.
const claim = (order) => order.saleReceiptNo
  ? { recorded: false, receipt: order.saleReceiptNo, already: true }
  : (['Paid', 'Completed'].includes(order.status)
      ? { recorded: true, receipt: 'RCP-NEW', already: false }
      : { error: 'Order is not paid yet' })
t.eq('paid order records once', claim({ status: 'Paid' }).recorded, true)
t.eq('completed order still records', claim({ status: 'Completed' }).recorded, true)
t.eq('second call returns the same receipt', claim({ status: 'Completed', saleReceiptNo: 'RCP-1' }).receipt, 'RCP-1')
t.eq('second call creates nothing new', claim({ status: 'Completed', saleReceiptNo: 'RCP-1' }).recorded, false)
t.ok('unpaid order is refused', !!claim({ status: 'Pending' }).error)

// Voided sales must never reach a revenue total.
const sales = [
  { total: 100, voided: false }, { total: 50, voided: true }, { total: 25, voided: false },
]
t.eq('revenue excludes voided', sales.filter(s => !s.voided).reduce((a, s) => a + s.total, 0), 125)
