import { suite } from './harness.mjs'
import { dueReminder, isChaseable, reminderMessage, stepsFrom, alreadySent, DEFAULT_STEPS }
  from '../supabase/functions/_shared/reminders.js'
const t = suite('Online shop: chasing an unpaid order')

const T0 = Date.parse('2026-11-01T10:00:00Z')
const at = (mins) => T0 + mins * 60000
const order = (over = {}) => ({
  id: 'o1', order_no: 'WEB-ABC123', customer_name: 'Ama Mensah', customer_phone: '0548124978',
  total: 450, status: 'Pending', date: new Date(T0).toISOString(), notes: '', ussd_code: '*713*123#', ...over,
})

// ── the bug: hourly job, minute-wide windows ───────────────────────────────
// The job runs at minute 15 of every hour while the tiers were ranges like
// "5 to 25 minutes". Whether a customer heard anything depended on where in
// the hour they checked out: no one ever received all four, and a quarter of
// checkout times heard nothing for over an hour.
{
  // An order checked out at :20 was previously skipped at every run until the
  // 60-120 window. A threshold catches it the first time the job looks.
  const o = order()
  const first = dueReminder(o, at(55), DEFAULT_STEPS)
  t.ok('an order the old windows skipped is now due', !!first)
  t.eq('and gets the furthest-along reminder it has earned', first.tag, 'R2')
  t.eq('with the ones it missed marked rather than sent', first.superseded.join(','), 'R1')
}

// ── a threshold, evaluated whenever the job happens to run ─────────────────
{
  t.ok('nothing is due in the first minutes', !dueReminder(order(), at(2)))
  t.eq('five minutes in, the first nudge', dueReminder(order(), at(6)).tag, 'R1')
  t.eq('twenty minutes in', dueReminder(order(), at(21)).tag, 'R2')
  t.eq('an hour in', dueReminder(order(), at(61)).tag, 'R3')
  t.eq('a day in, the last one', dueReminder(order(), at(1441)).tag, 'R4')
  t.ok('and it knows it is the last', dueReminder(order(), at(1441)).isFinal)
  t.ok('an earlier one is not final', !dueReminder(order(), at(6)).isFinal)
}

// ── never the same reminder twice ─────────────────────────────────────────
{
  const sent1 = order({ notes: 'DELIVERY | [R1]' })
  t.ok('a sent reminder is not repeated', !dueReminder(sent1, at(10)))
  t.eq('but the next one still comes', dueReminder(sent1, at(25)).tag, 'R2')
  const allSent = order({ notes: '[R1] [R2] [R3] [R4]' })
  t.ok('once all are sent, nothing more is due', !dueReminder(allSent, at(5000)))
  t.eq('the markers are read out of the notes', [...alreadySent('x [R1] y [R3]')].sort().join(','), 'R1,R3')
}

// ── catching up must not fire four messages at once ───────────────────────
{
  const old = order()
  const r = dueReminder(old, at(2000))
  t.eq('a long-unseen order gets one message', r.tag, 'R4')
  t.eq('and the three it never got are marked, not sent', r.superseded.join(','), 'R1,R2,R3')
}

// ── who is worth chasing ──────────────────────────────────────────────────
{
  t.ok('a pending order with a phone number is', isChaseable(order()))
  t.ok('a paid one is not', !isChaseable(order({ status: 'Paid', paid_at: '2026-11-01T10:05:00Z' })))
  t.ok('nor one marked paid by timestamp alone', !isChaseable(order({ paid_at: '2026-11-01T10:05:00Z' })))
  t.ok('nor a cancelled one', !isChaseable(order({ status: 'Cancelled' })))
  t.ok('nor a completed one', !isChaseable(order({ status: 'Completed' })))
  t.ok('nor one with no phone number', !isChaseable(order({ customer_phone: '  ' })))
  // The old code also required a USSD code and skipped the order in silence
  // without one — the customer whose payment never got that far is exactly
  // the one worth chasing.
  t.ok('an order with no USSD code is still chased', isChaseable(order({ ussd_code: null })))
}

// ── the message has to give them a way back ───────────────────────────────
{
  const link = 'https://admin.bedtimehome.com/#/pay/o1'
  const m = reminderMessage({ order: order(), tag: 'R1', payUrl: link })
  t.ok('it is addressed to them by first name', m.startsWith('Hi Ama,'))
  t.ok('it names the order', m.includes('WEB-ABC123'))
  t.ok('it states the amount', m.includes('GHS 450.00'))
  t.ok('IT CONTAINS THE LINK BACK', m.includes(link))
  t.ok('and still offers the USSD code', m.includes('*713*123#'))

  const noCode = reminderMessage({ order: order({ ussd_code: null }), tag: 'R2', payUrl: link })
  t.ok('with no code, the link is the whole route', noCode.includes(link) && !noCode.includes('dial'))

  const last = reminderMessage({ order: order(), tag: 'R4', payUrl: link, isFinal: true })
  t.ok('the final one says it is the last', /last reminder/i.test(last))
  t.ok('and that the order will be cancelled', /cancelled/i.test(last))

  const noName = reminderMessage({ order: order({ customer_name: '' }), tag: 'R1', payUrl: link })
  t.ok('a missing name does not produce "Hi ,"', noName.startsWith('Hi there,'))
}

// ── the schedule is configurable, as asked ────────────────────────────────
{
  const s = stepsFrom('10,45,180')
  t.eq('a schedule can be set from configuration', s.map(x => x.afterMinutes).join(','), '10,45,180')
  t.eq('and is tagged in order', s.map(x => x.tag).join(','), 'R1,R2,R3')
  t.eq('out-of-order values are sorted', stepsFrom('60,5,20').map(x => x.afterMinutes).join(','), '5,20,60')
  t.eq('nonsense falls back to the default', stepsFrom('abc').length, DEFAULT_STEPS.length)
  t.eq('so does an empty setting', stepsFrom('').length, DEFAULT_STEPS.length)
  t.eq('a custom schedule is honoured', dueReminder(order(), at(50), s).tag, 'R2')
}

// ── bad data must not throw inside a scheduled job ────────────────────────
{
  t.ok('no order', !dueReminder(null, at(10)))
  t.ok('no date', !dueReminder(order({ date: null }), at(10)))
  t.ok('an unparseable date', !dueReminder(order({ date: 'not a date' }), at(10)))
  t.ok('a date in the future', !dueReminder(order({ date: new Date(at(99)).toISOString() }), at(10)))
}

// ── three instances of one bug, found by running the job ─────────────────────
// The payment-reminder job was executed against a staging database seeded
// with orders spanning every reminder tier. Fixing the database filter alone
// was not enough, and the way that showed was the skip count going up by
// exactly the one order the query had just started including.
{
  const { ussdDial, isChaseable } = await import('../supabase/functions/_shared/reminders.js')

  // 1. isChaseable compared the status with ===, so an order spelled
  //    'pending' was never chased and sat unpaid forever.
  const base = { paid_at: null, customer_phone: '0548124974', notes: '' }
  t.ok('a lower-case pending order is chased', isChaseable({ ...base, status: 'pending' }))
  t.ok('as is a capitalised one', isChaseable({ ...base, status: 'Pending' }))
  t.ok('and Awaiting Payment in any case', isChaseable({ ...base, status: 'awaiting payment' }))
  t.ok('surrounding space does not change it', isChaseable({ ...base, status: '  Pending  ' }))
  t.ok('a cancelled order is not chased', !isChaseable({ ...base, status: 'cancelled' }))
  t.ok('nor a completed one', !isChaseable({ ...base, status: 'Completed' }))
  t.ok('nor one already paid', !isChaseable({ ...base, status: 'Pending', paid_at: '2026-11-10' }))
  t.ok('nor one with no phone number', !isChaseable({ ...base, status: 'Pending', customer_phone: '' }))

  // 2. whatsapp_orders.ussd_code is an INTEGER. The message said
  //    "Or dial 1001 to pay", and nothing happens when a customer dials that.
  //    The rest of the system dials *920*141*<code>#.
  t.eq('an integer code becomes a dialable one',
    ussdDial(1001), '\nOr dial *920*141*1001# to pay by mobile money.')
  t.eq('a numeric string too',
    ussdDial('1001'), '\nOr dial *920*141*1001# to pay by mobile money.')
  t.eq('a code that is already a full dial string is left alone',
    ussdDial('*713*123#'), '\nOr dial *713*123# to pay by mobile money.')
  t.eq('no code means no dial line at all', ussdDial(null), '')
  t.eq('nor for an empty one', ussdDial(''), '')
  t.eq('nor for undefined', ussdDial(undefined), '')
}

// The whole message, for the case that was broken end to end: an order with
// an integer USSD code, spelled in lower case, ninety minutes old.
{
  const { reminderMessage, dueReminder, isChaseable } = await import('../supabase/functions/_shared/reminders.js')
  const order = { order_no: 'TEST-LOWER', customer_name: 'Lower Case', customer_phone: '0548124974',
                  total: 800, ussd_code: 1008, status: 'pending', paid_at: null, notes: '',
                  date: new Date(Date.now() - 90 * 60000).toISOString() }
  t.ok('it is chaseable', isChaseable(order))
  const due = dueReminder(order, Date.now())
  t.eq('ninety minutes earns the third reminder', due.tag, 'R3')
  t.eq('and the two it skipped are marked, not sent', due.superseded.join(','), 'R1,R2')
  const msg = reminderMessage({ order, tag: due.tag, payUrl: 'https://bedtimehome.com/#/pay/x' })
  t.ok('the message carries a payment link', /https:\/\/bedtimehome\.com\/#\/pay\/x/.test(msg))
  t.ok('and a dialable code', /\*920\*141\*1008#/.test(msg))
  t.ok('and never a bare integer instruction', !/dial 1008 to pay/.test(msg))
  t.ok('it names the customer', /Lower Case|Lower/.test(msg))
  t.ok('and the amount', /GHS 800\.00/.test(msg))
}
