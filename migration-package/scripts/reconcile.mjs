#!/usr/bin/env node
/**
 * Reconcile a restored Bedtime database against a source.
 *
 *   reconcile.mjs --db bedtime_staging --against api
 *   reconcile.mjs --db bedtime_staging --against <source-db>
 *
 * `--against api` compares with production over PostgREST using the public
 * key, which can only see the 16 readable tables. `--against <db>` compares
 * two local databases, which is what a real dump allows and is the only form
 * that can reconcile `staff`.
 *
 * Read-only on both sides.
 *
 * WHY A COMMITTED SCRIPT AND NOT A ONE-OFF
 * The figures in docs/ were produced by a script in a scratch directory that
 * the next session deleted. A reconciliation that cannot be re-run is a
 * screenshot, not a check, and the shop trades continuously so last week's
 * totals are already wrong. This is the thing a cutover gate calls.
 *
 * NEVER PRINTS A PIN. `staff` is reconciled by row count, by how many rows
 * carry a bcrypt `pin_hash`, and by how many still carry plaintext. The
 * values themselves are never selected.
 */
import { execFileSync } from 'node:child_process'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d }
const DB = arg('--db')
const AGAINST = arg('--against', 'api')
if (!DB) { console.error('usage: reconcile.mjs --db <database> [--against api|<database>]'); process.exit(2) }

const SUPA = process.env.SUPABASE_URL || 'https://wqkgfvmvuljzexhevlnp.supabase.co'
const ANON = process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indxa2dmdm12dWxqemV4aGV2bG5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwMTc5NzEsImV4cCI6MjEwMDU5Mzk3MX0.BOAaKOnE_RaZtTBa_GED793Xn5hdjRxT4hEvG_Ivkpo'

const sql = (db, q) => execFileSync('psql', ['-t', '-A', '-d', db, '-c', q], { encoding: 'utf8' }).trim()
const dst = (q) => sql(DB, q)
const srcIsDb = AGAINST !== 'api'

const api = async (path) => {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r
}
const apiCount = async (t) => {
  const r = await fetch(`${SUPA}/rest/v1/${t}?select=id`, { headers: { apikey: ANON, Range: '0-0', Prefer: 'count=exact' } })
  if (r.status === 401 || r.status === 403) return null
  return (r.headers.get('content-range') || '/0').split('/')[1]
}
const apiAll = async (t, sel) => {
  const out = []
  for (let f = 0; ; f += 1000) {
    const r = await fetch(`${SUPA}/rest/v1/${t}?select=${sel}`, { headers: { apikey: ANON, Range: `${f}-${f + 999}` } })
    if (!r.ok) return out
    const p = await r.json(); out.push(...p); if (p.length < 1000) break
  }
  return out
}

const n = (x) => Number(x) || 0
const money = (v) => Number(v).toFixed(2)
const rows = []
const add = (metric, src, dstv) => rows.push({ metric, src, dst: dstv, ok: String(src) === String(dstv) })

const TABLES = ['products','customers','bundles','promos','expenses','sales',
                'whatsapp_orders','product_price_history','social_posts',
                'invoices','refunds','stock_adjustments','stock_takes','wa_conversations']
const PROTECTED = ['staff','pin_attempts','sms_log','sms_exempt_numbers','social_connections']

for (const t of TABLES) {
  const s = srcIsDb ? sql(AGAINST, `SELECT count(*) FROM ${t}`) : await apiCount(t)
  add(`rows · ${t}`, s ?? 'unreadable', dst(`SELECT count(*) FROM ${t}`))
}

// Money and inventory. Computed the same way on both sides.
const AGG = [
  ['sales · live rows',              `SELECT count(*) FROM sales WHERE voided = false`,                 (r) => r.filter(x=>!x.voided).length],
  ['sales · revenue GHS',            `SELECT COALESCE(sum(total),0) FROM sales WHERE voided = false`,    (r) => money(r.filter(x=>!x.voided).reduce((a,x)=>a+n(x.total),0))],
  ['sales · profit GHS',             `SELECT COALESCE(sum(profit),0) FROM sales WHERE voided = false`,   (r) => money(r.filter(x=>!x.voided).reduce((a,x)=>a+n(x.profit),0))],
  ['sales · discount GHS',           `SELECT COALESCE(sum(discount),0) FROM sales WHERE voided = false`, (r) => money(r.filter(x=>!x.voided).reduce((a,x)=>a+n(x.discount),0))],
]
const salesRows = srcIsDb ? null : await apiAll('sales', 'total,profit,discount,voided')
for (const [label, q, fromApi] of AGG) {
  const s = srcIsDb ? sql(AGGDB(AGAINST), q) : fromApi(salesRows)
  add(label, /GHS/.test(label) ? money(s) : s, /GHS/.test(label) ? money(dst(q)) : dst(q))
}
function AGGDB(db) { return db }

const prodRows = srcIsDb ? null : await apiAll('products', 'quantity,price,cost_price')
const pq = `SELECT COALESCE(sum(quantity),0) FROM products`
const pr = `SELECT COALESCE(sum(price*quantity),0) FROM products`
const pc = `SELECT COALESCE(sum(cost_price*quantity),0) FROM products`
add('inventory · units',            srcIsDb ? sql(AGAINST,pq) : prodRows.reduce((a,p)=>a+n(p.quantity),0), dst(pq))
add('inventory · retail value GHS', money(srcIsDb ? sql(AGAINST,pr) : prodRows.reduce((a,p)=>a+n(p.price)*n(p.quantity),0)), money(dst(pr)))
add('inventory · cost value GHS',   money(srcIsDb ? sql(AGAINST,pc) : prodRows.reduce((a,p)=>a+n(p.cost_price)*n(p.quantity),0)), money(dst(pc)))

const custRows = srcIsDb ? null : await apiAll('customers', 'total_spent,visit_count')
const cs = `SELECT COALESCE(sum(total_spent),0) FROM customers`
const cv = `SELECT COALESCE(sum(visit_count),0) FROM customers`
add('customers · lifetime spend GHS', money(srcIsDb ? sql(AGAINST,cs) : custRows.reduce((a,c)=>a+n(c.total_spent),0)), money(dst(cs)))
add('customers · visits',             srcIsDb ? sql(AGAINST,cv) : custRows.reduce((a,c)=>a+n(c.visit_count),0), dst(cv))

const ordRows = srcIsDb ? null : await apiAll('whatsapp_orders', 'total')
const ov = `SELECT COALESCE(sum(total),0) FROM whatsapp_orders`
add('orders · value GHS', money(srcIsDb ? sql(AGAINST,ov) : ordRows.reduce((a,o)=>a+n(o.total),0)), money(dst(ov)))

const expRows = srcIsDb ? null : await apiAll('expenses', 'amount')
const ev = `SELECT COALESCE(sum(amount),0) FROM expenses`
add('expenses · total GHS', money(srcIsDb ? sql(AGAINST,ev) : expRows.reduce((a,e)=>a+n(e.amount),0)), money(dst(ev)))

// Identifiers must be preserved, not regenerated.
const idCheck = async (label, table, col, apiSel) => {
  const d = dst(`SELECT ${col} FROM ${table} ORDER BY ${col}`).split('\n').filter(Boolean)
  const s = srcIsDb
    ? sql(AGAINST, `SELECT ${col} FROM ${table} ORDER BY ${col}`).split('\n').filter(Boolean)
    : (await apiAll(table, apiSel)).map(r => r[col]).filter(v => v != null).map(String).sort()
  add(label, 'identical', JSON.stringify(s) === JSON.stringify(d) ? 'identical' : 'DIFFER')
}
await idCheck('sales · receipt numbers',  'sales',           'receipt_no', 'receipt_no')
await idCheck('products · ids',           'products',        'id',         'id')
await idCheck('orders · order numbers',   'whatsapp_orders', 'order_no',   'order_no')

// The protected tables. Only reconcilable from a real dump.
console.log('')
if (srcIsDb) {
  for (const t of PROTECTED) {
    const exists = dst(`SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${t}'`)
    if (exists === '0') { add(`rows · ${t}`, 'absent', 'absent'); continue }
    add(`rows · ${t}`, sql(AGAINST, `SELECT count(*) FROM ${t}`), dst(`SELECT count(*) FROM ${t}`))
  }
  // Credential shape, never credential values.
  const hashed = `SELECT count(*) FROM staff WHERE pin_hash IS NOT NULL AND pin_hash LIKE '$2%'`
  const plain  = `SELECT count(*) FROM staff WHERE pin IS NOT NULL AND pin <> ''`
  add('staff · rows with a bcrypt pin_hash', sql(AGAINST, hashed), dst(hashed))
  add('staff · rows still holding plaintext', sql(AGAINST, plain), dst(plain))
} else {
  for (const t of PROTECTED) add(`rows · ${t}`, 'unreadable (public key)', '—')
}

const pad = (s, w) => String(s).padEnd(w)
console.log(pad('METRIC', 40) + pad(srcIsDb ? `SOURCE (${AGAINST})` : 'PRODUCTION (api)', 26) + pad(`RESTORED (${DB})`, 24))
for (const r of rows) {
  const flag = r.src === 'unreadable (public key)' ? 'BLOCKED'
             : r.src === 'absent' ? 'n/a'
             : r.ok ? 'match' : '*** DIFFERS ***'
  console.log(pad(r.metric, 40) + pad(r.src, 26) + pad(r.dst, 24) + flag)
}
const differ = rows.filter(r => !r.ok && r.src !== 'unreadable (public key)' && r.src !== 'absent')
const blocked = rows.filter(r => r.src === 'unreadable (public key)')
console.log(`\n${rows.length - differ.length - blocked.length} match · ${differ.length} differ · ${blocked.length} blocked`)

console.log('\nREFERENTIAL INTEGRITY in the restored database')
for (const [label, q] of [
  ['orders pointing at a missing sale', `SELECT count(*) FROM whatsapp_orders o WHERE o.sale_receipt_no IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.receipt_no=o.sale_receipt_no)`],
  ['price history for absent products', `SELECT count(*) FROM product_price_history h WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id=h.product_id)`],
  ['duplicate receipt numbers',         `SELECT count(*) FROM (SELECT receipt_no FROM sales GROUP BY 1 HAVING count(*)>1) x`],
  ['duplicate order numbers',           `SELECT count(*) FROM (SELECT order_no FROM whatsapp_orders GROUP BY 1 HAVING count(*)>1) x`],
]) console.log(`  ${pad(label, 36)}${dst(q)}`)

if (differ.length) { console.log('\nRECONCILIATION FAILED. Do not cut over.'); process.exit(1) }
if (blocked.length) { console.log('\nReconciled for everything readable. The protected tables need a real dump (--against <db>).'); process.exit(0) }
console.log('\nFull reconciliation passed.')
