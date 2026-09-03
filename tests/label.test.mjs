import { suite } from './harness.mjs'
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const t = suite('Delivery label')

// Bundle the real module so the test exercises shipped code, not a copy.
// Uses esbuild's JS API rather than shelling out: the CLI form needed shell
// quoting that cmd.exe does not honour, so this suite passed on macOS and
// failed the Windows release build.
const dir = mkdtempSync(join(tmpdir(), 'lbl-'))
const out = join(dir, 'label.mjs')
await build({
  entryPoints: ['src/lib/deliveryLabel.js'],
  bundle: true, format: 'esm', platform: 'browser',
  define: { 'import.meta.env': '{}' },
  outfile: out, logLevel: 'silent',
})
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
// A Windows absolute path is not a valid ESM specifier without the file:// URL.
const L = await import(pathToFileURL(out).href)

// ── Code 128: decode our own output back, which is the only way to know it
//    actually scans. The label used to draw '|'.repeat(40) — forty identical
//    pipes that scan as nothing.
const TABLE = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112']
function decode(widths) {
  const s = widths.join(''); const syms = []
  for (let i = 0; i < s.length;) { const take = (s.length - i === 7) ? 7 : 6; syms.push(s.slice(i, i + take)); i += take }
  const codes = syms.map(p => TABLE.indexOf(p))
  if (codes.some(c => c < 0)) return { error: true }
  const data = codes.slice(1, -2)
  let sum = codes[0]; data.forEach((c, i) => sum += c * (i + 1))
  return { start: codes[0], stop: codes.at(-1), checkOk: (sum % 103) === codes.at(-2),
           text: data.map(c => String.fromCharCode(c + 32)).join('') }
}

for (const s of ['WEB-MTL6T98Y', 'TRK-50019', 'POS-MSYK4YSL', '1234567890', 'A']) {
  const d = decode(L.code128Widths(s))
  t.eq(`"${s}" decodes back to itself`, d.text, s)
  t.ok(`  "${s}" checksum valid`, d.checkOk === true)
  t.ok(`  "${s}" start B / stop`, d.start === 104 && d.stop === 106)
}
t.eq('empty input yields no bars', L.code128Widths('').length, 0)
t.eq('non-ASCII stripped but still valid', decode(L.code128Widths('ABCé')).text, 'ABC')
t.eq('empty text yields no svg', L.barcodeSVG(''), '')
t.ok('svg is pure black', !/fill="(?!#000)/.test(L.barcodeSVG('X1')))

// ── Label content
const shop = { name: 'BEDTIME BEDDINGS & HOME', phone: '059 908 4552' }
const order = { orderNo: 'WEB-ABC123', trackingNo: 'TRK-9001', customerName: 'ama mensah',
  customerPhone: '0244000000', address: '12 Palm St, Adenta', total: 250,
  date: '2026-09-03T10:00:00Z',
  items: [{ name: 'Chopping board', qty: 2 }, { name: 'Bed & Bath "deluxe" <set>', qty: 1 }] }

const cod = L.deliveryLabelHTML({ ...order, status: 'Pending' }, { deliverUrl: 'https://x/#/deliver/1', shop })
t.ok('unpaid says COLLECT ON DELIVERY', cod.includes('COLLECT ON DELIVERY'))
t.ok('unpaid shows the amount', cod.includes('GHS 250.00'))
t.ok('recipient upper-cased', cod.includes('AMA MENSAH'))
t.ok('address printed', cod.includes('12 Palm St, Adenta'))
t.ok('contents listed', cod.includes('Chopping board') && cod.includes('2x'))
t.ok('item count correct', cod.includes('3 item(s)'))
t.ok('link printed as a fallback', cod.includes('https://x/#/deliver/1'))
t.ok('real barcode embedded', (cod.match(/<rect/g) || []).length > 20)

// A product name is free text and must not be able to break the label.
t.ok('customer data escaped', cod.includes('&amp;') && cod.includes('&lt;set&gt;'))
t.ok('no raw markup leaks through', !cod.includes('<set>'))

const paid = L.deliveryLabelHTML({ ...order, status: 'Paid' }, { shop })
t.ok('paid says PAID IN FULL', paid.includes('PAID IN FULL'))
t.ok('paid says do not collect', paid.includes('Do not collect payment'))
t.ok('paid never says collect on delivery', !paid.includes('COLLECT ON DELIVERY'))

// ── Thermal safety: a 1-bit head cannot print grey, and a solid black banner
//    is a very large burn area.
const colours = [...cod.matchAll(/#[0-9a-fA-F]{3,6}/g)].map(m => m[0].toLowerCase())
t.ok('pure black and white only', colours.every(c => ['#000', '#fff', '#000000', '#ffffff'].includes(c)),
  [...new Set(colours)].join(' '))
t.ok('no solid background fills', !/background:\s*#000/.test(cod))
t.ok('no opacity washes', !/opacity:\s*0?\.\d/.test(cod))
t.ok('no fake pipe barcode', !cod.includes('||||'))
t.ok('feeds past the cutter', cod.includes('class="feed"'))

const narrow = L.deliveryLabelHTML(order, { paper: '58', shop })
t.ok('58mm retargets the page', narrow.includes('size:58mm auto'))
t.ok('58mm narrows the body', narrow.includes('width:48mm'))
