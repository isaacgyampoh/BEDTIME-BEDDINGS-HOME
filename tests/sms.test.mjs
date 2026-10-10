import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { suite } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const t = suite('Daily SMS reports: recipient and rate limit agree')

// The scheduled reports (041: morning Tue–Sat, afternoon and evening Mon–Sat,
// weekly Sunday) call the sms-reports function, which sends to the number
// configured here. claim_sms (029) caps any number that is not exempt at 4
// messages per 10 minutes and 12 a day — so changing the recipient without
// exempting it reintroduces the exact failure 029 was written to stop: the
// owner silently stops being told.

const reports = readFileSync(join(root, 'supabase/functions/sms-reports/index.ts'), 'utf8')
const service = readFileSync(join(root, 'supabase/functions/super-service/index.ts'), 'utf8')
const migDir = join(root, 'supabase/migrations')
const sql = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(join(migDir, f), 'utf8')).join('\n')

const defaultRecipients = (src) => {
  const m = src.match(/ADMIN_SMS_PHONES'\)\s*\|\|\s*'([^']+)'/)
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : []
}
const last9 = (p) => p.replace(/\D/g, '').slice(-9)
const exempt = new Set(
  [...sql.matchAll(/INSERT INTO sms_exempt_numbers[\s\S]*?VALUES\s*\(\s*'(\d+)'/g)].map(m => m[1]))

const NEW = '0548124978'

t.eq('the scheduled reports go to the new number', defaultRecipients(reports), [NEW])
t.eq('so does the report endpoint on super-service', defaultRecipients(service), [NEW])
t.ok('it is a Ghanaian mobile number', /^0\d{9}$/.test(NEW))
t.ok('the recipient can be changed without a code change (env var)',
  /Deno\.env\.get\('ADMIN_SMS_PHONES'\)/.test(reports))

t.ok(`the new number is exempt from the SMS cap (${last9(NEW)})`, exempt.has(last9(NEW)),
  [...exempt].join(', ') || 'nothing is exempt')
t.ok('the old line stays exempt — it still gets the per-order alerts', exempt.has('599084552'))

// The provider wants 233XXXXXXXXX; the code converts, so the number is written
// the way it is dialled locally. Both must agree or every report 404s.
t.ok('the function converts 0XXXXXXXXX to 233XXXXXXXXX', /'233'\s*\+\s*clean\.slice\(1\)/.test(reports))
t.eq('which gives the right international form for this number',
  '233' + NEW.slice(1), '233548124978')

// The schedule itself must still exist and be unchanged by this work.
t.ok('the daily reports are still scheduled', /sms-morning[\s\S]*sms-afternoon[\s\S]*sms-evening/.test(sql))
t.ok('they still call the sms-reports function', /\/sms-reports\?type=morning/.test(sql))

// Customer-facing numbers must not have been touched.
t.ok('no customer number was replaced with the admin one',
  !/customer_phone[^\n]*0548124978/.test(service))
