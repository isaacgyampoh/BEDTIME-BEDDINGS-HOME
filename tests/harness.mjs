/** Assertions + tally. Kept separate from run.mjs so suites can import it
 *  without creating a cycle back into the runner. */
export const state = { pass: 0, fail: 0, failures: [] }

export function suite(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`)
  const api = {
    ok(label, cond, extra = '') {
      if (cond) { state.pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`) }
      else { state.fail++; state.failures.push(`${name} → ${label} ${extra}`); console.log(`  \x1b[31m✗ ${label}\x1b[0m ${extra}`) }
      return api
    },
    eq(label, actual, expected) {
      return api.ok(label,
        Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
  }
  return api
}
