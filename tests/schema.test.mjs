import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'supabase/migrations')
const t = suite('Schema and functions agree')

// Adding a staff member was impossible for weeks: staff.pin is NOT NULL from
// 001, 015 moved PINs to pin_hash and had admin_save_staff insert
// `pin = NULL`, and nothing dropped the constraint. The admin PIN check passed,
// then the insert failed, so the screen said "Save failed" and looked like a
// form bug. Nothing in the tests could see it, because the mismatch is between
// two SQL files.
//
// This reads every migration in order, works out the final shape of each
// table, then checks every INSERT written inside a function against it.

const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const sql = files.map(f => readFileSync(join(dir, f), 'utf8'))
              .map(s => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n'))
              .join('\n')

/** Split a comma list while respecting nesting and quotes. */
function splitTop(s) {
  const out = []; let depth = 0, cur = '', q = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { cur += c; if (c === q) q = null; continue }
    if (c === "'" || c === '"') { q = c; cur += c; continue }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** SERIAL and IDENTITY columns fill themselves in without a DEFAULT clause. */
const hasDefault = (def) => /\bDEFAULT\b/i.test(def) || /\b(BIG|SMALL)?SERIAL\b/i.test(def) || /\bGENERATED\b[\s\S]*\bIDENTITY\b/i.test(def)

// ── final column state ──────────────────────────────────────────────────────
const cols = {}   // table -> col -> { notNull, hasDefault }
for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const table = m[1]
  cols[table] = cols[table] || {}
  for (const line of splitTop(m[2])) {
    const cm = line.match(/^(\w+)\s+([A-Z][\w ()]*)/i)
    if (!cm) continue
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(cm[1])) continue
    cols[table][cm[1]] = { notNull: /\bNOT NULL\b/i.test(line) || /\bPRIMARY KEY\b/i.test(line), hasDefault: hasDefault(line) }
  }
}
for (const m of sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?(\w+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+(\w+)([^;]*);/gi)) {
  cols[m[1]] = cols[m[1]] || {}
  cols[m[1]][m[2]] = { notNull: /\bNOT NULL\b/i.test(m[3]), hasDefault: hasDefault(m[3]) }
}
for (const m of sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?(\w+)\s+ALTER COLUMN\s+(\w+)\s+(DROP|SET) NOT NULL/gi)) {
  if (cols[m[1]]?.[m[2]]) cols[m[1]][m[2]].notNull = /SET/i.test(m[3])
}

t.ok('the migrations describe tables', Object.keys(cols).length > 5, String(Object.keys(cols).length))
t.ok('staff.pin is nullable — pin_hash is the credential now', cols.staff?.pin?.notNull === false,
  'staff.pin is still NOT NULL, so admin_save_staff cannot insert a staff member')

// ── every INSERT ... VALUES in the migrations ───────────────────────────────
let checked = 0
const problems = []
for (const m of sql.matchAll(/INSERT INTO\s+(\w+)\s*\(([^)]*)\)\s*(?:\n|\s)*VALUES\s*\(([\s\S]*?)\)\s*(?:RETURNING|ON CONFLICT|;)/gi)) {
  const [table, colList, valList] = [m[1], m[2], m[3]]
  const schema = cols[table]; if (!schema) continue
  const names = splitTop(colList).map(c => c.trim())
  const values = splitTop(valList)
  if (names.length !== values.length) continue      // not a shape we can read
  checked++
  names.forEach((c, i) => {
    if (schema[c]?.notNull && /^NULL$/i.test(values[i].trim())) {
      problems.push(`${table}.${c} is NOT NULL but an INSERT writes NULL`)
    }
  })
  for (const [c, def] of Object.entries(schema)) {
    if (def.notNull && !def.hasDefault && !names.includes(c)) {
      problems.push(`${table}.${c} is NOT NULL with no default but an INSERT leaves it out`)
    }
  }
}
t.ok(`checked ${checked} INSERT statements`, checked >= 1)
t.eq('no INSERT writes NULL into a NOT NULL column', [...new Set(problems)], [])

// The other half of the same bug: verify_pin's upgrade path clears the
// plaintext PIN, which only works while the column is nullable.
t.ok('verify_pin may clear the plaintext PIN', cols.staff?.pin?.notNull === false)
