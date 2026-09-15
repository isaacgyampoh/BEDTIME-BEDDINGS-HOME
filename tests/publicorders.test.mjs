import { suite } from './harness.mjs'
const t = suite('Public order functions: fallback contract')

// Eight call sites across the shop, the invoice page and the delivery page now
// read "call the scoped function, or fall back to the old direct query".
// rpcOrNull draws that line. Getting it wrong in either direction is bad:
//   - treating a real `{success:false}` as absent silently runs the old,
//     unscoped query instead of respecting the server's refusal
//   - treating an absence as an answer breaks ordering and paying outright on
//     any project where migration 044 has not been applied yet
//
// Mirrors src/lib/supabase.js and storefront/src/lib/supabase.js.
const rpcOrNull = ({ data, error }) => (error ? null : (data ?? null))

const missingFn = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
t.eq('an unapplied migration reads as absent', rpcOrNull(missingFn), null)
t.eq('a transport error reads as absent', rpcOrNull({ data: null, error: { message: 'Failed to fetch' } }), null)
t.eq('null data with no error reads as absent', rpcOrNull({ data: null, error: null }), null)

// A function that answers is an answer, including a refusal.
const refusal = { data: { success: false, error: 'This order is closed' }, error: null }
t.ok('a refusal is NOT absent', rpcOrNull(refusal) !== null)
t.eq('a refusal keeps its message', rpcOrNull(refusal).error, 'This order is closed')

const created = { data: { success: true, id: 'abc', ussd_code: '7412', order_no: 'WEB-X' }, error: null }
t.ok('a created order is returned', rpcOrNull(created)?.success === true)
t.eq('the ussd code survives', rpcOrNull(created).ussd_code, '7412')

// public_order_get returns the row as one JSON object, not an array of rows —
// the status poll and both pages read `.status` straight off it.
const got = { data: { id: 'abc', status: 'Paid', customer_name: 'Ama' }, error: null }
t.eq('an order reads as an object, not a row array', rpcOrNull(got).status, 'Paid')

// public_order_track returns a JSON array, and [] is a real answer meaning
// "nothing matched" — it must not be mistaken for "function missing", or the
// page would fall back and run the old ilike sweep.
t.ok('an empty track result is an answer, not an absence',
  rpcOrNull({ data: [], error: null }) !== null)
t.eq('an empty track result is empty', rpcOrNull({ data: [], error: null }).length, 0)
