#!/usr/bin/env node
/**
 * Give the service worker a new identity on every build.
 *
 * WHY THIS EXISTS
 *
 * A browser installs a new service worker only when sw.js changes BYTE FOR
 * BYTE. CACHE_NAME was the fixed string 'bedtime-pos-v3', so sw.js was
 * identical after every deploy, no new worker was ever installed, and the
 * old one kept serving its old cache. The fetch handler is network-first, so
 * this stayed invisible on a good connection -- but one failed fetch on
 * mobile data falls back to the cached index.html, which names the OLD bundle
 * hash, which is also cached. From then on an installed PWA is pinned to that
 * build until someone clears the site data.
 *
 * That is exactly what happened: the browser showed the fixed build while the
 * installed PWA kept running a pre-fix one.
 *
 * Stamping the hash of the built assets into CACHE_NAME means sw.js differs
 * whenever the app differs, the browser installs it, and the activate handler
 * -- which already deletes every cache whose name is not the current one --
 * clears the stale build out.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dist = process.argv[2] || 'dist'
const swPath = join(dist, 'sw.js')
if (!existsSync(swPath)) {
  console.log(`  stamp-sw: no ${swPath}, nothing to do`)
  process.exit(0)
}

const assetsDir = join(dist, 'assets')
const names = existsSync(assetsDir) ? readdirSync(assetsDir).sort() : []
// Asset filenames carry Vite's content hashes, so the list changes whenever
// any bundle does. index.html is NOT an asset and has no hash in its name, so
// its contents go in too -- otherwise a change to the shell alone (the
// registration logic, for instance) would leave CACHE_NAME identical and no
// new worker would be installed. That is the exact failure this file exists
// to prevent, so it must not be reintroduced one level up.
const shell = existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : ''
const build = createHash('sha256').update(names.join('|') + shell).digest('hex').slice(0, 12)

const src = readFileSync(swPath, 'utf8')
const stamped = src.replace(
  /const CACHE_NAME = '[^']*'/,
  `const CACHE_NAME = 'bedtime-pos-${build}'`,
)
if (stamped === src) {
  console.error('  stamp-sw: CACHE_NAME not found — refusing to ship an unstamped worker')
  process.exit(1)
}
writeFileSync(swPath, stamped)
console.log(`  stamp-sw: CACHE_NAME = bedtime-pos-${build}`)
