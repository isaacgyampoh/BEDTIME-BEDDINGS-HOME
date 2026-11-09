// supabase/functions/paystack-webhook/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { planFor, settleFields } from '../_shared/payments.js'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PAYSTACK_SECRET_KEY = Deno.env.get('PAYSTACK_SECRET_KEY') || ''
// Where payment alerts go. It was the shop's old number, written into the code
// in four places, so moving it meant a deploy. The same variable name every
// other function uses, so one secret covers all of them.
const ADMIN_PHONES = Deno.env.get('ADMIN_SMS_PHONES') || '0548124978'
// The number a customer is told to ring.
const SHOP_PHONE = Deno.env.get('SHOP_PHONE') || '054 812 4978'

/**
 * Paystack signs every webhook with HMAC-SHA512 of the raw body, keyed on the
 * account's secret key, in the `x-paystack-signature` header.
 *
 * Without this check the endpoint accepted any POST claiming `charge.success`,
 * so anyone who knew the URL could mark orders Paid and have stock deducted and
 * confirmation SMS sent — free goods. Verify before trusting a single field.
 */
async function signatureValid(rawBody: string, signature: string): Promise<boolean> {
  if (!PAYSTACK_SECRET_KEY) {
    console.error('SECURITY: PAYSTACK_SECRET_KEY is not set — refusing to process the webhook.')
    return false
  }
  if (!signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(PAYSTACK_SECRET_KEY),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('')

  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    // Read the body as text: the signature is over the exact bytes sent, so it
    // must be verified before any JSON parsing/normalisation.
    const rawBody = await req.text()
    const signature = req.headers.get('x-paystack-signature') || ''

    if (!await signatureValid(rawBody, signature)) {
      console.error('Rejected webhook with an invalid or missing Paystack signature')
      return new Response(JSON.stringify({ error: 'invalid signature' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      })
    }

    const body = JSON.parse(rawBody)

    console.log('WEBHOOK EVENT:', body.event)
    console.log('WEBHOOK DATA:', JSON.stringify(body.data || {}).slice(0, 500))

    if (body.event !== 'charge.success') {
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    const paymentData = body.data
    const metadata = paymentData.metadata || {}
    const paystackRef = paymentData.reference || ''

    console.log('Payment ref:', paystackRef)
    console.log('Metadata:', JSON.stringify(metadata).slice(0, 300))

    // Every order already carrying this reference. NOT `.single()`: that
    // raises an error when more than one row matches, the error was
    // discarded, and the handler then created another order — so the first
    // duplicate made every later delivery create one more.
    const findByRef = async (r) => {
      if (!r) return []
      const { data, error } = await supabase.from('whatsapp_orders')
        .select('id,order_no,total,status,paid_at,paystack_ref,customer_phone,customer_name')
        .eq('paystack_ref', r)
      if (error) { console.error('ref lookup failed:', error.message); throw error }
      return data || []
    }

    // A USSD payment names its order in the metadata; everything else is
    // found by reference.
    let matches = []
    let target = null
    if (metadata.source === 'ussd' && metadata.order_id) {
      const { data } = await supabase.from('whatsapp_orders')
        .select('id,order_no,total,status,paid_at,paystack_ref,customer_phone,customer_name')
        .eq('id', metadata.order_id)
      target = (data || [])[0] || null
      if (!target) console.error('USSD metadata named order', metadata.order_id, 'which does not exist')
    } else {
      matches = await findByRef(paystackRef)
    }

    const plan = planFor({ ref: paystackRef, paidMinor: paymentData.amount, matches, order: target })
    console.log('PLAN:', JSON.stringify(plan))

    if (plan.action === 'noop') {
      // A repeat delivery. Answer 2xx so the provider stops retrying, and
      // change nothing: re-settling would move the sale's date, deduct stock
      // twice and send the customer a second confirmation.
      return new Response(JSON.stringify({ received: true, duplicate: true, order: plan.order }),
        { headers: { 'Content-Type': 'application/json' } })
    }

    if (plan.action === 'conflict' || plan.action === 'review') {
      // Something a person has to look at: an underpayment, a payment against
      // a cancelled order, or one reference on several orders. Do not guess.
      // 2xx, because retrying will not change the answer.
      console.error('NEEDS REVIEW:', JSON.stringify(plan))
      try { await sendSMS(ADMIN_PHONES, `Payment needs checking: ${plan.order || paystackRef}. ${plan.reason}. GHS ${(Number(paymentData.amount || 0) / 100).toFixed(2)} received.`) } catch {}
      return new Response(JSON.stringify({ received: true, review: plan }),
        { headers: { 'Content-Type': 'application/json' } })
    }

    if (plan.action === 'settle') {
      const o = target || matches[0]
      const fields = settleFields(paymentData.paid_at, paystackRef)
      // Only settle a row that is still unsettled. If two deliveries arrive at
      // once, the second updates no rows instead of settling it twice.
      const { data: updated, error: updErr } = await supabase.from('whatsapp_orders')
        .update({
          ...fields,
          ...(metadata.customer_phone || paymentData.customer?.phone
            ? { customer_phone: metadata.customer_phone || paymentData.customer?.phone }
            : {}),
        })
        .eq('id', o.id).is('paid_at', null).select('id,order_no,total,customer_phone,customer_name')

      if (updErr) throw updErr
      if (!updated || updated.length === 0) {
        console.log('another delivery settled', o.order_no, 'first — nothing to do')
        return new Response(JSON.stringify({ received: true, duplicate: true, order: o.order_no }),
          { headers: { 'Content-Type': 'application/json' } })
      }

      const row = updated[0]
      const cedis = (Number(paymentData.amount || 0) / 100).toFixed(2)
      try { await supabase.rpc('deduct_order_stock', { p_order_id: row.id }) } catch (e) { console.error('stock deduction failed:', e) }
      try { await sendSMS(ADMIN_PHONES, `Payment! ${row.order_no} GHS ${cedis} Paid. Process ASAP.`) } catch {}
      if (row.customer_phone) {
        try { await sendSMS(row.customer_phone, `Hi ${(row.customer_name || 'Customer').split(' ')[0]}, we have received your payment of GHS ${cedis}.\n\nOrder: ${row.order_no}\n\nBEDTIME BEDDINGS & HOME`) } catch {}
      }
      return new Response(JSON.stringify({ success: true, order: row.order_no, settled: plan.reason }),
        { headers: { 'Content-Type': 'application/json' } })
    }

    // --- plan.action === 'create': a payment with no order behind it -------
    const { data: products } = await supabase.from('products').select('*')

    const rawItems = metadata.items || []
    let subtotal = 0
    const processedItems = rawItems.map((item: any) => {
      let price = Number(item.price) || 0
      const productName = item.name || item.product || ''
      const qty = Number(item.qty) || Number(item.quantity) || 1
      if (!price && productName && products) {
        const match = products.find((p: any) => p.name.toLowerCase() === productName.toLowerCase())
        if (match) price = Number(match.price) || 0
      }
      const lineTotal = price * qty
      subtotal += lineTotal
      return { name: productName, qty, price, lineTotal }
    })

    const deliveryFee = Number(metadata.deliveryFee || metadata.delivery_fee) || 0
    const total = subtotal + deliveryFee

    const { data: orderNoData } = await supabase.rpc('generate_wa_order_no')
    const orderNo = orderNoData || `WA${Date.now()}`

    // The money has arrived, so the order is Paid. It used to be created as
    // 'Pending' with paid_at set at the same time, which put a paid order in
    // the list the shop chases for payment.
    const { error } = await supabase.from('whatsapp_orders').insert({
      order_no: orderNo,
      date: paymentData.paid_at || new Date().toISOString(),
      customer_name: metadata.customerName || metadata.customer_name || paymentData.customer?.first_name || '',
      customer_phone: metadata.customerPhone || metadata.customer_phone || paymentData.customer?.phone || '',
      items: processedItems,
      subtotal,
      delivery_fee: deliveryFee,
      total,
      address: metadata.address || metadata.deliveryAddress || '',
      notes: metadata.notes || '',
      status: 'Paid',
      paystack_ref: paymentData.reference,
      paid_at: paymentData.paid_at || new Date().toISOString(),
      created_at: new Date().toISOString()
    }).select().single()

    if (error) {
      // If paystack_ref is unique (staged in supabase/pending/050), a
      // concurrent delivery that lost the race lands here. That is the
      // correct outcome: the order exists, so answer 2xx and stop.
      if (String(error.code) === '23505') {
        console.log('a concurrent delivery already created the order for', paystackRef)
        return new Response(JSON.stringify({ received: true, duplicate: true }),
          { headers: { 'Content-Type': 'application/json' } })
      }
      throw error
    }

    try { await sendSMS(ADMIN_PHONES, `New Order! ${orderNo} GHS ${total.toFixed(2)} Paid online`) } catch {}

    return new Response(JSON.stringify({ success: true, orderNo, total }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (err) {
    console.error('Webhook error:', err)
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
})

const MNOTIFY_API_KEY = Deno.env.get('MNOTIFY_API_KEY') || ''
const MNOTIFY_SENDER_ID = Deno.env.get('MNOTIFY_SENDER_ID') || 'BEDTIMEHOME'

async function sendSMS(to: string, message: string) {
  if (!MNOTIFY_API_KEY) return
  const recipients = to.split(',').map(r => r.trim())
  for (const recipient of recipients) {
    const phone = recipient.replace(/\s+/g, '').replace(/^0/, '233')
    try {
      await fetch(`https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: [phone], sender: MNOTIFY_SENDER_ID, message, is_schedule: false, schedule_date: '' })
      })
    } catch (e) {
      try { await fetch(`https://apps.mnotify.net/smsapi?key=${MNOTIFY_API_KEY}&to=${encodeURIComponent(phone)}&msg=${encodeURIComponent(message)}&sender_id=${encodeURIComponent(MNOTIFY_SENDER_ID)}`) } catch {}
    }
  }
}
