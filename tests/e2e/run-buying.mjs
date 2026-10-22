// Runs the shop front's promotion scenarios in a real browser.
// Starts the storefront's Vite server if it is not already up.
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..', '..')
const shop = join(root, 'storefront')
const DEV = 'http://localhost:5174'
const up = async () => { try { return (await fetch(DEV)).ok } catch { return false } }
let vite = null
if (!(await up())) {
  vite = spawn('npx', ['vite', '--port', '5174', '--strictPort'], { cwd: shop, stdio: 'ignore', shell: process.platform === 'win32' })
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise(r => setTimeout(r, 500))
}
const electron = join(root, 'desktop/node_modules/.bin/electron' + (process.platform === 'win32' ? '.cmd' : ''))
const env = { ...process.env, SHOP_DEV_URL: DEV }; delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(electron, [join(here, 'buying.e2e.cjs')], { env, stdio: 'inherit', shell: process.platform === 'win32' })
if (vite) vite.kill()
process.exit(r.status ?? 1)
