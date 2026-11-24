import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildReport, TYPES } from '../_shared/reports.js'

const ARKESEL_API_KEY = Deno.env.get('ARKESEL_API_KEY') || ''
// mNotify is the provider this shop actually pays for and has configured; the
// Arkesel key has never been set, so every scheduled report was built and then
// dropped. Prefer mNotify, keep Arkesel as a fallback if a key ever appears.
const MNOTIFY_API_KEY = Deno.env.get('MNOTIFY_KEY') || ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://wqkgfvmvuljzexhevlnp.supabase.co'
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
// Must match the sender ID registered with mNotify — super-service already
// sends as BEDTIMEHOME. The previous brand's ID survived the rename here and
// an unregistered sender is a common silent rejection.
const SENDER_ID = Deno.env.get('MNOTIFY_SENDER_ID') || 'BEDTIMEHOME'

// Who the scheduled reports go to (morning, afternoon, evening, weekly).
// Settable without a code change: `supabase secrets set ADMIN_SMS_PHONES=...`
// takes effect on the next run, comma-separated for more than one number.
// formatPhone() turns 0XXXXXXXXX into 233XXXXXXXXX for mNotify, so write them
// the way they are dialled locally.
const ADMIN_PHONES = (Deno.env.get('ADMIN_SMS_PHONES') || '0548124978')
  .split(',').map(p => p.trim()).filter(Boolean)

const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

const formatPhone = (p) => {
  const clean = p.replace(/\D/g, '')
  if (clean.startsWith('0')) return '233' + clean.slice(1)
  if (clean.startsWith('233')) return clean
  return '233' + clean
}

const fmt = (n) => 'GHS ' + Number(n || 0).toFixed(2)
const dateStr = (d) => d.toISOString().slice(0, 10)

const sendSMS = async (phones, message) => {
  const recipients = phones.map(formatPhone)

  // Record the send so system_health() reflects real volume. The shop's own
  // line is exempt from the cap (029), so this never blocks a report.
  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY)
    for (const p of recipients) await sb.rpc('claim_sms', { p_phone: p, p_kind: 'report' })
  } catch (e) { console.warn('sms_log write failed (continuing):', e) }

  if (MNOTIFY_API_KEY) {
    // Same call shape super-service already uses successfully.
    const results = []
    for (const phone of recipients) {
      try {
/**
 * Did the SMS provider actually accept the message?
 *
 * A 2xx is necessary and NOT sufficient. mNotify's legacy endpoint returns
 * HTTP 200 for a rejected send and puts the reason in the body, so a status
 * check alone reports a message nobody received as delivered.
 */
function providerAccepted(status: number, body: string): boolean {
  if (!(status >= 200 && status < 300)) return false
  const text = String(body || '')
  try {
    const j = JSON.parse(text)
    if (j && typeof j === 'object') {
      const st = String((j as Record<string, unknown>).status ?? '').toLowerCase()
      if (st === 'error' || st === 'failed') return false
      const code = String((j as Record<string, unknown>).code ?? '')
      // mNotify: 1000 is success; 1004 invalid key, 1005 invalid number, etc.
      if (code && code !== '1000' && /^\d{4}$/.test(code)) return false
    }
  } catch { /* not JSON: fall through to the text checks */ }
  return !/invalid\s+api\s+key|insufficient|unauthor|failed|error/i.test(text)
}

        const res = await fetch(`https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: [phone], sender: SENDER_ID, message, is_schedule: false, schedule_date: '' })
        })
        let text = await res.text()
        let status = res.status
        if (!res.ok) {
          // Same fallback as super-service: the v2 API 401s on keys the legacy
          // endpoint still accepts.
          const legacy = await fetch(`https://apps.mnotify.net/smsapi?key=${MNOTIFY_API_KEY}&to=${encodeURIComponent(phone)}&msg=${encodeURIComponent(message)}&sender_id=${encodeURIComponent(SENDER_ID)}`)
          text = await legacy.text(); status = legacy.status
          console.log(`report SMS fallback to ${phone}: ${status} ${text.slice(0, 120)}`)
        }
        console.log(`report SMS to ${phone}: ${status} ${text.slice(0, 120)}`)
        // mNotify answers HTTP 200 WITH AN ERROR IN THE BODY. On
        // 24 November 2026 an invalid key produced
        //   200 {"status":"error","code":"1004","message":"Invalid API key."}
        // and this line called that delivered, because it only read the
        // status code. Six report jobs in a row reported "delivered":true
        // while nothing was sent and nothing anywhere said so.
        results.push({ phone, status, delivered: providerAccepted(status, text) })
      } catch (e) {
        console.error(`report SMS failed for ${phone}:`, e)
        results.push({ phone, error: String(e) })
      }
    }
    return { provider: 'mnotify', results }
  }

  if (ARKESEL_API_KEY) {
    try {
      const res = await fetch('https://sms.arkesel.com/api/v2/sms/send', {
        method: 'POST',
        headers: { 'api-key': ARKESEL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: SENDER_ID, message, recipients })
      })
      const data = await res.json()
      console.log('SMS sent:', data)
      return { provider: 'arkesel', ...data }
    } catch (e) {
      console.error('SMS error:', e)
      return { error: e.message }
    }
  }

  // Say so rather than reporting success for a message nobody received.
  console.error('No SMS provider configured (MNOTIFY_KEY / ARKESEL_API_KEY)')
  return { error: 'No SMS provider configured', delivered: false }
}

/**
 * Rows for the report builders. The only part that knows about the database.
 */
const data = {
  sales: async (from, to) => {
    const { data: rows } = await sb.from('sales').select('*')
      .gte('date', from + 'T00:00:00').lte('date', to + 'T23:59:59').eq('voided', false)
    return rows || []
  },
  expenses: async (from, to) => {
    const { data: rows } = await sb.from('expenses').select('*')
      .gte('date', from + 'T00:00:00').lte('date', to + 'T23:59:59')
    const e = rows || []
    return { total: e.reduce((a, x) => a + Number(x.amount || 0), 0), count: e.length }
  },
  lowStock: async () => {
    const { data: rows } = await sb.from('products').select('name, quantity')
      .lte('quantity', 5).order('quantity', { ascending: true }).limit(10)
    return rows || []
  },
}

serve(async (req) => {
  const url = new URL(req.url)
  const type = url.searchParams.get('type') || ''
  // A dry run builds the report and returns it WITHOUT sending an SMS, so the
  // daily report can be read against real data without a phone receiving it.
  const dry = url.searchParams.get('dry') === '1'

  if (!type) {
    return new Response(JSON.stringify({ status: 'ok', usage: `?type=${TYPES.join('|')}`, dryRun: '&dry=1' }),
      { headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const message = await buildReport(type, data, new Date())

    // An unknown type used to fall through to a 200 with a usage string. Three
    // of the six SCHEDULED reports asked for a type this function did not
    // handle — midday, lowstock and monthly — so pg_cron recorded six
    // successes a day while three of them sent nothing. A 400 makes the next
    // disagreement between a schedule and a handler visible.
    if (message === null) {
      return new Response(JSON.stringify({ error: `unknown report type "${type}"`, known: TYPES }),
        { status: 400, headers: { 'Content-Type': 'application/json' } })
    }

    if (dry) {
      return new Response(JSON.stringify({ status: 'built', type, sent: false, recipients: ADMIN_PHONES, message }),
        { headers: { 'Content-Type': 'application/json' } })
    }

    const result = await sendSMS(ADMIN_PHONES, message)
    // The top line has to agree with the per-recipient results, because that
    // is what a monitor reads. Saying 'sent' while every recipient shows
    // delivered:false is how a broken provider key stays invisible.
    const anyDelivered = Array.isArray((result as { results?: unknown[] })?.results)
      ? (result as { results: { delivered?: boolean }[] }).results.some((r) => r?.delivered === true)
      : false
    return new Response(JSON.stringify({ status: anyDelivered ? 'sent' : 'not-delivered', type, recipients: ADMIN_PHONES, result }),
      { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
