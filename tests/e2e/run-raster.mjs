import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..', '..')
const out = join(tmpdir(), `label-${process.pid}.cjs`)
await build({ entryPoints: [join(root, 'src/lib/deliveryLabel.js')], bundle: true, format: 'cjs', platform: 'node', outfile: out, logLevel: 'silent',
  define: { 'import.meta.env': '{}' } })
const electron = join(root, 'desktop/node_modules/.bin/electron' + (process.platform === 'win32' ? '.cmd' : ''))
const env = { ...process.env, LABEL_BUNDLE: out }; delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(electron, [join(here, 'raster.e2e.cjs')], { env, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(r.status ?? 1)
