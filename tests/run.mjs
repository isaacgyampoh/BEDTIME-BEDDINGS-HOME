/**
 * Test runner —  npm test
 *
 * These suites previously lived in a scratch directory and were lost when it
 * was cleared, taking the regression safety net with them. They live in the
 * repo now and run in CI.
 */
import { readdirSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { state } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()

// A machine-specific absolute path in an import passes locally and fails
// everywhere else. Catch it here rather than three minutes into a Windows
// release build.
import { readFileSync } from 'fs'
const portability = files.flatMap(f => {
  const src = readFileSync(join(here, f), 'utf8')
  return [...src.matchAll(/from\s+['"](\/(?:Users|home)\/[^'"]+)['"]/g)]
    .map(m => `${f} imports an absolute path: ${m[1]}`)
})
if (portability.length) {
  console.log('\n\x1b[31mNot portable:\x1b[0m')
  portability.forEach(p => console.log('  ' + p))
  process.exit(1)
}

for (const f of files) {
  // Must be a file:// URL. A Windows absolute path (C:\...) is not a valid ESM
  // specifier, so importing one throws ERR_UNSUPPORTED_ESM_URL_SCHEME — which
  // is why every suite passed on macOS and none ran on windows-latest.
  await import(pathToFileURL(join(here, f)).href)
}

console.log(`\n${'─'.repeat(48)}`)
if (state.fail) {
  console.log(`\x1b[31m${state.fail} failed\x1b[0m, ${state.pass} passed\n`)
  state.failures.forEach(f => console.log(`  ${f}`))
  process.exit(1)
}
console.log(`\x1b[32m${state.pass} passed\x1b[0m, 0 failed`)
