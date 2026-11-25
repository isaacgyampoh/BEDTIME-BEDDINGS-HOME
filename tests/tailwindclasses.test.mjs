import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { suite } from './harness.mjs'

const t = suite('Every numeric spacing class used in the markup actually exists')

/**
 * `h-13` was used 38 times across 12 files -- every text input on Products,
 * Receipts, Customers, Expenses, Staff, Invoices, Bundles, Refunds, the
 * delivery pages and the CHECKOUT drawer -- and it is not a Tailwind default:
 * the spacing scale jumps straight from 12 to 14. So it generated no CSS, and
 * every one of those inputs silently collapsed to its content height.
 * Measured on the shop's phone: 366x28, against the 44px a finger needs.
 *
 * Nothing failed. No build warning, no console error, no test. The only
 * symptom was inputs that looked a bit thin, on a screen nobody measures.
 * This test is the thing that would have caught it.
 */

// Tailwind's default spacing scale (v3). Anything outside it must be declared
// in tailwind.config.js under theme.extend.spacing.
const DEFAULT_SPACING = new Set([
  '0', 'px', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7',
  '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40',
  '44', '48', '52', '56', '60', '64', '72', '80', '96',
])

const root = new URL('..', import.meta.url).pathname

function declaredSpacing() {
  const cfg = readFileSync(join(root, 'tailwind.config.js'), 'utf8')
  const block = cfg.match(/spacing:\s*\{([^}]*)\}/)
  if (!block) return new Set()
  return new Set([...block[1].matchAll(/(?:'([^']+)'|"([^"]+)"|(\d+(?:\.\d+)?))\s*:/g)]
    .map(m => m[1] || m[2] || m[3]))
}

function jsxFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...jsxFiles(p))
    else if (/\.jsx?$/.test(name)) out.push(p)
  }
  return out
}

const allowed = new Set([...DEFAULT_SPACING, ...declaredSpacing()])
const PREFIXES = 'w|h|p|pt|pb|pl|pr|px|py|m|mt|mb|ml|mr|mx|my|gap|gap-x|gap-y|space-x|space-y|top|bottom|left|right|inset'
const RE = new RegExp(`(?:^|[\\s"'\`])(?:(?:sm|md|lg|xl|2xl|hover|focus|active|disabled|group-hover|dark):)*(${PREFIXES})-(\\d+(?:\\.\\d+)?)(?=[\\s"'\`]|$)`, 'g')

const missing = new Map()
for (const file of jsxFiles(join(root, 'src'))) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(RE)) {
    const [, prefix, value] = m
    if (allowed.has(value)) continue
    const key = `${prefix}-${value}`
    if (!missing.has(key)) missing.set(key, new Set())
    missing.get(key).add(file.replace(root, ''))
  }
}

const report = [...missing.entries()]
  .map(([cls, files]) => `${cls} (in ${[...files].slice(0, 3).join(', ')}${files.size > 3 ? ` +${files.size - 3} more` : ''})`)
  .join('; ')

t.ok(
  missing.size === 0
    ? 'no undefined spacing classes'
    : `UNDEFINED spacing classes generate no CSS: ${report}`,
  missing.size === 0,
)

// Pin the specific one that bit us, so removing it from the config fails here
// rather than on a cashier's screen.
t.ok('h-13 is declared, because 38 inputs depend on it', allowed.has('13'))
