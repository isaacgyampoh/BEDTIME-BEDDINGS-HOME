#!/usr/bin/env node
/**
 * Cut a desktop release.   npm run release:desktop 1.0.1
 *
 * desktop/package.json is the single source of truth for the desktop version.
 * This bumps it, commits, tags v<version> and pushes — and CI refuses to
 * publish if the tag and that file ever disagree.
 */
import { readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: npm run release:desktop 1.0.1   (semver only)')
  process.exit(1)
}

const run = (cmd) => execSync(cmd, { stdio: 'pipe' }).toString().trim()

if (run('git status --porcelain')) {
  console.error('Working tree is not clean. Commit or stash first.')
  process.exit(1)
}
if (run('git rev-parse --abbrev-ref HEAD') !== 'main') {
  console.error('Releases are cut from main.')
  process.exit(1)
}

const path = 'desktop/package.json'
const pkg = JSON.parse(readFileSync(path, 'utf8'))
const previous = pkg.version
const cmp = (a, b) => {
  const A = a.split('.').map(Number), B = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] > B[i] ? 1 : -1
  return 0
}
if (cmp(version, previous) !== 1) {
  console.error(`${version} is not newer than the current ${previous}. An installed POS would never take it.`)
  process.exit(1)
}

pkg.version = version
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')

execSync(`git add ${path}`, { stdio: 'inherit' })
execSync(`git commit -m "Desktop release ${version}"`, { stdio: 'inherit' })
execSync(`git tag -a v${version} -m "BEDTIME POS ${version}"`, { stdio: 'inherit' })
execSync('git push origin main --follow-tags', { stdio: 'inherit' })

console.log(`\n  ${previous} -> ${version}`)
console.log('  Pushed. CI will run the checks and publish the installer if they pass.')
console.log('  https://github.com/isaacgyampoh/BEDTIME-BEDDINGS-HOME/actions\n')
