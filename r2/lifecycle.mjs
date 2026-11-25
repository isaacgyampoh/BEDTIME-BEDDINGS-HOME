#!/usr/bin/env node
/**
 * Find product images that nothing references any more, and — only when told
 * to, twice — remove them.
 *
 *   node r2/lifecycle.mjs                 report only. Deletes nothing.
 *   node r2/lifecycle.mjs --quarantine    copy orphans aside, then delete
 *   node r2/lifecycle.mjs --restore <key> put one back from quarantine
 *
 * Needs, in the environment:
 *   SUPABASE_URL, SUPABASE_ANON_KEY      to read what the database references
 *   R2_WORKER_URL, R2_UPLOAD_SECRET      to list and remove
 *
 * THE PROBLEM THIS SOLVES
 *
 * Nothing in the app deletes an image. Replacing a product photo writes a new
 * timestamped path and simply abandons the old one, so the bucket grows for
 * ever. Supabase Storage already carries 205 objects that no row mentions;
 * R2 will accumulate the same way.
 *
 * WHY IT IS CAUTIOUS TO THE POINT OF BEING SLOW
 *
 * "No row mentions it" is not the same as "nothing needs it", and the cost of
 * being wrong is a product page, a past receipt or an invoice with a missing
 * picture — which cannot be undone once the bytes are gone.
 *
 * So, in order:
 *
 *   1. References are gathered from EVERY place a URL can hide, not just
 *      products.image: the item snapshots kept on sales, orders and bundles
 *      record the image as it was at the time, and promos and invoices have
 *      their own. A migration that looked only at products.image would orphan
 *      every receipt from August onwards.
 *   2. An object must be older than RETENTION_DAYS (default 30). A photo
 *      uploaded minutes ago may belong to a row that has not been written yet.
 *   3. Nothing is deleted without --quarantine, which COPIES each object to
 *      quarantine/<key> first and verifies the copy reads back before the
 *      original is removed. --restore puts one back.
 *   4. It refuses entirely if the reference scan returns suspiciously little,
 *      which is what a failed query looks like — and a failed query would
 *      otherwise mean "everything is an orphan".
 */
import { createHash } from 'node:crypto'

const SUPABASE_URL = process.env.SUPABASE_URL
// A service key, not the anon key. Since migration 055 the public key cannot
// read whatsapp_orders, and reading the order snapshots is exactly how this
// tool avoids deleting an image a past receipt still shows.
const ANON = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
const WORKER = (process.env.R2_WORKER_URL || '').replace(/\/+$/, '')
const SECRET = process.env.R2_UPLOAD_SECRET
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30)

const QUARANTINE = process.argv.includes('--quarantine')
const RESTORE_IDX = process.argv.indexOf('--restore')
const RESTORE_KEY = RESTORE_IDX >= 0 ? process.argv[RESTORE_IDX + 1] : null

if (!SUPABASE_URL || !ANON) { console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required'); process.exit(2) }
if (!WORKER) { console.error('R2_WORKER_URL is required'); process.exit(2) }

const sb = async (path) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, Accept: 'application/json' },
  })
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`)
  return r.json()
}

/** Every storage key mentioned anywhere in the database. */
async function referencedKeys() {
  const keys = new Set()
  const add = (v) => {
    if (!v) return
    const s = String(v)
    // Both the Supabase-shaped URL and a bare key are accepted, because the
    // row may hold either depending on when it was written.
    const m = s.match(/product-images\/(products\/[^"'\s?)]+)/g) || []
    for (const hit of m) keys.add(hit.replace('product-images/', ''))
    const direct = s.match(/\bproducts\/[A-Za-z0-9._-]+\.(jpe?g|png|webp|avif)\b/g) || []
    for (const hit of direct) keys.add(hit)
  }
  const walk = (v) => {
    if (v == null) return
    if (typeof v === 'string') return add(v)
    if (Array.isArray(v)) return v.forEach(walk)
    if (typeof v === 'object') return Object.values(v).forEach(walk)
  }

  // Everywhere an image URL can hide. The snapshot columns matter most: they
  // are what keeps a receipt from August showing the right picture.
  // Table -> the columns that can hold an image reference. A column that does
  // not exist in this schema is skipped with a note; ANY other failure aborts,
  // because a failed query and "no references" look identical and the second
  // one would delete the bucket.
  const sources = [
    ['products', ['image']],
    ['sales', ['items']],
    ['whatsapp_orders', ['items']],
    ['bundles', ['items']],
    ['promos', ['items']],
    ['invoices', ['image']],
  ]
  const counts = []
  for (const [table, cols] of sources) {
    let got = null
    let used = null
    for (const col of cols) {
      try {
        got = await sb(`${table}?select=${col}`)
        used = col
        break
      } catch (e) {
        // PostgREST answers 400 for a column that is not there. Anything else
        // -- 401, 404, 5xx -- is a real problem and must not be swallowed.
        if (!/HTTP 400/.test(e.message)) {
          throw new Error(`reference scan failed on ${table}.${col}: ${e.message}`)
        }
      }
    }
    if (got === null) {
      counts.push(`${table}: no image column in this schema, skipped`)
      continue
    }
    const before = keys.size
    walk(got)
    counts.push(`${table}.${used}: ${got.length} row(s), +${keys.size - before} key(s)`)
  }
  return { keys, counts }
}

async function listBucket() {
  const r = await fetch(`${WORKER}/list?prefix=products/`, {
    headers: SECRET ? { 'X-Upload-Token': SECRET } : {},
  })
  if (!r.ok) throw new Error(`bucket list -> HTTP ${r.status}. The Worker needs the /list route (see r2/worker.js).`)
  return r.json()
}

async function main() {
  if (RESTORE_KEY) {
    console.log(`Restoring ${RESTORE_KEY} from quarantine`)
    const src = await fetch(`${WORKER}/img/quarantine/${RESTORE_KEY}`)
    if (!src.ok) { console.error(`  not in quarantine (HTTP ${src.status})`); process.exit(1) }
    const body = Buffer.from(await src.arrayBuffer())
    const put = await fetch(`${WORKER}/img/${RESTORE_KEY}`, {
      method: 'PUT',
      headers: { 'X-Upload-Token': SECRET, 'Content-Type': src.headers.get('content-type') || 'image/jpeg' },
      body,
    })
    console.log(put.ok ? '  restored' : `  restore failed: HTTP ${put.status}`)
    process.exit(put.ok ? 0 : 1)
  }

  console.log('Reading what the database references')
  const { keys, counts } = await referencedKeys()
  for (const c of counts) console.log(`  ${c}`)
  console.log(`  ${keys.size} distinct image(s) referenced`)

  // A reference scan that returns almost nothing is what a broken query looks
  // like, and acting on it would delete the entire bucket.
  if (keys.size < 50) {
    console.error(`\nREFUSING: only ${keys.size} references found. That is too few to be real;`)
    console.error('a failed query would look exactly like this. Nothing was touched.')
    process.exit(3)
  }

  console.log('\nListing the bucket')
  let objects
  try {
    objects = await listBucket()
  } catch (e) {
    console.error(`  ${e.message}`)
    console.error('  Report only; nothing was deleted.')
    process.exit(4)
  }
  console.log(`  ${objects.length} object(s) under products/`)

  const cutoff = Date.now() - RETENTION_DAYS * 86400_000
  const orphans = objects.filter(o => !keys.has(o.key) && new Date(o.uploaded).getTime() < cutoff)
  const tooNew = objects.filter(o => !keys.has(o.key) && new Date(o.uploaded).getTime() >= cutoff)
  const bytes = orphans.reduce((n, o) => n + (o.size || 0), 0)

  console.log('\nResult')
  console.log(`  referenced and kept      : ${objects.length - orphans.length - tooNew.length}`)
  console.log(`  unreferenced but recent  : ${tooNew.length}  (younger than ${RETENTION_DAYS} days, kept)`)
  console.log(`  unreferenced and old     : ${orphans.length}  (${(bytes / 1048576).toFixed(1)} MB)`)

  if (!orphans.length) { console.log('\nNothing to remove.'); return }
  for (const o of orphans.slice(0, 10)) console.log(`    ${o.key}  ${(o.size / 1024).toFixed(0)}K  ${o.uploaded}`)
  if (orphans.length > 10) console.log(`    … and ${orphans.length - 10} more`)

  if (!QUARANTINE) {
    console.log('\nReport only. Re-run with --quarantine to copy these aside and remove them.')
    return
  }

  console.log('\nQuarantining, then removing')
  let moved = 0, failed = 0
  for (const o of orphans) {
    try {
      const get = await fetch(`${WORKER}/img/${o.key}`)
      if (!get.ok) { failed++; continue }
      const buf = Buffer.from(await get.arrayBuffer())
      const sum = createHash('sha256').update(buf).digest('hex')

      const put = await fetch(`${WORKER}/img/quarantine/${o.key}`, {
        method: 'PUT',
        headers: { 'X-Upload-Token': SECRET, 'Content-Type': get.headers.get('content-type') || 'image/jpeg' },
        body: buf,
      })
      if (!put.ok) { failed++; continue }

      // Read the copy back and compare before removing the original.
      const back = await fetch(`${WORKER}/img/quarantine/${o.key}`)
      const backSum = createHash('sha256').update(Buffer.from(await back.arrayBuffer())).digest('hex')
      if (backSum !== sum) { console.log(`  copy mismatch, keeping ${o.key}`); failed++; continue }

      const del = await fetch(`${WORKER}/img/${o.key}`, { method: 'DELETE', headers: { 'X-Upload-Token': SECRET } })
      if (del.ok) moved++; else failed++
    } catch {
      failed++
    }
  }
  console.log(`  quarantined and removed: ${moved}`)
  console.log(`  left alone after a problem: ${failed}`)
  console.log(`\n  Restore any one with:  node r2/lifecycle.mjs --restore <key>`)
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1) })
