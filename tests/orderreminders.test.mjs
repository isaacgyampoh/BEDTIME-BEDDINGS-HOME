import { suite } from './harness.mjs'
import { remindersSent, isAwaitingPayment, waitingFor, chaseSummary } from '../src/lib/orderReminders.js'
const t = suite('POS: how often an unpaid order has been chased')

const NOW = Date.parse('2026-11-01T12:00:00Z')
const ago = (mins) => new Date(NOW - mins * 60000).toISOString()
const order = (o = {}) => ({ status: 'Pending', date: ago(30), notes: '', ...o })

// The reminder job records what it sent as [R1]..[R4] in the notes. Nothing in
// the POS ever showed it, so staff re-chased customers the system had already
// chased four times.
t.eq('no markers, nothing sent', remindersSent('DELIVERY | call on arrival').length, 0)
t.eq('one marker', remindersSent('DELIVERY [R1]').join(','), 'R1')
t.eq('several, in order', remindersSent('[R3] x [R1] y [R2]').join(','), 'R1,R2,R3')
t.eq('a repeated marker counts once', remindersSent('[R1] [R1]').join(','), 'R1')
t.eq('empty notes are fine', remindersSent('').length, 0)
t.eq('and missing notes', remindersSent(null).length, 0)

// Only orders still waiting for money are worth chasing.
t.ok('a pending order is awaiting payment', isAwaitingPayment(order()))
t.ok('so is one explicitly Awaiting Payment', isAwaitingPayment(order({ status: 'Awaiting Payment' })))
t.ok('a paid one is not', !isAwaitingPayment(order({ status: 'Paid' })))
t.ok('nor one with a paid timestamp', !isAwaitingPayment(order({ paidAt: '2026-11-01T11:00:00Z' })))
t.ok('nor a cancelled one', !isAwaitingPayment(order({ status: 'Cancelled' })))
t.ok('nor a completed one', !isAwaitingPayment(order({ status: 'Completed' })))
t.ok('nothing is not', !isAwaitingPayment(null))

// How long it has been waiting, in words someone can act on.
t.eq('under a minute', waitingFor(order({ date: ago(0) }), NOW), 'just now')
t.eq('minutes', waitingFor(order({ date: ago(25) }), NOW), '25 min')
t.eq('hours', waitingFor(order({ date: ago(200) }), NOW), '3 hr')
t.eq('a day', waitingFor(order({ date: ago(1500) }), NOW), '1 day')
t.eq('several days', waitingFor(order({ date: ago(5000) }), NOW), '3 days')
t.eq('a date that makes no sense says nothing', waitingFor({ date: 'nope' }, NOW), '')

// The line that appears on the card.
{
  const fresh = chaseSummary(order({ date: ago(10) }), NOW)
  t.eq('an unchased order says so', fresh.text, 'No reminder sent yet · waiting 10 min')
  t.eq('and counts nothing', fresh.count, 0)

  const chased = chaseSummary(order({ notes: 'x [R1] [R2]', date: ago(90) }), NOW)
  t.eq('a chased one counts them', chased.count, 2)
  t.eq('and says how long it has waited', chased.text, '2 reminders sent · waiting 1 hr')
  t.eq('one reminder reads singular', chaseSummary(order({ notes: '[R1]' }), NOW).text.startsWith('1 reminder sent'), true)

  t.eq('a paid order gets no line at all', chaseSummary(order({ status: 'Paid' }), NOW), null)
  t.eq('nor a cancelled one', chaseSummary(order({ status: 'Cancelled' }), NOW), null)
}
