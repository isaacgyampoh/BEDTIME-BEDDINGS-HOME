import { suite } from './harness.mjs'
const t = suite('Printer status: reading why nothing came out')

// A thermal head that is out of paper, or whose cover is not latched, accepts
// everything sent to it, bins it, and says nothing — so the app reported a
// successful print while no paper moved. That is what a till looks like after
// a roll runs out mid-sale.
//
// ESC/POS real-time status answers even while the printer is offline. The
// catch: the same bit means different things depending which query it answers.
// Bit 2 is "cover open" in the offline-cause reply (DLE EOT 2) and
// "drawer kick-out" in the printer-status reply (DLE EOT 1) — so reading bits
// off whatever comes back reports a healthy printer as having its cover open.
// Each reply is decoded against its own query. Mirrors desktop/main.js.
const QUERIES = {
  2: [[0x04, 'The cover is open, or not clicked fully shut.'],
      [0x20, 'Printing stopped because it is out of paper.'],
      [0x40, 'The printer reports an error — usually a jam or the cutter.']],
  4: [[0x60, 'Out of paper.']],
}
const isStatusByte = (b) => (b & 0x10) === 0x10 && (b & 0x01) === 0 && (b & 0x80) === 0
const read = (replies) => {              // replies: { queryNumber: byte|null }
  const faults = []; let answered = 0
  for (const n of Object.keys(QUERIES)) {
    const b = replies[n]
    if (b == null || !isStatusByte(b)) continue
    answered++
    for (const [mask, msg] of QUERIES[n]) if ((b & mask) === mask && !faults.includes(msg)) faults.push(msg)
  }
  return answered ? { supported: true, faults, ready: faults.length === 0 } : { supported: false }
}

// 0x12 is the resting reply: bits 1 and 4 are fixed high on every status byte.
t.ok('a healthy printer reports ready', read({ 2: 0x12, 4: 0x12 }).ready)
t.eq('a healthy printer lists no faults', read({ 2: 0x12, 4: 0x12 }).faults.length, 0)

// The regression this file exists for: the drawer-kick bit must not be read as
// a cover fault. 0x16 answering a DIFFERENT query must not leak across.
t.eq('a drawer-kick bit on query 1 is ignored entirely', read({ 1: 0x16 }).supported, false)

// Out of paper — the case that started this.
t.ok('paper end on the sensor query is detected', read({ 2: 0x12, 4: 0x72 }).faults.includes('Out of paper.'))
t.ok('paper end is not ready', !read({ 2: 0x12, 4: 0x72 }).ready)
t.ok('one paper bit alone is not enough', read({ 4: 0x32 }).ready)

// Cover not latched — the other thing a roll change causes.
t.ok('cover open is detected', read({ 2: 0x16, 4: 0x12 }).faults.some(f => f.startsWith('The cover is open')))
t.ok('a jam is reported', read({ 2: 0x52 }).faults.some(f => f.includes('jam')))

// Both at once, which is what an open cover over an empty roll returns.
const both = read({ 2: 0x36, 4: 0x72 })
t.ok('both faults are listed', both.faults.length >= 2)
t.ok('no fault is listed twice', new Set(both.faults).size === both.faults.length)

// Never invent a fault. Telling a shop it is out of paper when the roll is
// full sends someone hunting for something that is not there.
t.eq('silence means cannot tell', read({}).supported, false)
t.eq('a partial answer still counts', read({ 2: null, 4: 0x12 }).supported, true)
t.eq('bit0 set is not a status byte', read({ 2: 0x13 }).supported, false)
t.eq('bit7 set is not a status byte', read({ 2: 0x92 }).supported, false)
t.eq('no bit4 is not a status byte', read({ 2: 0x02 }).supported, false)
t.eq('an ASCII echo is not a status byte', read({ 2: 0x4f }).supported, false)
