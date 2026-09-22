import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const t = suite('Desktop package: every local module ships')

// desktop/package.json "build.files" is an allowlist. A file main.js requires
// but the list leaves out is simply absent from the installer, and the
// packaged app dies on launch — while `npm start` in development works fine,
// because there the file is on disk. That is the same shape of failure as the
// blank white window: fine on the developer's machine, broken on the till.
const pkg = JSON.parse(readFileSync(join(root, 'desktop/package.json'), 'utf8'))
const files = pkg.build.files
const local = (src) => [...src.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)].map(m => m[1].endsWith('.js') ? m[1] : m[1] + '.js')

const seen = new Set()
const walk = (f) => {
  if (seen.has(f)) return; seen.add(f)
  const p = join(root, 'desktop', f)
  t.ok(`${f} exists`, existsSync(p))
  if (existsSync(p)) local(readFileSync(p, 'utf8')).forEach(walk)
}
walk(pkg.main || 'main.js')
walk('preload.js')
for (const f of seen) t.ok(`${f} is in build.files`, files.includes(f), JSON.stringify(files))

// And the serial code must not have crept back into main.js, where it cannot
// be exercised by tests/e2e/serial.e2e.cjs.
const main = readFileSync(join(root, 'desktop/main.js'), 'utf8')
t.ok('main.js does not load serialport itself', !/require\(['"]serialport['"]\)/.test(main))
