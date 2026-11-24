import { suite } from './harness.mjs'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const t = suite('Nothing requests a paid image transformation unless asked to')

/**
 * Supabase's image-transform endpoint is billable per ORIGIN IMAGE per month.
 * Both web apps were gated on 27 October 2026, when the feature was returning
 * 403 FeatureNotEnabled. It works again now: re-verified 24 November 2026
 * against nine real product images, every one 200 with an x-transformations
 * header at 41% of the original bytes. So an ungated path spends money rather
 * than merely breaking, which is why the gates stay.
 *
 * The third offender used to be the WhatsApp agent, which transformed every
 * photo it sent and had no visible blank image to give it away. That agent
 * was retired on 24 November 2026 and its deployment deleted, so the only
 * paths left to guard are the two web apps.
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
// The retired agent must not come back. Nothing under supabase/functions may
// reach OpenAI or WaSender again, and no source file may reference the agent's
// own tables -- a reintroduction would otherwise be silent.
{
  const banned = /api\.openai\.com|wasenderapi\.com|OPENAI_API_KEY|WASENDER_API_KEY/
  const back = files.filter(f => banned.test(readFileSync(f, 'utf8')))
  t.eq('no OpenAI or WaSender integration has returned', back.join(', '), '')
}

// thumb() with the flag off must hand back exactly what it was given.
{
  const { thumb } = await import('../src/lib/utils.js')
  const orig = 'https://x.supabase.co/storage/v1/object/public/product-images/products/1.jpg'
  t.eq('the admin serves the original photo', thumb(orig, 600), orig)
  t.eq('whatever width is asked for', thumb(orig, 1600), orig)
  t.eq('and an empty url stays empty', thumb('', 600), '')
}
