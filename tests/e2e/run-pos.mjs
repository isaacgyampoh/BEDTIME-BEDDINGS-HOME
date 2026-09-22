// Runs the cashier flow in Chrome mode and desktop mode. Starts Vite if needed.
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..', '..')
const DEV = 'http://localhost:5173'
const up = async () => { try { return (await fetch(DEV)).ok } catch { return false } }
let vite = null
if (!(await up())) {
  vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: root, stdio: 'ignore', shell: process.platform === 'win32' })
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise(r => setTimeout(r, 500))
}
const electron = join(root, 'desktop/node_modules/.bin/electron' + (process.platform === 'win32' ? '.cmd' : ''))
let status = 0
for (const mode of (process.argv[2] ? [process.argv[2]] : ['chrome', 'desktop'])) {
  console.log(`\n══ ${mode} ══`)
  const env = { ...process.env, MODE: mode, POS_DEV_URL: DEV }; delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(electron, [join(here, 'pos.e2e.cjs')], { env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) status = 1
}
if (vite) vite.kill()
process.exit(status)
