import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://wqkgfvmvuljzexhevlnp.supabase.co'
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
// mNotify SMS
const MNOTIFY_API_KEY = Deno.env.get('MNOTIFY_KEY') || ''
const MNOTIFY_SENDER_ID = 'BEDTIMEHOME'
const SHOP = 'BEDTIME BEDDINGS & HOME'

// SECURITY: never inline live payment credentials as fallbacks — this file is
// in version control. Set these as Supabase function secrets:
//   supabase secrets set NALOPAY_MERCHANT_ID=... NALOPAY_API_KEY=... NALOPAY_AUTH_HEADER=...
// The guards below already treat an empty value as "NaloPay not configured".
const NALOPAY_MERCHANT_ID = Deno.env.get('NALOPAY_MERCHANT_ID') || ''
const NALOPAY_API_KEY = Deno.env.get('NALOPAY_API_KEY') || ''
const NALOPAY_AUTH = Deno.env.get('NALOPAY_AUTH_HEADER') || ''
const NALOPAY_TOKEN_URL = 'https://api.nalopay.com/clientapi/generate-payment-token/'
const NALOPAY_COLLECTION_URL = 'https://api.nalopay.com/clientapi/collection/'

const PROCESSING_FEE = 1.013

// ===== Moolre (new payment provider) — credentials from Supabase secrets =====
const MOOLRE_USER = Deno.env.get('MOOLRE_API_USER') || ''
const MOOLRE_KEY = Deno.env.get('MOOLRE_API_KEY') || ''       // private key (initiating payments)
const MOOLRE_PUBKEY = Deno.env.get('MOOLRE_API_PUBKEY') || '' // public key (status checks)
const MOOLRE_ACCOUNT = Deno.env.get('MOOLRE_ACCOUNT_NUMBER') || '' // your Moolre wallet number
// Flip to 'https://sandbox.moolre.com' to test (sandbox ignores the API keys).
const MOOLRE_BASE = Deno.env.get('MOOLRE_BASE_URL') || 'https://api.moolre.com'

// Moolre MoMo channel codes for the PAYMENT (collection) endpoint: MTN=13, Telecel=6, AT=7
function moolreChannel(phone: string): string {
  const net = detectGhanaNetwork(phone) // 'MTN' | 'AT' | 'TELECEL'
  if (net === 'MTN') return '13'
  if (net === 'TELECEL') return '6'
  return '7' // AT
}

// Shared secret appended to every callback URL we hand the payment providers.
// While unset, callbacks stay open (existing behaviour) and a warning is logged.
const CALLBACK_SECRET = Deno.env.get('PAYMENT_CALLBACK_SECRET') || ''

function callbackAuthorised(url: URL, req: Request): boolean {
  if (!CALLBACK_SECRET) {
    console.warn('SECURITY: PAYMENT_CALLBACK_SECRET is not set — payment callbacks are unauthenticated and anyone who knows this URL can mark an order Paid.')
    return true
  }
  const provided = url.searchParams.get('s') || req.headers.get('x-callback-secret') || ''
  if (provided.length !== CALLBACK_SECRET.length) return false
  // Constant-time compare so the secret can't be recovered by timing.
  let diff = 0
  for (let i = 0; i < CALLBACK_SECRET.length; i++) diff |= provided.charCodeAt(i) ^ CALLBACK_SECRET.charCodeAt(i)
  return diff === 0
}

// ===== TikTok (Content Posting API) — credentials from Supabase secrets =====
// Never inline these. The browser must never receive a TikTok token.
const TIKTOK_CLIENT_KEY = Deno.env.get('TIKTOK_CLIENT_KEY') || ''
const TIKTOK_CLIENT_SECRET = Deno.env.get('TIKTOK_CLIENT_SECRET') || ''
const TIKTOK_REDIRECT_URI = Deno.env.get('TIKTOK_REDIRECT_URI') || `${SUPABASE_URL}/functions/v1/super-service?action=tiktok-oauth-callback`
const APP_URL = Deno.env.get('APP_URL') || 'https://admin.bedtimehome.com'

const TIKTOK_AUTH = 'https://www.tiktok.com/v2/auth/authorize/'
const TIKTOK_TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/'
const TIKTOK_USERINFO = 'https://open.tiktokapis.com/v2/user/info/'
const TIKTOK_INIT_VIDEO = 'https://open.tiktokapis.com/v2/post/publish/video/init/'
const TIKTOK_INIT_PHOTO = 'https://open.tiktokapis.com/v2/post/publish/content/init/'
const TIKTOK_STATUS = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/'

const tiktokConfigured = () => !!(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET)

/** Authorise a privileged social action with an admin PIN (this app has no session token). */
async function requireAdmin(sb: any, pin: string): Promise<boolean> {
  if (!pin) return false
  const { data, error } = await sb.rpc('is_admin_pin', { p_pin: pin })
  return !error && data === true
}

async function socialAudit(sb: any, entry: Record<string, unknown>) {
  try { await sb.from('social_audit_log').insert(entry) } catch (_) { /* never block on logging */ }
}

/** Exchange a refresh token when the stored access token has expired. */
async function tiktokAccessToken(sb: any): Promise<{ token?: string; error?: string }> {
  const { data: rows } = await sb.from('social_connections').select('*').eq('platform', 'tiktok').limit(1)
  const conn = rows?.[0]
  if (!conn?.access_token) return { error: 'TikTok is not connected' }

  const fresh = conn.token_expires_at && new Date(conn.token_expires_at).getTime() > Date.now() + 60_000
  if (fresh) return { token: conn.access_token }

  if (!conn.refresh_token) return { error: 'TikTok session expired — reconnect the account' }
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token', refresh_token: conn.refresh_token,
  })
  const r = await fetch(TIKTOK_TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  const j = await r.json()
  if (!j.access_token) {
    await sb.from('social_connections').update({ status: 'expired', last_error: j.error_description || 'refresh failed' }).eq('platform', 'tiktok')
    return { error: 'TikTok session expired — reconnect the account' }
  }
  await sb.from('social_connections').update({
    access_token: j.access_token,
    refresh_token: j.refresh_token || conn.refresh_token,
    token_expires_at: new Date(Date.now() + (j.expires_in || 86400) * 1000).toISOString(),
    status: 'connected', last_error: null,
  }).eq('platform', 'tiktok')
  return { token: j.access_token }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json',
}

async function sendSMS(to: string, message: string, kind = 'generic') {
  if (!MNOTIFY_API_KEY) return
  const recipients = to.split(',').map(r => r.trim())
  for (const recipient of recipients) {
    const phone = recipient.replace(/\s+/g, '').replace(/^0/, '233')

    // Rate limit BEFORE spending money. These actions are reachable by an
    // unauthenticated POST, so without this anyone who knows the URL can run
    // up the SMS bill or flood a customer's phone. claim_sms is atomic and
    // records the send, so a false result means "already at the limit".
    try {
      const gate = createClient(SUPABASE_URL, SUPABASE_KEY)
      const { data: allowed, error: gateErr } = await gate.rpc('claim_sms', { p_phone: phone, p_kind: kind })
      if (gateErr) {
        console.error('claim_sms failed, refusing to send:', gateErr.message)
        continue
      }
      if (!allowed?.allowed) {
        console.warn(`SMS to ${phone} blocked: ${allowed?.reason}`)
        continue
      }
    } catch (e) {
      console.error('SMS rate-limit check threw, refusing to send:', e)
      continue
    }

    try {
      const res = await fetch(`https://api.mnotify.com/api/sms/quick?key=${MNOTIFY_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: [phone], sender: MNOTIFY_SENDER_ID, message, is_schedule: false, schedule_date: '' })
      })
      const data = await res.text()
      console.log(`SMS to ${phone}: status=${res.status} response=${data.substring(0, 100)}`)

      // A rejected key returns 401 — which is a RESOLVED fetch, not a thrown
      // error, so the catch below never fired and the message was silently
      // dropped. Fall back to mNotify's legacy endpoint, which accepts keys the
      // v2 API rejects, and say plainly when both refuse.
      if (!res.ok) {
        const legacy = await fetch(`https://apps.mnotify.net/smsapi?key=${MNOTIFY_API_KEY}&to=${encodeURIComponent(phone)}&msg=${encodeURIComponent(message)}&sender_id=${encodeURIComponent(MNOTIFY_SENDER_ID)}`)
        const lt = await legacy.text()
        console.log(`SMS fallback to ${phone}: status=${legacy.status} response=${lt.substring(0, 100)}`)
        if (!legacy.ok) console.error(`SMS NOT DELIVERED to ${phone}: both mNotify endpoints refused the key`)
      }
    } catch (e) {
      console.log(`SMS failed for ${phone}: ${e}`)
    }
  }
}

function detectGhanaNetwork(phone: string): 'MTN' | 'AT' | 'TELECEL' {
  const digits = String(phone).replace(/\D/g, '')
  let local = digits
  if (local.startsWith('233')) local = '0' + local.slice(3)
  if (!local.startsWith('0')) local = '0' + local
  const p3 = local.substring(0, 3)
  if (['024', '054', '055', '059', '025', '053'].includes(p3)) return 'MTN'
  if (local.substring(0, 4) === '0594') return 'MTN'
  if (p3 === '020' || p3 === '050') return 'TELECEL'
  if (['026', '056', '027', '057', '023', '028', '058'].includes(p3)) return 'AT'
  return 'MTN'
}

type NalopayResult = { success: boolean; reference: string; orderId?: string; otpCode?: string; status?: string; amount?: string; error?: string; raw?: any }

// Reusable Moolre charge. Per Moolre docs the initiate-payment endpoint uses
// X-API-USER + X-API-PUBKEY. Two-step OTP: call once without otpcode; if it
// returns TP14, Moolre SMSes an OTP to the payer — call again with the same
// externalref + otpcode to complete. Returns otpRequired so the UI can prompt.
async function moolreCharge(opts: { phone: string; amount: number | string; externalref: string; reference: string; otpcode?: string; sessionid?: string }): Promise<{ success: boolean; otpRequired?: boolean; otpVerifiedNeedsPrompt?: boolean; code?: string; error?: string; raw?: any }> {
  if (!MOOLRE_USER || !MOOLRE_ACCOUNT) return { success: false, error: 'Moolre not configured' }
  let local = String(opts.phone).replace(/\s+/g, '').replace(/^\+/, '')
  if (local.startsWith('233')) local = '0' + local.slice(3)
  if (!local.startsWith('0')) local = '0' + local
  const channel = moolreChannel(local)
  const body: Record<string, any> = {
    type: 1, channel, currency: 'GHS',
    payer: local, amount: Number(opts.amount).toFixed(2),
    externalref: opts.externalref, reference: opts.reference,
    accountnumber: MOOLRE_ACCOUNT,
  }
  if (opts.otpcode) body.otpcode = opts.otpcode
  // Passing the USSD session id skips OTP (customer already authenticated in the USSD session).
  if (opts.sessionid) body.sessionid = opts.sessionid
  try {
    const res = await fetch(`${MOOLRE_BASE}/open/transact/payment`, {
      method: 'POST',
      headers: { 'X-API-USER': MOOLRE_USER, 'X-API-PUBKEY': MOOLRE_PUBKEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const d = await res.json()
    console.log('MOOLRE charge response:', JSON.stringify(d))
    const codeStr = String(d.code || '')
    const msgStr = String(Array.isArray(d.message) ? d.message.join(' ') : (d.message || ''))
    // OTP required (TP14 / OTP_REQ): Moolre has SMSed an OTP to the payer.
    if (codeStr === 'TP14' || codeStr === 'OTP_REQ' || /otp.*(required|sent)/i.test(msgStr)) {
      return { success: false, otpRequired: true, code: codeStr, error: 'OTP sent to customer', raw: d }
    }
    // OTP verified but the payment prompt is a SEPARATE step. Moolre returns
    // TP17 "Phone no. Verification Successful." after a correct OTP — the phone is
    // now verified but the charge prompt has NOT been sent yet. Signal the caller
    // to make the follow-up request that actually sends the approve-with-PIN prompt.
    if (codeStr === 'TP17' || /verification\s+successful/i.test(msgStr)) {
      return { success: false, otpVerifiedNeedsPrompt: true, code: codeStr, raw: d } as any
    }
    // Success: prompt sent / payment requested.
    if (d.status === 1) return { success: true, code: codeStr, raw: d }
    // Anything else is a genuine failure (bad ref, config, etc.).
    return { success: false, code: codeStr, error: msgStr || 'Charge failed', raw: d }
  } catch (e) {
    return { success: false, error: 'Moolre request failed: ' + (e as Error).message }
  }
}

async function nalopayCharge(opts: { phone: string; amount: number | string; network: 'MTN' | 'AT' | 'TELECEL'; reference: string; accountName: string; description: string; callbackUrl: string }): Promise<NalopayResult> {
  if (!NALOPAY_MERCHANT_ID || !NALOPAY_API_KEY || !NALOPAY_AUTH) return { success: false, reference: opts.reference, error: 'NaloPay credentials not configured' }
  const chargedAmount = Number((Number(opts.amount) * PROCESSING_FEE).toFixed(2))
  const amountStr = chargedAmount.toFixed(2)
  let token = ''
  try {
    const tokenRes = await fetch(NALOPAY_TOKEN_URL, { method: 'POST', headers: { 'Authorization': NALOPAY_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant_id: NALOPAY_MERCHANT_ID }) })
    const tokenText = await tokenRes.text()
    console.log(`NaloPay token HTTP ${tokenRes.status}, body:`, tokenText.substring(0, 200))
    let tokenData: any = {}
    try { tokenData = JSON.parse(tokenText) } catch {
      // NaloPay returned non-JSON (HTML error page) — credentials/endpoint problem.
      return { success: false, reference: opts.reference, error: `NaloPay token endpoint returned ${tokenRes.status} (not JSON) — check NaloPay credentials/account`, raw: tokenText.substring(0, 200) }
    }
    token = tokenData.data?.token || tokenData.token || tokenData.access_token || ''
    if (!token) return { success: false, reference: opts.reference, error: 'Token generation failed', raw: tokenData }
  } catch (e) { return { success: false, reference: opts.reference, error: `Token error: ${(e as Error).message}` } }
  const hashMessage = `${NALOPAY_MERCHANT_ID}${opts.phone}${amountStr}${opts.reference}`
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(NALOPAY_API_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(hashMessage))
  const transHash = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  try {
    const chargeRes = await fetch(NALOPAY_COLLECTION_URL, { method: 'POST', headers: { 'token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant_id: NALOPAY_MERCHANT_ID, service_name: 'MOMO_TRANSACTION', trans_hash: transHash, account_number: opts.phone, account_name: opts.accountName || 'Customer', network: opts.network, amount: amountStr, reference: opts.reference, callback: opts.callbackUrl, description: opts.description }) })
    const chargeData = await chargeRes.json()
    console.log('NaloPay charge response:', JSON.stringify(chargeData))
    const ok = chargeData.success === true && (chargeRes.status === 200 || chargeRes.status === 201)
    if (ok) return { success: true, reference: opts.reference, orderId: chargeData.data?.order_id, otpCode: chargeData.data?.otp_code, status: chargeData.data?.status, amount: amountStr, raw: chargeData }
    return { success: false, reference: opts.reference, error: chargeData.error?.description || chargeData.message || 'Charge failed', raw: chargeData }
  } catch (e) { return { success: false, reference: opts.reference, error: `Charge error: ${(e as Error).message}` } }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const url = new URL(req.url)
    const action = url.searchParams.get('action')

    if (action === 'webhook') {
      const body = await req.json()
      console.log('WEBHOOK:', body.event, JSON.stringify(body.data || {}).slice(0, 500))
      if (body.event !== 'charge.success') return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } })
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const pd = body.data; const meta = pd.metadata || {}; const ref = pd.reference || ''
      const ADMIN_PHONES = '0599084552'
      if (meta.source === 'ussd' && meta.order_id) {
        const { data: paidOrder } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name').eq('id', meta.order_id).single()
        await supabase.from('whatsapp_orders').update({ status: 'Paid', paystack_ref: ref, paid_at: pd.paid_at || new Date().toISOString(), customer_phone: meta.customer_phone || pd.customer?.phone || '' }).eq('id', meta.order_id)
        try { await supabase.rpc('deduct_order_stock', { p_order_id: meta.order_id }) } catch {}
        const orderNo = meta.order_no || paidOrder?.order_no || ''; const amount = (pd.amount/100).toFixed(2); const custPhone = meta.customer_phone || paidOrder?.customer_phone || pd.customer?.phone || ''
        try { await sendSMS(ADMIN_PHONES, `Payment received. ${orderNo} GHS ${amount}. Process ASAP.`) } catch {}
        if (custPhone) { try { await sendSMS(custPhone, `Hi ${paidOrder?.customer_name || 'Customer'}, your payment of GHS ${amount} has been received.\n\nOrder: ${orderNo}\n\nYour order will be processed and delivered shortly.\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`) } catch {} }
        return new Response(JSON.stringify({ success: true, type: 'ussd' }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (ref.startsWith('USSD-')) {
        const { data: o } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name').eq('paystack_ref', ref).single()
        if (o) { await supabase.from('whatsapp_orders').update({ status: 'Paid', paid_at: pd.paid_at || new Date().toISOString() }).eq('id', o.id); try { await supabase.rpc('deduct_order_stock', { p_order_id: o.id }) } catch {} const amount = (pd.amount/100).toFixed(2); try { await sendSMS(ADMIN_PHONES, `Payment received. ${o.order_no} GHS ${amount}. Process ASAP.`) } catch {}; if (o.customer_phone) { try { await sendSMS(o.customer_phone, `Hi ${o.customer_name || 'Customer'}, your payment of GHS ${amount} has been received.\n\nOrder: ${o.order_no}\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`) } catch {} }; return new Response(JSON.stringify({ success: true, type: 'ussd-ref' }), { headers: { 'Content-Type': 'application/json' } }) }
      }
      if (ref) {
        const { data: o } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name').eq('paystack_ref', ref).single()
        if (o) { await supabase.from('whatsapp_orders').update({ status: 'Paid', paid_at: pd.paid_at || new Date().toISOString() }).eq('id', o.id); try { await supabase.rpc('deduct_order_stock', { p_order_id: o.id }) } catch {} const amount = (pd.amount/100).toFixed(2); try { await sendSMS(ADMIN_PHONES, `Payment received. ${o.order_no} GHS ${amount}. Process ASAP.`) } catch {}; if (o.customer_phone) { try { await sendSMS(o.customer_phone, `Hi ${o.customer_name || 'Customer'}, your payment of GHS ${amount} has been received.\n\nOrder: ${o.order_no}\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`) } catch {} }; return new Response(JSON.stringify({ success: true, type: 'ref' }), { headers: { 'Content-Type': 'application/json' } }) }
      }
      const { data: products } = await supabase.from('products').select('*'); const rawItems = meta.items || []; let subtotal = 0
      const items = rawItems.map((it: any) => { let price = Number(it.price) || 0; const name = it.name || it.product || ''; const qty = Number(it.qty) || Number(it.quantity) || 1; if (!price && name && products) { const m = products.find((p: any) => p.name.toLowerCase() === name.toLowerCase()); if (m) price = Number(m.price) || 0 }; const lt = price * qty; subtotal += lt; return { name, qty, price, lineTotal: lt } })
      const fee = Number(meta.deliveryFee || meta.delivery_fee) || 0; const total = subtotal + fee
      const { data: noData } = await supabase.rpc('generate_wa_order_no'); const orderNo = noData || `WA${Date.now()}`
      await supabase.from('whatsapp_orders').insert({ order_no: orderNo, date: new Date().toISOString(), customer_name: meta.customerName || meta.customer_name || pd.customer?.first_name || '', customer_phone: meta.customerPhone || meta.customer_phone || pd.customer?.phone || '', items, subtotal, delivery_fee: fee, total, address: meta.address || '', notes: meta.notes || '', status: 'Pending', paystack_ref: ref, paid_at: pd.paid_at || new Date().toISOString(), created_at: new Date().toISOString() })
      try { await sendSMS(ADMIN_PHONES, `New order. ${orderNo} GHS ${total.toFixed(2)}. Process ASAP.`) } catch {}
      return new Response(JSON.stringify({ success: true, orderNo }), { headers: { 'Content-Type': 'application/json' } })
    }

    if (action === 'ussd') {
      const allParams: Record<string, string> = {}
      for (const [k, v] of url.searchParams) allParams[k] = v
      if (req.method === 'POST') { const rawBody = await req.text(); try { const j = JSON.parse(rawBody); for (const [k, v] of Object.entries(j)) allParams[String(k)] = String(v) } catch { for (const [k, v] of new URLSearchParams(rawBody)) allParams[k] = v } }
      console.log('USSD IN:', JSON.stringify(allParams))
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      // Respond in BOTH the aggregator format (MSGTYPE/MSG/USSDMSG) and Moolre's
      // ({message, reply}) so the reply is understood whichever system delivers the USSD.
      const ussdCon = (msg: string) => new Response(JSON.stringify({ MSGTYPE: true, MSG: msg, USSDMSG: msg, message: msg, reply: true, continueSession: true }), { headers: { 'Content-Type': 'application/json' } })
      const ussdEnd = (msg: string) => new Response(JSON.stringify({ MSGTYPE: false, MSG: msg, USSDMSG: msg, message: msg, reply: false, continueSession: false }), { headers: { 'Content-Type': 'application/json' } })
      // Read fields from BOTH uppercase (aggregator) and lowercase (Moolre) names.
      const sessionId = allParams.SESSIONID || allParams.sessionid || allParams.sessionId || ''
      const phone = allParams.MSISDN || allParams.msisdn || ''
      const userData = allParams.USERDATA || allParams.userdata || allParams.data || ''
      let sess: any = null; if (sessionId) { const { data } = await supabase.from('ussd_sessions').select('*').eq('session_id', sessionId).single(); sess = data }
      const step = sess?.step || ''; const isMenuChoice = userData === '1' || userData === '2'
      let orderCode = ''; if (!isMenuChoice && userData) { const parts = userData.replace(/#/g, '').split('*').filter(Boolean); const idx = parts.indexOf('141'); if (idx >= 0 && parts[idx + 1] && /^\d+$/.test(parts[idx + 1])) orderCode = parts[idx + 1]; if (!orderCode && /^\d{1,6}$/.test(userData.trim())) orderCode = userData.trim() }
      if ((isMenuChoice || !orderCode) && sess?.order_code && sess.order_code !== 'LOG') orderCode = String(sess.order_code)
      if (!orderCode) return ussdCon(`Welcome to ${SHOP}\nPlease enter your Order Code:`)
      if (sessionId) { await supabase.from('ussd_sessions').upsert({ session_id: sessionId, order_code: orderCode, phone, step: 'menu', updated_at: new Date().toISOString() }, { onConflict: 'session_id' }) }
      console.log('Looking up order with ussd_code:', orderCode, 'parsed as:', parseInt(orderCode))
      const { data: orders, error: orderError } = await supabase.from('whatsapp_orders').select('id,order_no,total,status,customer_name,customer_phone,ussd_code,source,delivery_status,tracking_no').eq('ussd_code', parseInt(orderCode)).order('date', { ascending: false }).limit(1)
      const order = orders?.[0] || null; console.log('Order lookup result:', order ? order.order_no : 'NULL', 'error:', orderError?.message || 'none')
      if (!order) return ussdEnd(`Order ${orderCode} not found.\nCall 059 908 4552`)
      if (order.status === 'Paid' || order.status === 'Completed') {
        const d = order.delivery_status || (order.status === 'Completed' ? 'Being processed' : 'Paid - being processed')
        const tn = order.tracking_no ? `\nTracking: ${order.tracking_no}` : ''
        return ussdEnd(`Order ${order.order_no}\nGHS ${Number(order.total).toFixed(2)} - PAID\n\nStatus: ${d}${tn}\n\nQueries: 059 908 4552\nThank you!`)
      }
      if (order.status === 'Cancelled') return ussdEnd(`Order ${order.order_no} cancelled.\nCall: 059 908 4552`)
      const total = Number(order.total).toFixed(2)
      if (userData === '1') {
        // USSD dial-to-pay stays on NaloPay for now: Moolre requires OTP (TP14)
        // which can't be entered inside a USSD menu. POS uses Moolre (with the
        // cashier-entered OTP); website + USSD use NaloPay until Moolre enables
        // OTP removal on the account.
        let fp = phone.replace(/\s+/g, '').replace(/^0/, '233').replace(/^\+/, ''); if (!fp.startsWith('233')) fp = '233' + fp
        const ref = `USSD-${order.ussd_code}-${Date.now().toString(36).toUpperCase()}`; const num = fp.replace('233', ''); const naloPhone = '0' + num; const network = detectGhanaNetwork(naloPhone)
        const callbackUrl = `${SUPABASE_URL}/functions/v1/super-service?action=nalopay-callback` + (CALLBACK_SECRET ? `&s=${encodeURIComponent(CALLBACK_SECRET)}` : '')
        try {
          console.log(`NaloPay charge (USSD): phone=${naloPhone} amount=${total} network=${network} ref=${ref}`)
          const result = await nalopayCharge({ phone: naloPhone, amount: order.total, network, reference: ref, accountName: order.customer_name || 'Customer', description: `Order ${order.order_no}`, callbackUrl })
          const updateFields: Record<string, any> = { paystack_ref: ref, customer_phone: phone }; if (result.orderId) updateFields.nalopay_order_id = result.orderId
          await supabase.from('whatsapp_orders').update(updateFields).eq('id', order.id)
          if (sessionId) await supabase.from('ussd_sessions').delete().eq('session_id', sessionId)
          if (result.success) { try { await sendSMS(phone, `Hi ${order.customer_name || 'Customer'}, thank you for your order from BEDTIME BEDDINGS & HOME.\n\nOrder: ${order.order_no}\nTotal: GHS ${total}\n\nApprove the MoMo prompt on your phone with your PIN.\n\n059 908 4552`) } catch {}; return ussdEnd(`Approve the prompt on your phone to pay GHS ${total}. Thank you!`) }
          console.error('NaloPay error:', result.error, JSON.stringify(result.raw)); return ussdEnd(`Payment error.\nDial *920*141*${orderCode}# to retry.\nCall 059 908 4552`)
        } catch (e) { console.error('NaloPay exception:', e); if (sessionId) await supabase.from('ussd_sessions').delete().eq('session_id', sessionId); return ussdEnd(`Payment error.\nDial *920*141*${orderCode}# to retry.\nCall 059 908 4552`) }
      }
      if (userData === '2') { if (sessionId) await supabase.from('ussd_sessions').delete().eq('session_id', sessionId); return ussdEnd(`Cancelled.\nDial *920*141*${orderCode}# anytime.`) }
      const name = order.customer_name && order.customer_name !== order.customer_phone ? `\n${order.customer_name}` : ''; return ussdCon(`${SHOP}${name}\nOrder: ${order.order_no}\n\nTotal: GHS ${total}\n\n1. Pay Now\n2. Cancel`)
    }

    // ==================== NALOPAY CALLBACK (FIXED — handles JSON, form data, query params) ====================
    if (action === 'nalopay-callback') {
      if (!callbackAuthorised(url, req)) {
        console.error('Rejected unauthenticated nalopay-callback')
        return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: CORS })
      }
      let body: any = {}
      const rawBody = await req.text()
      console.log('NALOPAY CALLBACK RAW TEXT:', rawBody.substring(0, 500))
      try { body = JSON.parse(rawBody) } catch {
        try { body = Object.fromEntries(new URLSearchParams(rawBody)) } catch {}
      }
      for (const [k, v] of url.searchParams) { if (!body[k]) body[k] = v }
      console.log('NALOPAY CALLBACK PARSED:', JSON.stringify(body))

      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const ADMIN_PHONES = '0599084552'
      const d = body.data || body
      const ref = d.reference || d.client_reference || d.transaction_reference || body.reference || ''
      const naloOrderId = d.order_id || body.order_id || ''
      const status = String(d.status || d.transaction_status || body.status || '').toLowerCase()
      console.log(`NaloPay callback parsed: ref=${ref} naloOrderId=${naloOrderId} status=${status}`)
      const isPaidStatus = status === 'success' || status === 'completed' || status === 'paid' || status === 'successful'
      if (isPaidStatus && (ref || naloOrderId)) {
        let order: any = null
        if (ref) { const { data: o1 } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name,status,source,ussd_code').eq('paystack_ref', ref).limit(1); order = o1?.[0] }
        if (!order && naloOrderId) { const { data: o2 } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name,status,source,ussd_code').eq('nalopay_order_id', naloOrderId).limit(1); order = o2?.[0] }
        if (!order && ref.startsWith('USSD-')) { const ussdCode = ref.split('-')[1]; if (ussdCode) { const { data: o3 } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name,status,source,ussd_code').eq('ussd_code', parseInt(ussdCode)).eq('status', 'Pending').limit(1); order = o3?.[0] } }
        if (!order) { console.error('NaloPay callback: no matching order for ref=' + ref); return new Response(JSON.stringify({ success: true, note: 'order not found' }), { headers: { 'Content-Type': 'application/json' } }) }
        if (order.status === 'Paid' || order.status === 'Completed') { return new Response(JSON.stringify({ success: true, note: 'already paid' }), { headers: { 'Content-Type': 'application/json' } }) }
        // Walk-in orders are handed over in-shop, so payment = fully done -> Completed.
        // Web/WhatsApp orders await packaging -> Paid.
        const isWalkin = (order.source === 'walkin') || (!order.source && order.order_no.startsWith('POS-'))
        const newStatus = isWalkin ? 'Completed' : 'Paid'
        await supabase.from('whatsapp_orders').update({ status: newStatus, paid_at: new Date().toISOString() }).eq('id', order.id)
        try { await supabase.rpc('deduct_order_stock', { p_order_id: order.id }) } catch (e) { console.error('deduct_order_stock:', e) }
        console.log('Payment confirmed:', order.order_no, '->', newStatus)
        const amount = Number(order.total).toFixed(2); const firstName = (order.customer_name || 'Customer').split(' ')[0]
        // Walk-in: NO SMS here — the POS sends the single thank-you after payment.
        // Web/WhatsApp (delivery): notify admins to process + confirm to customer.
        if (!isWalkin) {
          try { await sendSMS(ADMIN_PHONES, `Online Payment! ${order.order_no} GHS ${amount}. ${order.customer_name || ''} ${order.customer_phone || ''}. Process & deliver ASAP.`) } catch {}
          if (order.customer_phone) { try { await sendSMS(order.customer_phone, `Hi ${firstName}, we have received your payment of GHS ${amount}.\n\nOrder: ${order.order_no}\n\nWe are preparing your order and will contact you shortly.\n\nCheck your order anytime: dial *920*141*${order.ussd_code}#\nCall us: 059 908 4552\n\nBEDTIME BEDDINGS & HOME`) } catch {} }
        }
      } else {
        console.log('NaloPay callback ignored: status=' + status)
        // Walk-in direct-prompt attempts that FAILED (customer rejected / timed
        // out) auto-cancel so they don't clutter the portal as Pending. Only for
        // POS- refs — web/USSD orders stay Pending so the customer can retry.
        if ((status === 'failed' || status === 'cancelled' || status === 'declined') && ref && ref.startsWith('POS-')) {
          try {
            const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
            await supabase.from('whatsapp_orders').update({ status: 'Cancelled', notes: 'Payment failed/declined (auto)' }).eq('paystack_ref', ref).eq('status', 'Pending')
            console.log('Auto-cancelled failed POS prompt:', ref)
          } catch {}
        }
      }
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } })
    }

    if (action === 'hubtel-callback') {
      if (!callbackAuthorised(url, req)) {
        console.error('Rejected unauthenticated hubtel-callback')
        return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: CORS })
      }
      const body = await req.json(); const supabase = createClient(SUPABASE_URL, SUPABASE_KEY); const ADMIN_PHONES = '0599084552'
      const ref = body.ClientReference || body.Data?.ClientReference || ''; const status = body.ResponseCode || body.Data?.ResponseCode || ''
      if (status === '0000' && ref) { const { data: o } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name').eq('paystack_ref', ref).single(); if (o) { await supabase.from('whatsapp_orders').update({ status: 'Paid', paid_at: new Date().toISOString() }).eq('id', o.id); const amount = Number(o.total).toFixed(2); try { await sendSMS(ADMIN_PHONES, `Payment received. ${o.order_no} GHS ${amount}. Process ASAP.`) } catch {}; if (o.customer_phone) { try { await sendSMS(o.customer_phone, `Hi ${o.customer_name || 'Customer'}, your payment of GHS ${amount} has been received.\n\nOrder: ${o.order_no}\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`) } catch {} } } }
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } })
    }

    if (action === 'reconcile-payments') {
      // Actively check recent PENDING orders against NaloPay and mark the ones that
      // actually paid. This catches payments where NaloPay's callback never arrived.
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      if (!NALOPAY_MERCHANT_ID || !NALOPAY_AUTH) return new Response(JSON.stringify({ success: false, error: 'NaloPay not configured' }), { headers: CORS })
      // Pending orders from the last 24h. Include ones with a NaloPay order id
      // (check by id) AND ones that were charged (have a USSD- ref) but whose
      // order id didn't save — we can still look those up by reference.
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
      const { data: pend } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name,status,source,nalopay_order_id,paystack_ref,ussd_code').eq('status', 'Pending').gte('date', since).limit(60)
      const pending = (pend || []).filter((o: any) => o.nalopay_order_id || (o.paystack_ref && String(o.paystack_ref).startsWith('USSD-')))
      if (pending.length === 0) return new Response(JSON.stringify({ success: true, checked: 0, confirmed: 0, message: 'No pending orders to reconcile' }), { headers: CORS })
      // One NaloPay token for all checks.
      let token = ''
      try {
        const tr = await fetch(NALOPAY_TOKEN_URL, { method: 'POST', headers: { 'Authorization': NALOPAY_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant_id: NALOPAY_MERCHANT_ID }) })
        const tt = await tr.text(); try { const tj = JSON.parse(tt); token = tj.data?.token || tj.token || '' } catch {}
      } catch {}
      if (!token) return new Response(JSON.stringify({ success: false, error: 'NaloPay token failed' }), { headers: CORS })
      let confirmed = 0; const results: string[] = []
      for (const o of pending) {
        try {
          // Need a NaloPay order id to query status. If we don't have one saved,
          // skip (can't verify) — the charge normally saves it.
          const naloId = o.nalopay_order_id
          if (!naloId) { results.push(`${o.order_no}: no nalopay id (awaiting dial)`); continue }
          const sr = await fetch('https://api.nalopay.com/clientapi/collection-status/', { method: 'POST', headers: { 'token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant_id: NALOPAY_MERCHANT_ID, order_id: naloId }) })
          const sd = await sr.json()
          console.log(`RECONCILE status for ${o.order_no} (naloId=${naloId}):`, JSON.stringify(sd))
          const rawStatus = sd.data?.status ?? sd.status ?? sd.data?.transaction_status ?? ''
          const st = String(rawStatus).toUpperCase()
          const paidWords = ['PAID', 'SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'APPROVED', 'CONFIRMED']
          const isPaid = paidWords.includes(st) || st === '0000' || st === '000' || sd.data?.paid === true
          if (isPaid) {
            const isWalkin = (o.source === 'walkin') || (!o.source && o.order_no.startsWith('POS-'))
            await supabase.from('whatsapp_orders').update({ status: isWalkin ? 'Completed' : 'Paid', paid_at: new Date().toISOString() }).eq('id', o.id)
            try { await supabase.rpc('deduct_order_stock', { p_order_id: o.id }) } catch (e) { console.error('deduct_order_stock:', e) }
            confirmed++; results.push(`${o.order_no}: ${st} -> ${isWalkin ? 'Completed' : 'Paid'}`)
            const amount = Number(o.total).toFixed(2); const firstName = (o.customer_name || 'Customer').split(' ')[0]
            if (!isWalkin) {
              try { await sendSMS('0599084552', `Online Payment! ${o.order_no} GHS ${amount}. Process & deliver ASAP.`) } catch {}
              if (o.customer_phone) { try { await sendSMS(o.customer_phone, `Hi ${firstName}, we have received your payment of GHS ${amount}.\n\nOrder: ${o.order_no}\n\nWe are preparing your order and will contact you shortly.\n\nCheck your order anytime: dial *920*141*${o.ussd_code}#\nCall us: 059 908 4552\n\nBEDTIME BEDDINGS & HOME`) } catch {} }
            }
          } else { results.push(`${o.order_no}: ${st || 'PENDING'} (raw: ${JSON.stringify(rawStatus)})`) }
        } catch (e) { results.push(`${o.order_no}: ERR ${(e as Error).message}`) }
      }
      return new Response(JSON.stringify({ success: true, checked: pending.length, confirmed, results }, null, 2), { headers: CORS })
    }

    if (action === 'thankyou-sms') {
      // Simple thank-you SMS sent to the customer AFTER a completed sale.
      try {
        const { phone } = await req.json()
        if (!phone) return new Response(JSON.stringify({ success: false, error: 'phone required' }), { headers: CORS })
        await sendSMS(phone, `Hi, thank you for shopping at BEDTIME BEDDINGS & HOME. We hope to see you next time. All the best.`)
        return new Response(JSON.stringify({ success: true }), { headers: CORS })
      } catch (e) { return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { headers: CORS }) }
    }

    if (action === 'nalopay-status') {
      const { reference, nalopayOrderId } = await req.json(); if (!reference && !nalopayOrderId) return new Response(JSON.stringify({ success: false, error: 'reference or nalopayOrderId required' }), { headers: CORS })
      if (!NALOPAY_MERCHANT_ID || !NALOPAY_API_KEY || !NALOPAY_AUTH) return new Response(JSON.stringify({ success: false, error: 'NaloPay not configured' }), { headers: CORS })
      const tokenRes = await fetch(NALOPAY_TOKEN_URL, { method: 'POST', headers: { 'Authorization': NALOPAY_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant_id: NALOPAY_MERCHANT_ID }) })
      const tokenData = await tokenRes.json(); const token = tokenData.data?.token || tokenData.token; if (!token) return new Response(JSON.stringify({ success: false, error: 'Token failed' }), { headers: CORS })
      let orderId = nalopayOrderId; if (!orderId && reference) { const supabase = createClient(SUPABASE_URL, SUPABASE_KEY); const { data } = await supabase.from('whatsapp_orders').select('nalopay_order_id').eq('paystack_ref', reference).limit(1); orderId = data?.[0]?.nalopay_order_id; if (!orderId) return new Response(JSON.stringify({ success: true, status: 'PENDING', note: 'Order not yet linked' }), { headers: CORS }) }
      const statusRes = await fetch('https://api.nalopay.com/clientapi/collection-status/', { method: 'POST', headers: { 'token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant_id: NALOPAY_MERCHANT_ID, order_id: orderId }) })
      const statusData = await statusRes.json(); const naloStatus = (statusData.data?.status || statusData.status || 'PENDING').toUpperCase()
      return new Response(JSON.stringify({ success: statusData.success === true, status: naloStatus, amount: statusData.data?.amount, raw: statusData }), { headers: CORS })
    }

    if (action === 'nalopay-charge') {
      const body = await req.json(); const { phone, amount, network, customerName, orderNo, orderId, description } = body
      if (!phone || !amount) return new Response(JSON.stringify({ success: false, error: 'Phone and amount required' }), { headers: CORS })
      let naloPhone = String(phone).replace(/\s+/g, '').replace(/^\+/, '').replace(/^0/, '233'); if (!naloPhone.startsWith('233')) naloPhone = '233' + naloPhone
      const net = (network as 'MTN' | 'AT' | 'TELECEL') || detectGhanaNetwork(naloPhone)
      const ref = body.reference || `ETR-WEB-${Date.now().toString(36).toUpperCase()}`
      const callbackUrl = `${SUPABASE_URL}/functions/v1/super-service?action=nalopay-callback` + (CALLBACK_SECRET ? `&s=${encodeURIComponent(CALLBACK_SECRET)}` : '')
      const result = await nalopayCharge({ phone: naloPhone, amount: Number(amount), network: net, reference: ref, accountName: customerName || 'Customer', description: description || `Order ${orderNo || ref}`, callbackUrl })
      if (!result.success) return new Response(JSON.stringify({ success: false, error: result.error || 'Charge failed', reference: ref }), { headers: CORS })
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      if (orderId) { const updateFields: Record<string, any> = { paystack_ref: ref, customer_phone: phone }; if (result.orderId) updateFields.nalopay_order_id = result.orderId; try { await supabase.from('whatsapp_orders').update(updateFields).eq('id', orderId) } catch {} }
      // No pre-payment SMS. The prompt is instant; the only SMS is the thank-you
      // sent AFTER payment is confirmed (see nalopay-status / reconcile).
      return new Response(JSON.stringify({ success: true, reference: ref, nalopayOrderId: result.orderId, otpCode: result.otpCode, status: result.status || 'PENDING', message: 'Prompt sent to the customer.' }), { headers: CORS })
    }

    if (action === 'upload-image') {
      // Upload a product image via the service role (always has write access,
      // so it doesn't depend on browser/anon RLS policies being perfect).
      // Body: { data: "<base64>", contentType: "image/jpeg", ext: "jpg" }
      try {
        const body = await req.json()
        const b64 = String(body.data || '').split(',').pop() || ''
        if (!b64) return new Response(JSON.stringify({ success: false, error: 'no image data' }), { headers: CORS })
        const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        if (bin.length < 50) return new Response(JSON.stringify({ success: false, error: 'image too small' }), { headers: CORS })
        const ct = String(body.contentType || 'image/jpeg')
        const ext = String(body.ext || (ct.split('/')[1] || 'jpg')).replace(/[^a-z0-9]/gi, '') || 'jpg'
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
        const path = `products/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
        const { error: upErr } = await supabase.storage.from('product-images').upload(path, bin, { cacheControl: '31536000', upsert: true, contentType: ct })
        if (upErr) return new Response(JSON.stringify({ success: false, error: upErr.message }), { headers: CORS })
        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/product-images/${path}`
        return new Response(JSON.stringify({ success: true, url: publicUrl }), { headers: CORS })
      } catch (e) { return new Response(JSON.stringify({ success: false, error: (e as Error).message }), { headers: CORS }) }
    }

    if (action === 'image-status') {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      // Check service key presence + list buckets so we can spot config problems.
      const hasServiceKey = !!SUPABASE_KEY && SUPABASE_KEY.length > 20
      let buckets: any = 'n/a'
      try { const { data: b } = await supabase.storage.listBuckets(); buckets = (b || []).map((x: any) => `${x.name}${x.public ? '(public)' : '(PRIVATE)'}`) } catch (e) { buckets = 'ERR ' + (e as Error).message }
      // Try a tiny test upload to prove write access.
      let uploadTest = 'n/a'
      try {
        const testBytes = new Uint8Array([137, 80, 78, 71])
        const { error: te } = await supabase.storage.from('product-images').upload(`_test/ping-${Date.now()}.bin`, testBytes, { upsert: true })
        uploadTest = te ? ('FAIL: ' + te.message) : 'OK (write works)'
      } catch (e) { uploadTest = 'ERR ' + (e as Error).message }
      const { data: all } = await supabase.from('products').select('id,name,image')
      const list = all || []
      const cloud = list.filter((p: any) => p.image && p.image.includes('res.cloudinary.com'))
      const supa = list.filter((p: any) => p.image && p.image.includes('/storage/v1/object/public/'))
      const empty = list.filter((p: any) => !p.image)
      const other = list.filter((p: any) => p.image && !p.image.includes('res.cloudinary.com') && !p.image.includes('/storage/v1/object/public/'))
      let supaFetch = 'n/a'
      if (supa[0]) { try { const t = await fetch(supa[0].image); supaFetch = `HTTP ${t.status} ${t.headers.get('content-type')}` } catch (e) { supaFetch = 'ERR ' + (e as Error).message } }
      // Test-fetch a Cloudinary image (the migration SOURCE) to see if it's alive.
      let cloudFetch = 'n/a', ikFetch = 'n/a'
      if (cloud[0]) {
        try { const c = await fetch(cloud[0].image); cloudFetch = `HTTP ${c.status} ${c.headers.get('content-type')}` } catch (e) { cloudFetch = 'ERR ' + (e as Error).message }
        try {
          const path = cloud[0].image.split('res.cloudinary.com/')[1]
          const ik = `https://ik.imagekit.io/bqikvsp59/${path}`
          const r = await fetch(ik); ikFetch = `HTTP ${r.status} ${r.headers.get('content-type')}`
        } catch (e) { ikFetch = 'ERR ' + (e as Error).message }
      }
      // Sample 8 different Cloudinary images through BOTH Cloudinary and ImageKit,
      // to find which (if any) source is serving the images that currently show.
      const probe: any[] = []
      for (const p of cloud.slice(0, 8)) {
        const row: any = { name: (p.name || '').slice(0, 20) }
        try { const c = await fetch(p.image); row.cloud = c.status } catch { row.cloud = 'ERR' }
        try { const path = p.image.split('res.cloudinary.com/')[1]; const r = await fetch(`https://ik.imagekit.io/bqikvsp59/${path}`); row.ik = r.status } catch { row.ik = 'ERR' }
        probe.push(row)
      }
      return new Response(JSON.stringify({
        hasServiceKey, buckets, uploadTest,
        total: list.length, onCloudinary: cloud.length, onSupabase: supa.length, empty: empty.length, other: other.length,
        sampleCloudinary: cloud[0]?.image || null, sampleSupabase: supa[0]?.image || null,
        cloudinaryFetchTest: cloudFetch, imagekitFetchTest: ikFetch, supabaseFetchTest: supaFetch,
        probe,
      }, null, 2), { headers: CORS })
    }

    if (action === 'migrate-images') {
      // Server-side image migration: Cloudinary -> Supabase storage. Runs with the
      // service role key (no CORS, full storage access). Processes a batch per call
      // so it never times out; call repeatedly until remaining = 0.
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const BATCH = 15
      const { data: products } = await supabase.from('products').select('id,name,image').ilike('image', '%res.cloudinary.com%').limit(BATCH)
      if (!products || products.length === 0) {
        const { count } = await supabase.from('products').select('id', { count: 'exact', head: true }).ilike('image', '%res.cloudinary.com%')
        return new Response(JSON.stringify({ success: true, done: 0, failed: 0, remaining: count || 0, message: 'No more Cloudinary images' }), { headers: CORS })
      }
      let done = 0, failed = 0; const errors: string[] = []
      for (const p of products) {
        try {
          const path0 = p.image.split('res.cloudinary.com/')[1] || ''
          // Try several sources — whatever the browser is successfully showing,
          // one of these should reach. Order: Cloudinary original, ImageKit
          // passthrough, ImageKit with a resize (may hit a cached thumbnail).
          const candidates = [
            p.image,
            path0 ? `https://ik.imagekit.io/bqikvsp59/${path0}` : '',
            path0 ? `https://ik.imagekit.io/bqikvsp59/${path0}?tr=w-800,f-auto` : '',
            path0 ? `https://ik.imagekit.io/bqikvsp59/${path0}?tr=w-1600` : '',
          ].filter(Boolean)
          let bytes: Uint8Array | null = null, ct = 'image/jpeg'
          for (const u of candidates) {
            try {
              const r = await fetch(u)
              if (r.ok) {
                const b = new Uint8Array(await r.arrayBuffer())
                if (b.length > 100) { bytes = b; ct = r.headers.get('content-type') || ct; break }
              }
            } catch {}
          }
          if (!bytes) throw new Error('unavailable from all sources')
          const ext = (ct.split('/')[1] || 'jpg').split('+')[0]
          const path = `products/${p.id}-${Date.now()}.${ext}`
          const { error: upErr } = await supabase.storage.from('product-images').upload(path, bytes, { cacheControl: '31536000', upsert: true, contentType: ct })
          if (upErr) throw upErr
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/product-images/${path}`
          await supabase.from('products').update({ image: publicUrl }).eq('id', p.id)
          done++
        } catch (e) { failed++; errors.push(`${(p.name||'').slice(0,15)}: ${(e as Error).message}`) }
      }
      const { count } = await supabase.from('products').select('id', { count: 'exact', head: true }).ilike('image', '%res.cloudinary.com%')
      return new Response(JSON.stringify({ success: true, done, failed, remaining: count || 0, errors: errors.slice(0, 5) }), { headers: CORS })
    }

    if (action === 'report') {
      const reportUrl = new URL(req.url); const type = reportUrl.searchParams.get('type') || ''; const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const ADMIN_PHONES = ['0599084552']; const fmt = (n: number) => 'GHS ' + Number(n || 0).toFixed(2); const dateStr = (d: Date) => d.toISOString().slice(0, 10)
      const getSales = async (from: string, to: string) => { const { data } = await supabase.from('sales').select('*').gte('date', from + 'T00:00:00').lte('date', to + 'T23:59:59').eq('voided', false); const s = data || []; return { revenue: s.reduce((a: number, x: any) => a + Number(x.total || 0), 0), profit: s.reduce((a: number, x: any) => a + Number(x.profit || 0), 0), cash: s.filter((x: any) => x.payment === 'Cash').reduce((a: number, x: any) => a + Number(x.total || 0), 0), momo: s.filter((x: any) => x.payment === 'Momo' || x.payment === 'Paystack').reduce((a: number, x: any) => a + Number(x.total || 0), 0), split: s.filter((x: any) => x.payment === 'Split').reduce((a: number, x: any) => a + Number(x.total || 0), 0), count: s.length, sales: s } }
      const getExpenses = async (from: string, to: string) => { const { data } = await supabase.from('expenses').select('*').gte('date', from + 'T00:00:00').lte('date', to + 'T23:59:59'); const e = data || []; return { total: e.reduce((a: number, x: any) => a + Number(x.amount || 0), 0), count: e.length } }
      const getWAOrders = async (from: string, to: string) => { const { data } = await supabase.from('whatsapp_orders').select('status,total').gte('date', from + 'T00:00:00').lte('date', to + 'T23:59:59'); const o = data || []; return { total: o.length, pending: o.filter((x: any) => x.status === 'Pending').length, paid: o.filter((x: any) => x.status === 'Paid').length, completed: o.filter((x: any) => x.status === 'Completed').length, cancelled: o.filter((x: any) => x.status === 'Cancelled').length, revenue: o.filter((x: any) => x.status === 'Paid' || x.status === 'Completed').reduce((a: number, x: any) => a + Number(x.total || 0), 0) } }
      const getLowStock = async () => { const { data } = await supabase.from('products').select('name,quantity').lte('quantity', 5).order('quantity', { ascending: true }).limit(10); return data || [] }
      const getTopSellers = (sales: any[]) => { const map: Record<string, { qty: number, rev: number }> = {}; for (const s of sales) { const items = typeof s.items === 'string' ? JSON.parse(s.items) : (s.items || []); for (const it of items) { const n = it.name || 'Unknown'; if (!map[n]) map[n] = { qty: 0, rev: 0 }; map[n].qty += Number(it.qty || 1); map[n].rev += Number(it.price || 0) * Number(it.qty || 1) } }; return Object.entries(map).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5) }
      let message = ''; const today = dateStr(new Date())
      if (type === 'daily' || type === 'morning') { const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); const yd = dateStr(yesterday); const dayName = yesterday.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }); const sales = await getSales(yd, yd); const expenses = await getExpenses(yd, yd); const wa = await getWAOrders(yd, yd); const topSellers = getTopSellers(sales.sales); const lowStock = await getLowStock(); message = `BEDTIME BEDDINGS & HOME\nDaily Report (${dayName})\n\nSALES\nRevenue: ${fmt(sales.revenue)}\nTotal Sales: ${sales.count}\nProfit: ${fmt(sales.profit)}\nNet: ${fmt(sales.profit - expenses.total)}\n\nPAYMENT\nCash: ${fmt(sales.cash)}\nMoMo: ${fmt(sales.momo)}\n`; if (sales.split > 0) message += `Split: ${fmt(sales.split)}\n`; message += `\nORDERS\nTotal: ${wa.total}\nPaid: ${wa.paid}\nPending: ${wa.pending}\nCompleted: ${wa.completed}\nRevenue: ${fmt(wa.revenue)}\n\nEXPENSES: ${fmt(expenses.total)} (${expenses.count})\n`; if (topSellers.length > 0) { message += `\nTOP SELLERS:\n`; topSellers.forEach(([n, d]: any, i: number) => { message += `${i+1}. ${n} (${d.qty})\n` }) }; message += `\n- BEDTIME BEDDINGS & HOME POS` }
      else if (type === 'afternoon' || type === 'today') { const sales = await getSales(today, today); const expenses = await getExpenses(today, today); const wa = await getWAOrders(today, today); message = `BEDTIME BEDDINGS & HOME\nToday So Far\n\nRevenue: ${fmt(sales.revenue)}\nSales: ${sales.count}\nProfit: ${fmt(sales.profit)}\n\nCash: ${fmt(sales.cash)}\nMoMo: ${fmt(sales.momo)}\n\nOrders: ${wa.total}\nPaid: ${wa.paid} | Pending: ${wa.pending}\nRevenue: ${fmt(wa.revenue)}\n\nExpenses: ${fmt(expenses.total)}\nNet: ${fmt(sales.profit - expenses.total)}\n\n- BEDTIME BEDDINGS & HOME POS` }
      else if (type === 'evening' || type === 'endofday') { const sales = await getSales(today, today); const expenses = await getExpenses(today, today); const wa = await getWAOrders(today, today); message = `BEDTIME BEDDINGS & HOME\nEnd of Day\n${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}\n\nRevenue: ${fmt(sales.revenue)}\nSales: ${sales.count}\nProfit: ${fmt(sales.profit)}\nExpenses: ${fmt(expenses.total)}\nNet: ${fmt(sales.profit - expenses.total)}\n\nCash: ${fmt(sales.cash)}\nMoMo: ${fmt(sales.momo)}\n\nOrders: ${wa.total}\nPaid: ${wa.paid} (${fmt(wa.revenue)})\nPending: ${wa.pending}\n\nWell done!\n- BEDTIME BEDDINGS & HOME POS` }
      else if (type === 'weekly') { const now = new Date(); const dow = now.getDay(); /* 0=Sun */ const sat = new Date(now); sat.setDate(now.getDate() - (dow === 0 ? 1 : dow + 1)); const mon = new Date(sat); mon.setDate(sat.getDate() - 5); const from = dateStr(mon), to = dateStr(sat); const sales = await getSales(from, to); const expenses = await getExpenses(from, to); const wa = await getWAOrders(from, to); const topSellers = getTopSellers(sales.sales); message = `BEDTIME BEDDINGS & HOME\nWEEKLY SUMMARY\n${mon.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${sat.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}\n\nRevenue: ${fmt(sales.revenue)}\nSales: ${sales.count}\nProfit: ${fmt(sales.profit)}\nExpenses: ${fmt(expenses.total)}\nNet: ${fmt(sales.profit - expenses.total)}\n\nCash: ${fmt(sales.cash)}\nMoMo: ${fmt(sales.momo)}\n\nOrders: ${wa.total}\nPaid: ${wa.paid} (${fmt(wa.revenue)})\nPending: ${wa.pending}\n`; if (topSellers.length > 0) { message += `\nBEST SELLERS:\n`; topSellers.forEach(([n, d]: any, i: number) => { message += `${i+1}. ${n} x${d.qty}\n` }) }; message += `\n- BEDTIME BEDDINGS & HOME POS` }
      else if (type === 'monthly') { const now = new Date(); const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1); const lastDay = new Date(now.getFullYear(), now.getMonth(), 0); const from = dateStr(firstDay), to = dateStr(lastDay); const monthName = firstDay.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); const sales = await getSales(from, to); const expenses = await getExpenses(from, to); const wa = await getWAOrders(from, to); message = `BEDTIME BEDDINGS & HOME\nMONTHLY\n${monthName}\n\nRevenue: ${fmt(sales.revenue)}\nSales: ${sales.count}\nProfit: ${fmt(sales.profit)}\nExpenses: ${fmt(expenses.total)}\nNet: ${fmt(sales.profit - expenses.total)}\n\nOrders: ${wa.total}\nPaid: ${wa.paid}\nRevenue: ${fmt(wa.revenue)}\n\n- BEDTIME BEDDINGS & HOME POS` }
      else if (type === 'test') { message = `BEDTIME BEDDINGS & HOME SMS Active!\n- daily\n- today\n- evening\n- weekly\n- monthly\n\n- BEDTIME BEDDINGS & HOME POS` }
      else { return new Response(JSON.stringify({ status: 'ok', usage: '?action=report&type=daily|today|evening|weekly|monthly|test' }), { headers: CORS }) }
      await sendSMS(ADMIN_PHONES.join(','), message); return new Response(JSON.stringify({ status: 'sent', type, recipients: ADMIN_PHONES, messageLength: message.length }), { headers: CORS })
    }

    if (action === 'remind') {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY); const now = Date.now()
      const { data: unpaid } = await supabase.from('whatsapp_orders').select('id,order_no,customer_name,customer_phone,total,ussd_code,date,notes').eq('status', 'Pending').order('date', { ascending: false }).limit(50)
      if (!unpaid?.length) return new Response(JSON.stringify({ status: 'no_pending_orders' }), { headers: CORS })
      let sent = 0
      for (const o of unpaid) {
        if (!o.customer_phone || !o.ussd_code) continue
        const mins = Math.floor((now - new Date(o.date).getTime()) / 60000); const notes = o.notes || ''; const firstName = (o.customer_name || 'Customer').split(' ')[0]; const amount = `GHS ${Number(o.total).toFixed(2)}`; const code = `*920*141*${o.ussd_code}#`
        let msg = ''
        if (mins >= 5 && mins < 25 && !notes.includes('[R1]')) { msg = `Hi ${firstName}, you're almost done! Complete your order of ${amount}.\n\nDial ${code} to pay now.\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`; await supabase.from('whatsapp_orders').update({ notes: notes + ' [R1]' }).eq('id', o.id) }
        else if (mins >= 30 && mins < 55 && !notes.includes('[R2]')) { msg = `Hi ${firstName}, your order ${o.order_no} (${amount}) is still waiting.\n\nDial ${code} to pay via MoMo.\n\nDon't miss out!\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`; await supabase.from('whatsapp_orders').update({ notes: notes + ' [R2]' }).eq('id', o.id) }
        else if (mins >= 60 && mins < 120 && !notes.includes('[R3]')) { msg = `Hi ${firstName}, friendly reminder. Your order ${o.order_no} (${amount}) is waiting.\n\nDial ${code} to complete payment.\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`; await supabase.from('whatsapp_orders').update({ notes: notes + ' [R3]' }).eq('id', o.id) }
        else if (mins >= 1440 && !notes.includes('[R4]')) { msg = `Hi ${firstName}, final reminder. Your order ${o.order_no} (${amount}) will be cancelled soon.\n\nDial ${code} to pay now.\n\nBEDTIME BEDDINGS & HOME\n059 908 4552`; await supabase.from('whatsapp_orders').update({ notes: notes + ' [R4]' }).eq('id', o.id) }
        if (msg) { try { await sendSMS(o.customer_phone, msg); sent++ } catch {} }
      }
      return new Response(JSON.stringify({ status: 'sent', reminders: sent, total_pending: unpaid.length }), { headers: CORS })
    }

    // ==================== RESEND SMS ====================
    if (action === 'resend-sms') {
      const orderNo = url.searchParams.get('order') || ''
      if (!orderNo) return new Response(JSON.stringify({ error: 'order param required' }), { headers: CORS })
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const { data: orders } = await supabase.from('whatsapp_orders').select('*').eq('order_no', orderNo).limit(1)
      const order = orders?.[0]
      if (!order) return new Response(JSON.stringify({ error: 'Order not found' }), { headers: CORS })
      if (!order.customer_phone) return new Response(JSON.stringify({ error: 'No phone on order' }), { headers: CORS })
      const amount = Number(order.total).toFixed(2)
      const firstName = (order.customer_name || 'Customer').split(' ')[0]
      const isPOS = order.order_no.startsWith('POS-') || order.order_no.startsWith('WA-')
      let msg = ''
      if (isPOS) {
        msg = `Thank you for shopping with us, ${firstName}!\n\nYour payment of GHS ${amount} has been received.\n\nWe appreciate your patronage.\n\nBEDTIME BEDDINGS & HOME\nMcCarthy Hills Junction, Accra\n059 908 4552\nwww.bedtimehome.com`
      } else {
        msg = `Hi ${firstName}, thank you for your purchase of GHS ${amount}!\n\nOrder: ${order.order_no}\n\nYour order has been confirmed and is being processed. Our delivery team will contact you shortly.\n\nTrack your order: bedtimehome.com/#/track\n\nBEDTIME BEDDINGS & HOME\n059 908 4552\nwww.bedtimehome.com`
      }
      await sendSMS(order.customer_phone, msg)
      // Also notify admins
      await sendSMS('0599084552', `Resent confirmation for ${order.order_no} GHS ${amount} to ${order.customer_phone}`)
      return new Response(JSON.stringify({ success: true, order: order.order_no, phone: order.customer_phone, message: 'SMS resent' }), { headers: CORS })
    }

    // ==================== SEND USSD CODE TO CUSTOMER (additive — texts the code on generate) ====================
    // Texts the customer the USSD shortcode the moment the cashier generates it.
    // Does NOT initiate or alter any charge — payment still happens when the
    // customer dials the code (handled by ?action=ussd) and is confirmed by
    // ?action=nalopay-callback. Reuses the existing sendSMS() and SHOP.
    if (action === 'send-ussd-code') {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      let payload: any = {}
      try { payload = await req.json() } catch {}
      const orderId = payload.orderId || payload.order_id || ''
      const orderNoIn = payload.orderNo || payload.order_no || ''
      if (!orderId && !orderNoIn) return new Response(JSON.stringify({ success: false, error: 'orderId or orderNo required' }), { headers: CORS })

      let q = supabase.from('whatsapp_orders').select('id,order_no,total,customer_name,customer_phone,ussd_code,status')
      q = orderId ? q.eq('id', orderId) : q.eq('order_no', orderNoIn)
      const { data: rows } = await q.limit(1)
      const order = rows?.[0]
      if (!order) return new Response(JSON.stringify({ success: false, error: 'Order not found' }), { headers: CORS })
      if (!order.customer_phone) return new Response(JSON.stringify({ success: false, error: 'No customer phone on order' }), { headers: CORS })
      if (!order.ussd_code) return new Response(JSON.stringify({ success: false, error: 'Order has no USSD code' }), { headers: CORS })

      const amount = Number(order.total).toFixed(2)
      const code = `*920*141*${order.ussd_code}#`
      const msg = `Hi, please dial ${code} to pay GHS ${amount} and complete your order. Thank you. ${SHOP}`
      try { await sendSMS(order.customer_phone, msg) } catch (e) { return new Response(JSON.stringify({ success: false, error: 'SMS failed: ' + (e as Error).message }), { headers: CORS }) }
      return new Response(JSON.stringify({ success: true, order: order.order_no, phone: order.customer_phone, code }), { headers: CORS })
    }

    // ==================== MOOLRE: INITIATE PAYMENT (instant USSD prompt) ====================
    // New provider. Pushes an approve-with-PIN prompt straight to the payer's phone.
    // Isolated & additive — does not touch NaloPay/Paystack. No OTP flow (direct prompt).
    if (action === 'moolre-charge') {
      if (!MOOLRE_USER || !MOOLRE_ACCOUNT) return new Response(JSON.stringify({ success: false, error: 'Moolre not configured (set MOOLRE_API_USER, MOOLRE_API_PUBKEY, MOOLRE_ACCOUNT_NUMBER as secrets)' }), { headers: CORS })
      let body: any = {}
      try { body = await req.json() } catch {}
      const { phone, amount, orderNo, orderId, otpcode } = body
      if (!phone || !amount) return new Response(JSON.stringify({ success: false, error: 'phone and amount required' }), { headers: CORS })

      // externalref rules (avoid TP13 'must be unique'):
      //  - OTP submission (otpcode present): reuse the SAME externalref the
      //    frontend got back on the first call, so Moolre matches the pending charge.
      //  - Fresh charge (no otpcode): always generate a UNIQUE ref (timestamped)
      //    so a retry on the same order never collides with a previous attempt.
      const externalref = otpcode
        ? (body.externalref || `${orderNo || 'POS'}`)
        : `${orderNo || 'POS'}-${Date.now().toString(36).toUpperCase()}`

      // link the ref to the order so the callback can find it (reuse paystack_ref).
      // Fresh charge generated a new unique ref -> update the order (matched by its
      // current paystack_ref = orderNo, or by id if provided).
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
        if (orderId) await supabase.from('whatsapp_orders').update({ paystack_ref: externalref, customer_phone: phone }).eq('id', orderId)
        else if (orderNo && !otpcode) await supabase.from('whatsapp_orders').update({ paystack_ref: externalref, customer_phone: phone }).eq('order_no', orderNo)
      } catch {}

      console.log(`MOOLRE POS charge: ${otpcode ? 'OTP-SUBMIT otp=' + otpcode : 'FIRST-CHARGE'} ref=${externalref} phone=${phone} amount=${amount}`)
      const result = await moolreCharge({ phone, amount, externalref, reference: `Order ${orderNo || externalref}`, otpcode })
      if (result.success) {
        return new Response(JSON.stringify({ success: true, reference: externalref, message: 'Prompt sent. Customer approves with MoMo PIN.' }), { headers: CORS })
      }
      // OTP was verified (TP17). The phone is now verified but the charge prompt
      // hasn't been sent. Make ONE follow-up call with the SAME externalref to
      // trigger the approve-with-PIN prompt.
      if ((result as any).otpVerifiedNeedsPrompt) {
        console.log('MOOLRE: TP17 verified — sending payment prompt (follow-up, same ref, no otp)')
        let followUp = await moolreCharge({ phone, amount, externalref, reference: `Order ${orderNo || externalref}` })
        console.log('MOOLRE follow-up result:', JSON.stringify({ success: followUp.success, code: followUp.code }))
        // If it verified again (TP17) instead of charging, that's success on the
        // verification but no prompt — treat as prompt-will-follow and let the
        // status poll / webhook confirm. If it now returns a normal success, great.
        if (followUp.success || (followUp as any).otpVerifiedNeedsPrompt) {
          return new Response(JSON.stringify({ success: true, reference: externalref, message: 'Payment prompt sent. Customer approves with MoMo PIN.' }), { headers: CORS })
        }
        if (followUp.otpRequired) return new Response(JSON.stringify({ success: false, otpRequired: true, reference: externalref, message: 'Please re-enter the OTP.' }), { headers: CORS })
        return new Response(JSON.stringify({ success: false, error: followUp.error || 'Could not send prompt after verification', code: followUp.code }), { headers: CORS })
      }
      if (result.otpRequired) {
        // First step done: Moolre SMSed an OTP to the customer. Frontend collects it and calls again with otpcode + same externalref.
        return new Response(JSON.stringify({ success: false, otpRequired: true, reference: externalref, message: 'An OTP has been sent to the customer by SMS. Enter it to complete payment.' }), { headers: CORS })
      }
      return new Response(JSON.stringify({ success: false, error: result.error || 'Charge failed', code: result.code }), { headers: CORS })
    }

    // ==================== MOOLRE: PAYMENT WEBHOOK (confirmation) ====================
    // Moolre POSTs here when a collection completes. Marks the order Paid and
    // sends the existing confirmation SMS. Mirrors the nalopay-callback shape.
    if (action === 'moolre-callback') {
      if (!callbackAuthorised(url, req)) {
        console.error('Rejected unauthenticated moolre-callback')
        return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401, headers: CORS })
      }
      let body: any = {}
      const rawBody = await req.text()
      console.log('MOOLRE CALLBACK RAW:', rawBody.substring(0, 500))
      try { body = JSON.parse(rawBody) } catch { try { body = Object.fromEntries(new URLSearchParams(rawBody)) } catch {} }
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const ADMIN_PHONES = '0599084552'
      const d = body.data || body
      const ok = String(body.status) === '1' || body.code === 'P01' || String(d.txstatus) === '1'
      const ref = d.externalref || body.externalref || d.reference || body.reference || ''
      if (!ok) { console.log('Moolre callback ignored:', body.code, body.status); return new Response(JSON.stringify({ success: true, note: 'not a success status' }), { headers: { 'Content-Type': 'application/json' } }) }
      if (!ref) { console.error('Moolre callback: no ref'); return new Response(JSON.stringify({ success: true, note: 'no ref' }), { headers: { 'Content-Type': 'application/json' } }) }

      const { data: rows } = await supabase.from('whatsapp_orders').select('id,order_no,total,customer_phone,customer_name,status,source,ussd_code').eq('paystack_ref', ref).limit(1)
      const order = rows?.[0]
      if (!order) { console.error('Moolre callback: no order for ref ' + ref); return new Response(JSON.stringify({ success: true, note: 'order not found' }), { headers: { 'Content-Type': 'application/json' } }) }
      if (order.status === 'Paid' || order.status === 'Completed') return new Response(JSON.stringify({ success: true, note: 'already paid' }), { headers: { 'Content-Type': 'application/json' } })

      const isWalkinM = (order.source === 'walkin') || (!order.source && order.order_no.startsWith('POS-'))
      await supabase.from('whatsapp_orders').update({ status: isWalkinM ? 'Completed' : 'Paid', paid_at: new Date().toISOString() }).eq('id', order.id)
      try { await supabase.rpc('deduct_order_stock', { p_order_id: order.id }) } catch {}
      const amount = Number(order.total).toFixed(2); const firstName = (order.customer_name || 'Customer').split(' ')[0]
      try { await sendSMS(ADMIN_PHONES, `Payment received (Moolre). ${order.order_no} GHS ${amount}. ${order.customer_phone || ''}`) } catch {}
      if (order.customer_phone) { try { await sendSMS(order.customer_phone, `Thank you for shopping with us, ${firstName}!\n\nYour payment of GHS ${amount} has been received.\n\nBEDTIME BEDDINGS & HOME\nMcCarthy Hills Junction, Accra\n059 908 4552`) } catch {} }
      console.log('Moolre payment confirmed:', order.order_no)
      return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } })
    }

    // ==================== MOOLRE: PAYMENT STATUS (poll fallback) ====================
    if (action === 'moolre-status') {
      if (!MOOLRE_USER || !MOOLRE_ACCOUNT) return new Response(JSON.stringify({ success: false, error: 'Moolre not configured' }), { headers: CORS })
      let body: any = {}
      try { body = await req.json() } catch {}
      const externalref = body.externalref || body.reference || ''
      if (!externalref) return new Response(JSON.stringify({ success: false, error: 'externalref required' }), { headers: CORS })
      try {
        const res = await fetch(`${MOOLRE_BASE}/open/transact/status`, {
          method: 'POST',
          headers: { 'X-API-USER': MOOLRE_USER, 'X-API-PUBKEY': MOOLRE_PUBKEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 1, idtype: '1', id: externalref, accountnumber: MOOLRE_ACCOUNT })
        })
        const d = await res.json()
        const txstatus = d?.data?.txstatus
        return new Response(JSON.stringify({ success: d.status === 1, paid: txstatus === 1, txstatus, raw: d }), { headers: CORS })
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: 'Status check failed: ' + (e as Error).message }), { headers: CORS })
      }
    }

    // ═══════════════ TIKTOK: OAuth ═══════════════
    if (action === 'tiktok-oauth-start') {
      if (!tiktokConfigured()) {
        return new Response(JSON.stringify({ success: false, error: 'TikTok is not configured on the server' }), { headers: CORS })
      }
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      let body: any = {}; try { body = await req.json() } catch (_) { /* GET */ }
      if (!(await requireAdmin(supabase, body.adminPin))) {
        return new Response(JSON.stringify({ success: false, error: 'Admin PIN is incorrect' }), { status: 403, headers: CORS })
      }
      // CSRF state, stored server-side and checked on the way back.
      const state = crypto.randomUUID()
      await supabase.from('social_connections').upsert({
        platform: 'tiktok', status: 'connecting', last_error: state, connected_by: body.actor || '',
      }, { onConflict: 'platform' })

      const url = new URL(TIKTOK_AUTH)
      url.searchParams.set('client_key', TIKTOK_CLIENT_KEY)
      url.searchParams.set('response_type', 'code')
      // user.info.basic = account name; video.publish = Direct Post (needs audit);
      // video.upload = land in the creator's drafts, which works pre-audit.
      url.searchParams.set('scope', 'user.info.basic,video.publish,video.upload')
      url.searchParams.set('redirect_uri', TIKTOK_REDIRECT_URI)
      url.searchParams.set('state', state)
      return new Response(JSON.stringify({ success: true, url: url.toString() }), { headers: CORS })
    }

    if (action === 'tiktok-oauth-callback') {
      // TikTok redirects the browser here. Respond with a page, not JSON.
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const code = url.searchParams.get('code') || ''
      const state = url.searchParams.get('state') || ''
      const page = (title: string, msg: string) => new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
         <meta name="viewport" content="width=device-width,initial-scale=1">
         <style>body{font-family:system-ui,sans-serif;background:#f6f6f5;color:#16181d;display:flex;
         min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
         .c{max-width:420px;text-align:center;background:#fff;padding:32px;border-radius:18px;
         border:1px solid rgba(0,0,0,.06)}h1{font-size:19px;margin:0 0 8px}p{color:#5f6163;font-size:14px;line-height:1.5}
         a{display:inline-block;margin-top:18px;background:#16181d;color:#fff;text-decoration:none;
         padding:12px 22px;border-radius:12px;font-weight:600;font-size:14px}</style></head>
         <body><div class="c"><h1>${title}</h1><p>${msg}</p>
         <a href="${APP_URL}/#/social">Back to the POS</a></div></body></html>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

      if (!code) return page('TikTok connection cancelled', 'No authorisation code was returned.')

      const { data: rows } = await supabase.from('social_connections').select('last_error,status').eq('platform', 'tiktok').limit(1)
      if (!state || rows?.[0]?.last_error !== state) {
        return page('Connection rejected', 'That authorisation request did not match one this POS started.')
      }

      const form = new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET,
        code, grant_type: 'authorization_code', redirect_uri: TIKTOK_REDIRECT_URI,
      })
      const tr = await fetch(TIKTOK_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form })
      const tj = await tr.json()
      if (!tj.access_token) {
        await socialAudit(supabase, { action: 'tiktok_connect', platform: 'tiktok', result: 'failed', detail: tj.error_description || 'token exchange failed' })
        return page('Could not connect TikTok', tj.error_description || 'TikTok did not return an access token.')
      }

      let accountName = ''
      try {
        const ur = await fetch(`${TIKTOK_USERINFO}?fields=display_name,open_id`, { headers: { Authorization: `Bearer ${tj.access_token}` } })
        const uj = await ur.json(); accountName = uj?.data?.user?.display_name || ''
      } catch (_) { /* display name is cosmetic */ }

      await supabase.from('social_connections').upsert({
        platform: 'tiktok', status: 'connected', account_name: accountName,
        account_id: tj.open_id || null, scopes: tj.scope || null,
        access_token: tj.access_token, refresh_token: tj.refresh_token || null,
        token_expires_at: new Date(Date.now() + (tj.expires_in || 86400) * 1000).toISOString(),
        connected_at: new Date().toISOString(), last_error: null,
      }, { onConflict: 'platform' })

      await socialAudit(supabase, { action: 'tiktok_connect', platform: 'tiktok', result: 'ok', detail: accountName })
      return page('TikTok connected', `${accountName || 'Your account'} is now linked to this POS.`)
    }

    if (action === 'tiktok-disconnect') {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      let body: any = {}; try { body = await req.json() } catch (_) {}
      if (!(await requireAdmin(supabase, body.adminPin))) {
        return new Response(JSON.stringify({ success: false, error: 'Admin PIN is incorrect' }), { status: 403, headers: CORS })
      }
      await supabase.from('social_connections').delete().eq('platform', 'tiktok')
      await socialAudit(supabase, { action: 'tiktok_disconnect', platform: 'tiktok', result: 'ok', actor: body.actor || '' })
      return new Response(JSON.stringify({ success: true }), { headers: CORS })
    }

    // ═══════════════ TIKTOK: publish ═══════════════
    if (action === 'tiktok-publish') {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      let body: any = {}; try { body = await req.json() } catch (_) {}
      if (!(await requireAdmin(supabase, body.adminPin))) {
        return new Response(JSON.stringify({ success: false, error: 'Admin PIN is incorrect' }), { status: 403, headers: CORS })
      }
      if (!tiktokConfigured()) {
        return new Response(JSON.stringify({ success: false, error: 'TikTok is not configured on the server' }), { headers: CORS })
      }

      // Idempotency (§19): only the caller that wins this claim may publish.
      // A refresh, retry, timeout or restarted worker loses and is told why.
      const { data: claim } = await supabase.rpc('claim_social_post', { p_post_id: body.postId })
      if (!claim?.claimed) {
        return new Response(JSON.stringify({
          success: false, alreadyPublished: !!claim?.alreadyPublished,
          error: claim?.alreadyPublished ? 'This post was already published' : `Post is ${claim?.reason}`,
        }), { headers: CORS })
      }
      const post = claim.post

      // Re-read stock at publish time (§25): never advertise something that
      // sold out between drafting and publishing.
      if (post.product_id) {
        const { data: prod } = await supabase.from('products').select('quantity,name').eq('id', post.product_id).limit(1)
        if ((prod?.[0]?.quantity ?? 0) <= 0) {
          await supabase.from('social_posts').update({ status: 'cancelled', error: 'Product sold out before publishing' }).eq('id', post.id)
          await socialAudit(supabase, { action: 'tiktok_publish', platform: 'tiktok', product_id: post.product_id, post_id: post.id, result: 'cancelled', detail: 'sold out' })
          return new Response(JSON.stringify({ success: false, error: 'Product sold out — publishing cancelled' }), { headers: CORS })
        }
      }

      const { token, error: tokErr } = await tiktokAccessToken(supabase)
      if (!token) {
        await supabase.from('social_posts').update({ status: 'failed', error: tokErr }).eq('id', post.id)
        return new Response(JSON.stringify({ success: false, error: tokErr }), { headers: CORS })
      }

      const media = Array.isArray(post.media) ? post.media : []
      const caption = [post.caption, post.hashtags].filter(Boolean).join('\n\n').slice(0, 2200)

      try {
        let initRes: any
        const isVideo = media[0]?.type === 'video'

        if (isVideo) {
          // FILE_UPLOAD deliberately, not PULL_FROM_URL: PULL_FROM_URL requires
          // TikTok to have verified ownership of the media's domain, and the
          // media lives on supabase.co which cannot be verified.
          const mr = await fetch(media[0].url)
          const blob = new Uint8Array(await mr.arrayBuffer())
          const init = await fetch(TIKTOK_INIT_VIDEO, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              post_info: { title: caption, privacy_level: 'SELF_ONLY', disable_comment: false },
              source_info: { source: 'FILE_UPLOAD', video_size: blob.length, chunk_size: blob.length, total_chunk_count: 1 },
            }),
          })
          initRes = await init.json()
          const uploadUrl = initRes?.data?.upload_url
          if (!uploadUrl) throw new Error(initRes?.error?.message || 'TikTok rejected the upload request')
          const up = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes 0-${blob.length - 1}/${blob.length}` },
            body: blob,
          })
          if (!up.ok) throw new Error(`Media upload failed (${up.status})`)
        } else {
          const urls = media.filter((m: any) => m?.url).map((m: any) => m.url).slice(0, 10)
          if (!urls.length) throw new Error('No media selected for this post')
          const init = await fetch(TIKTOK_INIT_PHOTO, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              post_info: { title: post.product_name || '', description: caption, privacy_level: 'SELF_ONLY' },
              source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: urls },
              post_mode: 'DIRECT_POST', media_type: 'PHOTO',
            }),
          })
          initRes = await init.json()
          if (initRes?.error?.code && initRes.error.code !== 'ok') {
            throw new Error(initRes.error.message || 'TikTok rejected the post')
          }
        }

        const publishId = initRes?.data?.publish_id
        if (!publishId) throw new Error('TikTok did not return a publish id')

        // Do NOT call this published yet. TikTok processes asynchronously, and
        // claiming success here would be exactly the false "Published" the
        // brief forbids. Status stays 'publishing' until the status endpoint
        // confirms it (see ?action=tiktok-status).
        await supabase.from('social_posts').update({
          external_post_id: publishId, error: null,
        }).eq('id', post.id)

        await socialAudit(supabase, { action: 'tiktok_publish', platform: 'tiktok', product_id: post.product_id, post_id: post.id, result: 'submitted', detail: publishId, actor: body.actor || '' })
        return new Response(JSON.stringify({ success: true, publishId, status: 'publishing' }), { headers: CORS })

      } catch (e) {
        const msg = (e as Error).message || 'Publishing failed'
        await supabase.from('social_posts').update({ status: 'failed', error: msg }).eq('id', post.id)
        await socialAudit(supabase, { action: 'tiktok_publish', platform: 'tiktok', product_id: post.product_id, post_id: post.id, result: 'failed', detail: msg, actor: body.actor || '' })
        return new Response(JSON.stringify({ success: false, error: msg }), { headers: CORS })
      }
    }

    // Poll TikTok for the real outcome. Only this marks a post Published.
    if (action === 'tiktok-status') {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
      const { data: pending } = await supabase.from('social_posts')
        .select('id,external_post_id,product_id')
        .eq('platform', 'tiktok').eq('status', 'publishing')
        .not('external_post_id', 'is', null).limit(20)

      const { token } = await tiktokAccessToken(supabase)
      if (!token) return new Response(JSON.stringify({ success: false, error: 'TikTok is not connected' }), { headers: CORS })

      let confirmed = 0, failed = 0
      for (const p of pending || []) {
        try {
          const r = await fetch(TIKTOK_STATUS, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ publish_id: p.external_post_id }),
          })
          const j = await r.json()
          const st = j?.data?.status
          if (st === 'PUBLISH_COMPLETE') {
            await supabase.from('social_posts').update({ status: 'published', published_at: new Date().toISOString() }).eq('id', p.id)
            await supabase.from('social_connections').update({ last_published_at: new Date().toISOString() }).eq('platform', 'tiktok')
            await socialAudit(supabase, { action: 'tiktok_published', platform: 'tiktok', product_id: p.product_id, post_id: p.id, result: 'ok', detail: p.external_post_id })
            confirmed++
          } else if (st === 'FAILED') {
            const reason = j?.data?.fail_reason || 'TikTok reported a failure'
            await supabase.from('social_posts').update({ status: 'failed', error: reason }).eq('id', p.id)
            await socialAudit(supabase, { action: 'tiktok_published', platform: 'tiktok', product_id: p.product_id, post_id: p.id, result: 'failed', detail: reason })
            failed++
          }
        } catch (_) { /* leave it publishing; the next poll retries */ }
      }
      return new Response(JSON.stringify({ success: true, checked: pending?.length || 0, confirmed, failed }), { headers: CORS })
    }

    return new Response(JSON.stringify({ error: 'Use ?action=initialize, charge, verify, ussd, webhook, report, remind, or resend-sms' }), { headers: CORS })
  } catch (e) {
    console.error('Error:', e)
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: CORS })
  }
})
