/**
 * The slice of PostgREST that Bedtime's Edge Functions actually use, served
 * from a local PostgreSQL. It exists so the real function can run under the
 * real Deno runtime against real rows, instead of being called "verified"
 * because it parsed.
 *
 *   node postgrest-shim.mjs <database> <port>
 *
 * Read-only by default: a write is recorded and acknowledged but not applied,
 * so running a function cannot alter the staging snapshot mid-reconciliation.
 * Pass --allow-writes to let PATCH through.
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'

const DB = process.argv[2] || 'bedtime_staging'
const PORT = Number(process.argv[3] || 54321)
const ALLOW_WRITES = process.argv.includes('--allow-writes')
const writes = []

const q = (sql) => JSON.parse(execFileSync('psql', ['-t','-A','-d',DB,'-c',
  `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t`], { encoding:'utf8' }).trim() || '[]')

const ident = (s) => '"' + String(s).replace(/"/g,'') + '"'
const lit = (s) => "'" + String(s).replace(/'/g,"''") + "'"

/** PostgREST's filter grammar, for the operators these functions send. */
function where(params) {
  const parts = []
  for (const [key, raw] of params) {
    if (['select','order','limit','offset','and','on_conflict'].includes(key)) continue
    if (key === 'or') {
      // or=(status.ilike.Paid,status.ilike.Completed)
      const inner = raw.replace(/^\(|\)$/g, '')
      const terms = inner.split(',').map(t => {
        const [col, op, ...rest] = t.split('.')
        const v = rest.join('.')
        if (op === 'ilike') return `${ident(col)} ILIKE ${lit(v)}`
        if (op === 'eq') return `${ident(col)} = ${lit(v)}`
        if (op === 'is') return `${ident(col)} IS ${v === 'null' ? 'NULL' : v.toUpperCase()}`
        return 'TRUE'
      })
      parts.push('(' + terms.join(' OR ') + ')')
      continue
    }
    const m = /^(eq|neq|gt|gte|lt|lte|like|ilike|is|in|not)\.(.*)$/s.exec(raw)
    if (!m) continue
    const [, op, v] = m
    const C = ident(key)
    if (op === 'eq')  parts.push(`${C} = ${lit(v)}`)
    else if (op === 'neq') parts.push(`${C} <> ${lit(v)}`)
    else if (op === 'gt')  parts.push(`${C} > ${lit(v)}`)
    else if (op === 'gte') parts.push(`${C} >= ${lit(v)}`)
    else if (op === 'lt')  parts.push(`${C} < ${lit(v)}`)
    else if (op === 'lte') parts.push(`${C} <= ${lit(v)}`)
    else if (op === 'like')  parts.push(`${C} LIKE ${lit(v.replace(/\*/g,'%'))}`)
    else if (op === 'ilike') parts.push(`${C} ILIKE ${lit(v.replace(/\*/g,'%'))}`)
    else if (op === 'is')  parts.push(`${C} IS ${v === 'null' ? 'NULL' : v.toUpperCase()}`)
    else if (op === 'in')  parts.push(`${C} IN (${v.replace(/^\(|\)$/g,'').split(',').map(x=>lit(x.replace(/^"|"$/g,''))).join(',')})`)
  }
  return parts.length ? 'WHERE ' + parts.join(' AND ') : ''
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  if (req.method === 'OPTIONS') return send(204, '')

  const m = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(url.pathname)
  if (!m) return send(404, { message: 'shim: only /rest/v1/<table>', path: url.pathname })
  const table = m[1]
  const params = [...url.searchParams.entries()]

  try {
    if (req.method === 'GET') {
      const select = url.searchParams.get('select') || '*'
      const cols = select === '*' ? '*' : select.split(',').map(c => ident(c.trim())).join(',')
      const ord = url.searchParams.get('order')
      let orderSql = ''
      if (ord) {
        orderSql = 'ORDER BY ' + ord.split(',').map(o => {
          const [c, dir] = o.split('.')
          return `${ident(c)} ${/^desc/i.test(dir || '') ? 'DESC' : 'ASC'} NULLS LAST`
        }).join(',')
      }
      const lim = url.searchParams.get('limit')
      // supabase-js .range() sends a Range header.
      const range = /(\d+)-(\d+)/.exec(req.headers.range || '')
      const limit = lim ? Number(lim) : (range ? Number(range[2]) - Number(range[1]) + 1 : null)
      const offset = range ? Number(range[1]) : 0
      const sql = `SELECT ${cols} FROM ${ident(table)} ${where(params)} ${orderSql}` +
                  (limit != null ? ` LIMIT ${limit}` : '') + (offset ? ` OFFSET ${offset}` : '')
      const rows = q(sql)
      const total = q(`SELECT count(*)::int AS c FROM ${ident(table)} ${where(params)}`)[0]?.c ?? rows.length
      return send(200, rows, { 'Content-Range': `${offset}-${offset + Math.max(rows.length - 1, 0)}/${total}` })
    }
    if (req.method === 'PATCH' || req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      writes.push({ method: req.method, table, filter: url.search, body: body.slice(0, 200) })
      if (!ALLOW_WRITES) return send(200, [])   // acknowledged, not applied

      // Both branches used to return the same thing, so --allow-writes did
      // nothing and an idempotency claim based on it would have been false.
      const patch = JSON.parse(body || '{}')
      const sets = Object.entries(patch)
        .map(([k, v]) => `${ident(k)} = ${v === null ? 'NULL' : lit(v)}`).join(', ')
      if (!sets) return send(200, [])
      const sql = `WITH u AS (UPDATE ${ident(table)} SET ${sets} ${where(params)} RETURNING *) ` +
                  `SELECT COALESCE(json_agg(u), '[]'::json)::text FROM u`
      const out = execFileSync('psql', ['-t','-A','-d',DB,'-c',sql], { encoding:'utf8' }).trim()
      return send(200, out || '[]')
    }
    return send(405, { message: 'shim: method not supported' })
  } catch (e) {
    return send(500, { message: 'shim error: ' + e.message })
  }
})

server.listen(PORT, () => {
  console.error(`shim: ${DB} on :${PORT}  writes=${ALLOW_WRITES ? 'applied' : 'recorded only'}`)
})
process.on('SIGTERM', () => {
  console.error(`shim: ${writes.length} write(s) attempted`)
  for (const w of writes) console.error(`  ${w.method} ${w.table}${w.filter} ${w.body}`)
  process.exit(0)
})
