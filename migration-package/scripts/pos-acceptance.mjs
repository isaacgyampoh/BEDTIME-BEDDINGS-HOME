#!/usr/bin/env node
/**
 * PIN authentication and the critical POS operations, against a restored
 * database.
 *
 *   pos-acceptance.mjs bedtime_restored
 *
 * Every check exercises the real SQL functions the till calls. None of it
 * touches production: the database named on the command line is a disposable
 * restore, and this refuses anything that looks remote.
 *
 * PINs: a synthetic staff row is created for the authentication checks, so a
 * real staff member's PIN is never guessed and the live lockout is never
 * tripped. No PIN or hash value is printed — only whether a hash is present
 * and what shape it has.
 */
import { execFileSync } from 'node:child_process'

const DB = process.argv[2]
if (!DB) { console.error('usage: pos-acceptance.mjs <database>'); process.exit(2) }
if (/supabase|pooler|:\/\//.test(DB)) { console.error('refusing: that looks remote'); process.exit(2) }

const q = (sql) => execFileSync('psql', ['-At', '-d', DB, '-c', sql], { encoding: 'utf8' }).trim()
const qq = (sql) => { try { return q(sql) } catch (e) { return 'ERROR: ' + String(e.stderr || e).slice(0, 120) } }

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`) }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? '  ' + extra : ''}`) }
}
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

// ── PIN authentication ──────────────────────────────────────────────────────
head('PIN authentication')
// A synthetic row, so no real PIN is guessed and no real staff member is
// locked out. 'pa-test' is removed at the end.
q(`DELETE FROM staff WHERE id = 'pa-test'`)
q(`INSERT INTO staff (id, name, role, active, pin) VALUES ('pa-test','Acceptance Cashier','Cashier',true,'4729')`)

const nullable = q(`SELECT is_nullable FROM information_schema.columns WHERE table_name='staff' AND column_name='pin'`)
ok('staff.pin is nullable, so verify_pin can clear a plaintext PIN', nullable === 'YES',
   `is_nullable=${nullable} — migration 045 is missing`)

let r = qq(`SELECT verify_pin('4729')`)
ok('the correct PIN on an unhashed row signs in', /"success"\s*:\s*true/.test(r), r.slice(0, 90))
const afterPin  = q(`SELECT COALESCE(pin,'<null>') FROM staff WHERE id='pa-test'`)
const afterHash = q(`SELECT COALESCE(left(pin_hash,4),'<null>') FROM staff WHERE id='pa-test'`)
ok('the plaintext PIN is cleared on first use', afterPin === '<null>', `pin is ${afterPin === '<null>' ? 'null' : 'still set'}`)
ok('and replaced with a bcrypt hash', /^\$2[aby]$/.test(afterHash) || afterHash.startsWith('$2'), `prefix ${afterHash}`)
ok('the hash is 60 characters, as bcrypt is',
   q(`SELECT length(pin_hash) FROM staff WHERE id='pa-test'`) === '60')

r = qq(`SELECT verify_pin('4729')`)
ok('the same PIN verifies against the hash', /"success"\s*:\s*true/.test(r), r.slice(0, 90))
r = qq(`SELECT verify_pin('0000')`)
ok('a wrong PIN is refused', /"success"\s*:\s*false/.test(r), r.slice(0, 90))
ok('and leaks nothing about who exists', !/name|role|id/.test(r), r.slice(0, 90))
r = qq(`SELECT verify_pin('abcd')`)
ok('a non-numeric PIN is refused', /"success"\s*:\s*false/.test(r))
r = qq(`SELECT verify_pin('12')`)
ok('a short PIN is refused', /"success"\s*:\s*false/.test(r))

head('Lockout')
for (let i = 0; i < 10; i++) qq(`SELECT verify_pin('1111')`)
r = qq(`SELECT verify_pin('4729')`)
ok('after ten failures even a CORRECT PIN is refused', /Too many attempts/.test(r), r.slice(0, 100))
q(`DELETE FROM pin_attempts WHERE attempted_at > now() - interval '1 hour'`)
r = qq(`SELECT verify_pin('4729')`)
ok('and it works again once the attempts age out', /"success"\s*:\s*true/.test(r), r.slice(0, 90))

// ── products ────────────────────────────────────────────────────────────────
head('Products')
const prodCount = Number(q(`SELECT count(*) FROM products`))
ok('products are present', prodCount > 0, `${prodCount} rows`)
// The exact column list the till selects. PostgREST rejects the whole request
// if one is missing, which would read as an empty shop.
const sel = 'id,name,category,cost_price,price,wholesale_price,wholesale_min_qty,quantity,image,group_tag,description'
ok('every column the till selects exists',
   qq(`SELECT ${sel} FROM products LIMIT 1`).slice(0, 6) !== 'ERROR:',
   qq(`SELECT ${sel} FROM products LIMIT 1`).slice(0, 110))
ok('no product has negative stock', q(`SELECT count(*) FROM products WHERE quantity < 0`) === '0')
const noCost = q(`SELECT count(*) FROM products WHERE cost_price <= 0`)
ok('every product has a cost price, so profit is not resting on blanks', noCost === '0', `${noCost} without one`)

// ── a sale ──────────────────────────────────────────────────────────────────
head('A sale deducts stock and books the money')
const pid = q(`SELECT id FROM products WHERE quantity > 10 ORDER BY quantity DESC LIMIT 1`)
const price = q(`SELECT price FROM products WHERE id='${pid}'`)
const before = Number(q(`SELECT quantity FROM products WHERE id='${pid}'`))
const salesBefore = Number(q(`SELECT count(*) FROM sales`))
const lineTotal = Number(price) * 2
r = qq(`SELECT record_sale('[{"productId":"${pid}","qty":2,"lineTotal":${lineTotal}}]'::jsonb,'Walk-in','Cash',0,'Retail','Acceptance')`)
ok('the sale succeeds', /"success"\s*:\s*true/.test(r), r.slice(0, 120))
const after = Number(q(`SELECT quantity FROM products WHERE id='${pid}'`))
ok('stock is deducted by exactly the quantity sold', before - after === 2, `${before} -> ${after}`)
ok('a sale row is written', Number(q(`SELECT count(*) FROM sales`)) === salesBefore + 1)
ok('with a receipt number', /"receiptNo"\s*:\s*"RCP/.test(r))
ok('and the server-computed total', new RegExp(`"total"\\s*:\\s*${lineTotal.toFixed(2)}`).test(r), r.slice(0, 140))

head('A tampered price is refused')
const q2 = Number(q(`SELECT quantity FROM products WHERE id='${pid}'`))
r = qq(`SELECT record_sale('[{"productId":"${pid}","qty":2,"lineTotal":${lineTotal / 2}}]'::jsonb,'Walk-in','Cash',0,'Retail','Acceptance')`)
ok('half the real price is rejected', /"success"\s*:\s*false/.test(r), r.slice(0, 110))
ok('and no stock moved', Number(q(`SELECT quantity FROM products WHERE id='${pid}'`)) === q2)

head('Overselling is refused')
r = qq(`SELECT record_sale('[{"productId":"${pid}","qty":999999,"lineTotal":${Number(price) * 999999}}]'::jsonb,'Walk-in','Cash',0,'Retail','Acceptance')`)
ok('more units than exist is rejected', /"success"\s*:\s*false/.test(r) && /Not enough stock/.test(r), r.slice(0, 120))
ok('stock never goes negative', Number(q(`SELECT quantity FROM products WHERE id='${pid}'`)) >= 0)

// ── order stock, twice ──────────────────────────────────────────────────────
head('Order stock cannot be deducted twice')
q(`DELETE FROM whatsapp_orders WHERE id='pa-order'`)
q(`INSERT INTO whatsapp_orders (id,order_no,date,customer_name,customer_phone,items,subtotal,total,status,source,stock_deducted)
   VALUES ('pa-order','PA-1',now(),'Acceptance','0548124978','[{"productId":"${pid}","qty":1,"price":${price}}]'::jsonb,${price},${price},'Paid','web',false)`)
const q3 = Number(q(`SELECT quantity FROM products WHERE id='${pid}'`))
r = qq(`SELECT deduct_order_stock('pa-order')`)
ok('the first deduction succeeds', /"success"\s*:\s*true/.test(r), r.slice(0, 100))
const q4 = Number(q(`SELECT quantity FROM products WHERE id='${pid}'`))
ok('one unit came off', q3 - q4 === 1, `${q3} -> ${q4}`)
r = qq(`SELECT deduct_order_stock('pa-order')`)
ok('the second call deducts nothing', /already deducted/.test(r), r.slice(0, 100))
ok('and stock is unchanged', Number(q(`SELECT quantity FROM products WHERE id='${pid}'`)) === q4)

// ── two cashiers at once ────────────────────────────────────────────────────
head('Two cashiers cannot oversell the last units')
q(`UPDATE products SET quantity = 3 WHERE id='${pid}'`)
const sql = `SELECT record_sale('[{"productId":"${pid}","qty":2,"lineTotal":${lineTotal}}]'::jsonb,'Walk-in','Cash',0,'Retail','Cashier')`
const both = execFileSync('bash', ['-c',
  `psql -At -d ${DB} -c ${JSON.stringify(sql)} > /tmp/pa-c1.txt 2>&1 & ` +
  `psql -At -d ${DB} -c ${JSON.stringify(sql)} > /tmp/pa-c2.txt 2>&1 & wait; ` +
  `cat /tmp/pa-c1.txt /tmp/pa-c2.txt`], { encoding: 'utf8' })
const successes = (both.match(/"success"\s*:\s*true/g) || []).length
const refusals = (both.match(/Not enough stock/g) || []).length
ok('exactly one of the two sales went through', successes === 1, `${successes} succeeded`)
ok('the other was told the stock is short', refusals === 1, `${refusals} refused`)
const finalQ = Number(q(`SELECT quantity FROM products WHERE id='${pid}'`))
ok('3 units minus one 2-unit sale leaves 1', finalQ === 1, `${finalQ} left`)
ok('and it never went negative', finalQ >= 0)

// ── customers ───────────────────────────────────────────────────────────────
head('Customers')
ok('customers are present', Number(q(`SELECT count(*) FROM customers`)) > 0)
const dup = q(`SELECT count(*) FROM (SELECT phone FROM customers GROUP BY 1 HAVING count(*) > 1) x`)
ok('no two customer rows share a phone string', dup === '0', `${dup} duplicated`)

// ── tidy up ─────────────────────────────────────────────────────────────────
q(`DELETE FROM staff WHERE id='pa-test'`)
q(`DELETE FROM whatsapp_orders WHERE id='pa-order'`)
q(`DELETE FROM sales WHERE cashier IN ('Acceptance','Cashier')`)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) console.log('Acceptance FAILED — do not treat this restore as verified.')
process.exit(fail ? 1 : 0)
