import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const t = suite('Desktop bundle: relative asset paths')

// The installed Windows app loads index.html from disk with loadFile, so the
// page origin is file://. Vite's default base emits <script src="/assets/...">,
// and an absolute path there means the drive root — C:\assets\... — which does
// not exist. Every script and stylesheet 404s, React never mounts, and the
// window is white with nothing on screen and no error a shop could act on.
// That is exactly what the first install did.
//
// Reproduced and fixed against real Electron: with relative paths the PIN pad
// renders. These guard the wiring that produces them.

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const wf = readFileSync(join(root, '.github/workflows/desktop-build.yml'), 'utf8')

t.ok('a desktop build target exists', typeof pkg.scripts['build:desktop'] === 'string')
t.ok('it sets a relative base', /--base[= ]\.\//.test(pkg.scripts['build:desktop'] || ''))
t.ok('the web build does NOT, so deep links keep working',
  !/--base/.test(pkg.scripts.build || ''))

// Anything that packages or launches the desktop app must use it.
for (const s of ['desktop', 'desktop:win']) {
  t.ok(`"${s}" builds with build:desktop`, /build:desktop/.test(pkg.scripts[s] || ''), pkg.scripts[s])
}

t.ok('the release workflow builds with build:desktop', /npm run build:desktop/.test(wf))
t.ok('the release workflow refuses a bundle with absolute paths',
  /absolute asset paths|absolute paths/i.test(wf) && /exit 1/.test(wf))

// The service worker must not be registered from file://: registration throws
// there, and a worker caching the bundle would keep serving the old assets
// after an update installed.
const html = readFileSync(join(root, 'index.html'), 'utf8')
t.ok('the service worker is skipped on file://',
  /serviceWorker' in navigator && location\.protocol !== 'file:'/.test(html))
