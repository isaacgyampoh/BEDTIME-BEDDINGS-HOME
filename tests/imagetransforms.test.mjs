import { suite } from './harness.mjs'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const t = suite('Nothing requests a paid image transformation unless asked to')

/**
 * Supabase's image-transform endpoint is billable per origin transformation
 * and the organisation is over its allowance. Both web apps were gated on
 * 27 October 2026 when the feature started returning 403 FeatureNotEnabled —
 * but wa-agent was missed, because an Edge Function has no visible blank
 * image to notice. It kept rewriting every product photo it sent a customer.
 *
 * The feature is enabled again (a request returns 200 with an
 * x-transformations header), so an ungated path now spends money rather than
 * merely breaking. This test fails if any source file reaches that endpoint
 * without a flag in the way, which is the only form of this that lasts: the
 * previous fix was correct and incomplete, and nothing would have told us.
 */
const ROOTS = ['src', 'storefront/src', 'supabase/functions']
const SKIP = new Set(['node_modules', 'dist', '.git'])
const GATES = ['TRANSFORMS_ON', 'WA_TRANSFORMS_ON', 'VITE_IMAGE_TRANSFORMS', 'WA_IMAGE_TRANSFORMS']

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|jsx|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = ROOTS.flatMap(r => { try { return walk(r) } catch { return [] } })
t.ok('there are source files to check', files.length > 20)

const offenders = []
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // The string that builds a transform URL. A comment mentioning the
    // endpoint is not a request to it.
    if (!line.includes("'/render/image/public/'") && !line.includes('"/render/image/public/"')) return
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return

    // Walk back to the start of the enclosing function and require an actual
    // early return guarded by a flag inside it. Looking merely for the flag
    // NAME nearby is not enough: the const that declares it sits a few lines
    // above, so deleting the guard left this test passing. Found by deleting
    // the guard and watching the test not care.
    let start = 0
    for (let j = i; j >= 0; j--) {
      if (/\bfunction\s|=>\s*\{|^export (const|function)/.test(lines[j])) { start = j; break }
    }
    const body = lines.slice(start, i + 1)
    const guarded = body.some(l =>
      GATES.some(g => new RegExp(`if\\s*\\(\\s*!\\s*${g}\\s*\\)`).test(l)))
    if (!guarded) offenders.push(`${f}:${i + 1}`)
  })
}
t.eq('every transform URL is behind a flag', offenders.join(', '), '')

// And the flags are off unless deliberately set, so a fresh deploy costs
// nothing.
t.ok('the admin flag defaults off',
  /TRANSFORMS_ON\s*=\s*String\(import\.meta\.env\?\.VITE_IMAGE_TRANSFORMS \|\| ''\) === 'on'/
    .test(readFileSync('src/lib/utils.js', 'utf8')))
t.ok('the shop front flag defaults off',
  /TRANSFORMS_ON\s*=\s*String\(import\.meta\.env\?\.VITE_IMAGE_TRANSFORMS \|\| ''\) === 'on'/
    .test(readFileSync('storefront/src/lib/utils.js', 'utf8')))
t.ok('the WhatsApp agent flag defaults off',
  /WA_TRANSFORMS_ON\s*=\s*\(Deno\.env\.get\('WA_IMAGE_TRANSFORMS'\) \|\| ''\) === 'on'/
    .test(readFileSync('supabase/functions/wa-agent/index.ts', 'utf8')))

// thumb() with the flag off must hand back exactly what it was given.
{
  const { thumb } = await import('../src/lib/utils.js')
  const orig = 'https://x.supabase.co/storage/v1/object/public/product-images/products/1.jpg'
  t.eq('the admin serves the original photo', thumb(orig, 600), orig)
  t.eq('whatever width is asked for', thumb(orig, 1600), orig)
  t.eq('and an empty url stays empty', thumb('', 600), '')
}
