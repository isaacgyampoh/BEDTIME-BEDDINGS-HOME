/**
 * Test runner —  npm test
 *
 * These suites previously lived in a scratch directory and were lost when it
 * was cleared, taking the regression safety net with them. They live in the
 * repo now and run in CI.
 */
import { readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { state } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
for (const f of readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()) {
  await import(join(here, f))
}

console.log(`\n${'─'.repeat(48)}`)
if (state.fail) {
  console.log(`\x1b[31m${state.fail} failed\x1b[0m, ${state.pass} passed\n`)
  state.failures.forEach(f => console.log(`  ${f}`))
  process.exit(1)
}
console.log(`\x1b[32m${state.pass} passed\x1b[0m, 0 failed`)
