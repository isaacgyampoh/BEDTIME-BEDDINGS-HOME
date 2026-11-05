#!/usr/bin/env node
/**
 * Copy the product photos from Supabase Storage to R2.
 *
 * It copies. It never deletes from Supabase, and it never writes to the
 * database — the apps keep serving from Supabase until a flag is flipped, and
 * flipping it back is the rollback.
 *
 *   node r2/migrate.mjs --dry-run     what it would copy, and how much
 *   node r2/migrate.mjs               copy what is missing, verify each
 *   node r2/migrate.mjs --verify      verify only, copy nothing
 *   node r2/migrate.mjs --all         include files no row references
 *
 * Needs, in the environment (never on the command line, where another user on
 * the machine can read it out of `ps`):
 *   SUPABASE_URL          the project URL
 *   SUPABASE_ANON_KEY     the public key (reads are public)
 *   R2_WORKER_URL         https://images.bedtimehome.com
 *   R2_UPLOAD_SECRET      the same value as the Worker's UPLOAD_SECRET
 *
 * Every byte is compared by SHA-256 after the copy. A file that does not match
 * is reported and left alone, because a half-copied photo that passes a size
 * check is worse than one that is obviously missing.
 */
import { createHash } from 'node:crypto'

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set`); process.exit(2) } return v }
const SUPABASE_URL = need('SUPABASE_URL')
const ANON = need('SUPABASE_ANON_KEY')
const WORKER = need('R2_WORKER_URL').replace(/\/+$/, '')
const SECRET = process.env.R2_UPLOAD_SECRET || ''

const DRY = process.argv.includes('--dry-run')
const VERIFY_ONLY = process.argv.includes('--verify')
const INCLUDE_UNREFERENCED = process.argv.includes('--all')
const BUCKET = 'product-images'
const H = { apikey: ANON, Authorization: `Bearer ${ANON}` }

if (!DRY && !VERIFY_ONLY && !SECRET) { console.error('R2_UPLOAD_SECRET is not set'); process.exit(2) }

const MB = (b) => (b / 1048576).toFixed(1) + ' MB'

const rows = async (table, select) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=${select}`, { headers: { ...H, Range: `${from}-${from + 999}` } })
    if (!r.ok) return out
    const page = await r.json()
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}

/** Every object in the bucket, walking into folders. */
async function listAll(prefix = '') {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    })
    if (!r.ok) throw new Error(`list ${prefix}: ${r.status} ${await r.text()}`)
    const page = await r.json()
    if (!Array.isArray(page) || !page.length) break
    for (const o of page) {
      if (o.id === null && !o.metadata) out.push(...await listAll(`${prefix}${o.name}/`))
      else out.push({ path: `${prefix}${o.name}`, size: o.metadata?.size || 0, type: o.metadata?.mimetype || 'image/jpeg' })
    }
    if (page.length < 1000) break
  }
  return out
}

/**
 * Every storage path any row points at — not just products.image.
 *
 * Receipts, orders and bundles embed a snapshot of the items as they were
 * sold, image URL included: 277 of the 879 referenced paths come from there.
 * A migration that copied only products.image would leave the photos on past
 * receipts pointing at a bucket that is no longer served.
 */
async function referencedPaths() {
  const refs = new Set()
  const scan = (v) => {
    for (const m of String(v ?? '').matchAll(/product-images\/([^"'\\\s)?]+)/g)) {
      refs.add(decodeURIComponent(m[1].replace(/\?.*$/, '')))
    }
  }
  for (const p of await rows('products', 'image')) scan(p.image)
  for (const i of await rows('invoices', 'image')) scan(i.image)
  for (const b of await rows('bundles', 'products')) scan(JSON.stringify(b.products))
  for (const p of await rows('promos', 'items,description')) { scan(p.description); scan(JSON.stringify(p.items)) }
  for (const s of await rows('sales', 'items')) scan(JSON.stringify(s.items))
  for (const o of await rows('whatsapp_orders', 'items')) scan(JSON.stringify(o.items))
  return refs
}

const sha = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex')

const getFromSupabase = async (path) => {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`)
  if (!r.ok) throw new Error(`supabase GET ${path}: ${r.status}`)
  return { body: await r.arrayBuffer(), type: r.headers.get('content-type') || 'image/jpeg' }
}

const headR2 = async (path) => {
  const r = await fetch(`${WORKER}/img/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD' })
  return r.ok ? Number(r.headers.get('content-length') || 0) : null
}

const getR2 = async (path) => {
  const r = await fetch(`${WORKER}/img/${path.split('/').map(encodeURIComponent).join('/')}`)
  if (!r.ok) return null
  return r.arrayBuffer()
}

const putR2 = async (path, body, type) => {
  const r = await fetch(`${WORKER}/img/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT', headers: { 'Content-Type': type, 'X-Upload-Token': SECRET }, body,
  })
  if (!r.ok) throw new Error(`r2 PUT ${path}: ${r.status} ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

// ── go ──────────────────────────────────────────────────────────────────────
console.log('Reading the bucket and the database…')
const [objects, refs] = await Promise.all([listAll(), referencedPaths()])
const inBucket = new Map(objects.map(o => [o.path, o]))

const referenced = objects.filter(o => refs.has(o.path))
const unreferenced = objects.filter(o => !refs.has(o.path))
const dangling = [...refs].filter(p => !inBucket.has(p))

const todo = INCLUDE_UNREFERENCED ? objects : referenced

console.log(`  objects in the bucket:          ${objects.length}  (${MB(objects.reduce((a, o) => a + o.size, 0))})`)
console.log(`  referenced by a row:            ${referenced.length}  (${MB(referenced.reduce((a, o) => a + o.size, 0))})`)
console.log(`  referenced by nothing:          ${unreferenced.length}  (${MB(unreferenced.reduce((a, o) => a + o.size, 0))})`)
console.log(`  referenced but missing:         ${dangling.length}${dangling.length ? '  <- BROKEN IMAGES' : ''}`)
dangling.slice(0, 10).forEach(p => console.log(`     ${p}`))
console.log(`\n  to ${VERIFY_ONLY ? 'verify' : 'copy'}: ${todo.length} files, ${MB(todo.reduce((a, o) => a + o.size, 0))}`)

if (DRY) {
  console.log('\n--dry-run: nothing was copied.')
  console.log('Unreferenced files are NOT copied unless you pass --all. Nothing is ever deleted from Supabase by this script.')
  process.exit(0)
}

let copied = 0, already = 0, verified = 0, failed = 0, bytes = 0
const problems = []

for (let i = 0; i < todo.length; i++) {
  const o = todo[i]
  const tag = `[${i + 1}/${todo.length}] ${o.path}`
  try {
    const existing = await headR2(o.path)
    if (existing === null && VERIFY_ONLY) { problems.push(`${o.path}: not in R2`); failed++; continue }

    if (existing === null) {
      const { body, type } = await getFromSupabase(o.path)
      await putR2(o.path, body, o.type || type)
      copied++; bytes += body.byteLength
    } else {
      already++
    }

    // Verify by content, not by size: two different JPEGs can be the same
    // length, and a truncated upload that happens to match is exactly the
    // failure a size check waves through.
    const [src, dst] = await Promise.all([getFromSupabase(o.path), getR2(o.path)])
    if (!dst) { problems.push(`${o.path}: missing from R2 after copy`); failed++; continue }
    const a = sha(src.body), b = sha(dst)
    if (a !== b) { problems.push(`${o.path}: contents differ (${a.slice(0, 12)} vs ${b.slice(0, 12)})`); failed++; continue }
    verified++
    if ((i + 1) % 50 === 0 || i === todo.length - 1) {
      console.log(`  ${tag} — copied ${copied}, already there ${already}, verified ${verified}, failed ${failed}`)
    }
  } catch (e) {
    problems.push(`${o.path}: ${e.message}`)
    failed++
  }
}

console.log(`\nDone. copied ${copied} (${MB(bytes)}), already present ${already}, verified ${verified}, failed ${failed}`)
if (problems.length) {
  console.log('\nPROBLEMS — nothing in Supabase has been touched, so the shop is unaffected:')
  problems.slice(0, 40).forEach(p => console.log('  ' + p))
  if (problems.length > 40) console.log(`  …and ${problems.length - 40} more`)
  process.exit(1)
}
console.log('\nEvery file verified byte-for-byte by SHA-256.')
console.log('The apps still serve from Supabase. Set VITE_IMAGE_HOST to the Worker URL and deploy to switch;')
console.log('unset it and deploy to switch back. Delete nothing from Supabase until the shop has run on R2 for a while.')
