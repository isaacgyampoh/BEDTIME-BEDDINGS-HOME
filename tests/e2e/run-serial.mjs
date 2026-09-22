// Bundles the app's ESC/POS builder to CJS, then runs the serial e2e in Electron.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(tmpdir(), `escpos-${process.pid}.cjs`)
await build({ entryPoints: [join(root, 'src/lib/escpos.js')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent' })

const electron = join(root, 'desktop/node_modules/.bin/electron' + (process.platform === 'win32' ? '.cmd' : ''))
const env = { ...process.env, ESCPOS_BUNDLE: out }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(electron, [join(here, 'serial.e2e.cjs')], { env, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(r.status ?? 1)
