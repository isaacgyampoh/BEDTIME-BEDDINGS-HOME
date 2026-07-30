// ============================================================
// BEDTIME BEDDINGS & HOME — WhatsApp AI Sales Agent
// Receives WaSender webhooks, thinks with OpenAI (human-like sales rep),
// looks up real inventory, creates orders, and replies via WaSender.
// Fully automatic; flags the owner only when needed.
// ============================================================
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://wqkgfvmvuljzexhevlnp.supabase.co'
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') || ''
const WASENDER_KEY = Deno.env.get('WASENDER_API_KEY') || ''
const OWNER_PHONE = Deno.env.get('OWNER_PHONE') || '233599084552'  // owner alerts

const SHOP = 'BEDTIME BEDDINGS & HOME'
const SHOP_PHONE = '059 908 4552'
const USSD_PREFIX = '*920*141*'   // NaloPay USSD; order code appended

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Content-Type': 'application/json' }

const sb = () => createClient(SUPABASE_URL, SUPABASE_KEY)

// ---- WaSender: send a WhatsApp message -------------------------------------
async function waSend(to: string, text: string) {
  try {
    const r = await fetch('https://wasenderapi.com/api/send-message', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WASENDER_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text })
    })
    const d = await r.text()
    console.log(`WaSend -> ${to}: ${r.status} ${d.substring(0, 120)}`)
    return r.ok
  } catch (e) { console.log('WaSend error:', e); return false }
}

// ---- The agent's persona + rules -------------------------------------------
function systemPrompt(ctx: { name: string; summary: string; stage: string; catalog: string; promos: string }) {
  return `You are a warm, friendly human sales assistant for ${SHOP}, a Ghanaian bedding & home shop. You chat with customers on WhatsApp.

TALK LIKE A REAL GHANAIAN SALES REP — not a robot:
- Warm and natural: "Hi! Good morning 😊", "Ah okay, no problem", "Sure, let me check for you".
- Short WhatsApp-style messages, not essays. One or two lines usually.
- Never say you are an AI, bot, or assistant. You are a person working at the shop.
- Match the customer's energy and language (some mix English + Twi/Pidgin — that's fine, keep it light).

WHAT YOU KNOW (only quote from THIS — never invent products, prices, or stock):
CATALOG (name | price GHS | in stock):
${ctx.catalog || '(catalog will be provided)'}
${ctx.promos ? 'CURRENT PROMOS:\n' + ctx.promos : ''}

HOW YOU SELL:
- If they ask about a product, find it in the catalog and give the real price. If it's not in the catalog, say you'll check with the team and use flag_human.
- If they send a photo, you can't see product details reliably — ask them kindly what it's called or to describe it, then match it to the catalog.
- When they're ready to buy, confirm the items + total, then give payment instructions using create_order (it returns the USSD code). Tell them: dial the code; if the prompt doesn't pop up, check their MoMo app's Approvals/Pending and approve there.
- After they confirm payment, ask for delivery details (name, location/area, landmark, phone). Once they send details, use save_delivery so the shop can package. Then reassure them it's being processed.
- Be honest. Never promise stock you can't see. Never make up delivery times — say "our team will confirm delivery with you".

WHEN TO FLAG THE OWNER (use flag_human):
- A complaint, refund request, or upset customer.
- They want something not in the catalog.
- Anything about money that seems off, or a large/wholesale order.
- If you're unsure. It's better to flag than to guess.

CONTEXT ABOUT THIS CUSTOMER:
Name: ${ctx.name || 'unknown'}
What you know about them: ${ctx.summary || 'first time chatting'}
Current stage: ${ctx.stage}

Keep it human, helpful, and honest. Your goal is to help them and close the sale naturally.`
}

// ---- Tools the agent can call ----------------------------------------------
const TOOLS = [
  { type: 'function', function: {
    name: 'search_products', description: 'Search the shop inventory by name/keyword to get real prices and stock. Use whenever a customer asks about a product.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'product name or keywords' } }, required: ['query'] }
  }},
  { type: 'function', function: {
    name: 'create_order', description: 'Create an order once the customer has confirmed what they want to buy. Returns the USSD payment code to give them.',
    parameters: { type: 'object', properties: {
      items: { type: 'array', description: 'items to buy', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' }, price: { type: 'number' } }, required: ['name','qty','price'] } },
      customer_name: { type: 'string' }
    }, required: ['items'] }
  }},
  { type: 'function', function: {
    name: 'save_delivery', description: 'Save the delivery details the customer provided, onto their most recent order, so the shop can package and deliver.',
    parameters: { type: 'object', properties: { address: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string' } }, required: ['address'] }
  }},
  { type: 'function', function: {
    name: 'flag_human', description: 'Flag this chat for the shop owner to handle personally (complaints, unusual requests, out-of-catalog items, anything you are unsure about).',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }
  }},
]

// ---- Tool implementations ---------------------------------------------------
async function runTool(name: string, args: any, phone: string, conv: any) {
  const db = sb()
  if (name === 'search_products') {
    const { data } = await db.from('products').select('name,price,quantity,category').ilike('name', `%${args.query}%`).limit(8)
    if (!data || data.length === 0) return { found: false, message: 'No matching products in stock.' }
    return { found: true, products: data.map((p: any) => ({ name: p.name, price: p.price, in_stock: (p.quantity || 0) > 0, qty: p.quantity })) }
  }
  if (name === 'create_order') {
    const items = args.items || []
    const total = items.reduce((s: number, it: any) => s + (Number(it.price) * Number(it.qty)), 0)
    // next USSD code
    const { data: mc } = await db.from('whatsapp_orders').select('ussd_code').order('ussd_code', { ascending: false }).limit(1)
    const uc = (mc?.[0]?.ussd_code || 50000) + 1
    const orderNo = 'WA-' + Date.now().toString(36).toUpperCase()
    const { data: ins } = await db.from('whatsapp_orders').insert({
      order_no: orderNo, date: new Date().toISOString(),
      customer_name: args.customer_name || conv.customer_name || phone,
      customer_phone: phone, items: JSON.stringify(items), subtotal: total, total,
      status: 'Pending', ussd_code: uc, paystack_ref: orderNo, source: 'whatsapp', details_filled: false,
    }).select('id').single()
    await db.from('wa_conversations').update({ stage: 'awaiting_payment', last_order_no: orderNo }).eq('phone', phone)
    return { order_no: orderNo, total: total.toFixed(2), ussd_code: `${USSD_PREFIX}${uc}#`,
      instructions: `Tell the customer: to pay GHS ${total.toFixed(2)}, dial ${USSD_PREFIX}${uc}# . If the prompt doesn't pop up, open their MoMo app, go to Approvals/Pending, and approve it there.` }
  }
  if (name === 'save_delivery') {
    const orderNo = conv.last_order_no
    if (!orderNo) return { saved: false, message: 'No recent order to attach delivery to.' }
    await db.from('whatsapp_orders').update({
      address: args.address, customer_name: args.name || conv.customer_name || undefined,
      notes: `DELIVERY: ${args.address}${args.notes ? ' | ' + args.notes : ''}`, details_filled: true,
    }).eq('order_no', orderNo)
    await db.from('wa_conversations').update({ stage: 'done' }).eq('phone', phone)
    // Alert the owner that an order is ready to package
    await waSend(OWNER_PHONE, `📦 New WhatsApp order ready to package.\nOrder: ${orderNo}\nDeliver to: ${args.address}\nCustomer: ${args.name || conv.customer_name || phone}`)
    return { saved: true, message: 'Delivery saved. The shop will package and deliver.' }
  }
  if (name === 'flag_human') {
    await db.from('wa_conversations').update({ needs_human: true, flag_reason: args.reason }).eq('phone', phone)
    await waSend(OWNER_PHONE, `🔔 A WhatsApp chat needs you.\nFrom: ${conv.customer_name || phone}\nReason: ${args.reason}\nReply them directly on WhatsApp.`)
    return { flagged: true, message: 'Owner has been notified and will help. Tell the customer someone will assist shortly.' }
  }
  return { error: 'unknown tool' }
}

// ---- Build catalog + promos text for the prompt ----------------------------
async function loadCatalog() {
  const db = sb()
  const { data: prods } = await db.from('products').select('name,price,quantity').order('name').limit(120)
  const catalog = (prods || []).map((p: any) => `${p.name} | ${Number(p.price).toFixed(2)} | ${(p.quantity||0) > 0 ? 'yes ('+p.quantity+')' : 'out of stock'}`).join('\n')
  const { data: promos } = await db.from('promos').select('name,description').eq('active', true).limit(10)
  const promoTxt = (promos || []).map((p: any) => `${p.name}${p.description ? ' — ' + p.description : ''}`).join('\n')
  return { catalog, promos: promoTxt }
}

// ---- Call OpenAI with tools (loop until it produces a text reply) ----------
async function think(phone: string, conv: any, history: any[]) {
  const { catalog, promos } = await loadCatalog()
  const messages: any[] = [
    { role: 'system', content: systemPrompt({ name: conv.customer_name, summary: conv.summary, stage: conv.stage, catalog, promos }) },
    ...history,
  ]
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.7, max_tokens: 400 })
    })
    const j = await r.json()
    if (!j.choices) { console.log('OpenAI error:', JSON.stringify(j).substring(0, 300)); return "Hi! Thanks for your message 😊 One moment please." }
    const msg = j.choices[0].message
    messages.push(msg)
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
        const result = await runTool(tc.function.name, args, phone, conv)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
      }
      continue // let the model use the tool result to form its reply
    }
    return msg.content || "Okay 😊"
  }
  return "Let me get back to you on that shortly 😊"
}

// ---- Main webhook handler ---------------------------------------------------
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const url = new URL(req.url)

  // Health check
  if (url.searchParams.get('action') === 'ping') return new Response(JSON.stringify({ ok: true, agent: SHOP }), { headers: CORS })

  // Follow-ups (call on a schedule, e.g. every 2 hours via cron)
  if (url.searchParams.get('action') === 'follow-ups') {
    const db = sb()
    const results: string[] = []
    // 1) Unpaid orders: pending 2–48h old, remind once via WhatsApp.
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const until = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const { data: unpaid } = await db.from('whatsapp_orders')
      .select('order_no,customer_phone,customer_name,total,ussd_code,followed_up')
      .eq('status', 'Pending').gte('date', since).lte('date', until).limit(30)
    for (const o of (unpaid || [])) {
      if (o.followed_up || !o.customer_phone) continue
      const name = (o.customer_name || '').split(' ')[0] || 'there'
      const msg = `Hi ${name}, just following up on your order ${o.order_no} from ${SHOP} 😊 It's still waiting for payment. To pay GHS ${Number(o.total).toFixed(2)}, dial ${USSD_PREFIX}${o.ussd_code}# — if the prompt doesn't show, check your MoMo app's Approvals and approve there. Need any help? Just reply here.`
      await waSend(o.customer_phone.replace(/[^0-9]/g, '').replace(/^0/, '233'), msg)
      await db.from('whatsapp_orders').update({ followed_up: true }).eq('order_no', o.order_no)
      results.push(`unpaid:${o.order_no}`)
    }
    // 2) Quiet chats: customer went silent after we replied, 3–24h ago, nudge once.
    const qSince = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const qUntil = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    const { data: quiet } = await db.from('wa_conversations')
      .select('phone,customer_name,stage,followed_up,last_agent_at,last_message_at,agent_enabled,needs_human')
      .eq('followed_up', false).eq('agent_enabled', true).eq('needs_human', false)
      .in('stage', ['chatting', 'quoted']).gte('last_agent_at', qSince).lte('last_agent_at', qUntil).limit(30)
    for (const c of (quiet || [])) {
      // only if the LAST message was from us (they didn't reply)
      if (new Date(c.last_message_at) > new Date(c.last_agent_at)) continue
      const name = (c.customer_name || '').split(' ')[0] || 'there'
      const msg = `Hi ${name}, just checking in 😊 Are you still interested? Happy to help you with anything from ${SHOP}. Just let me know!`
      await waSend(c.phone, msg)
      await db.from('wa_conversations').update({ followed_up: true }).eq('phone', c.phone)
      await db.from('wa_messages').insert({ phone: c.phone, role: 'assistant', content: msg })
      results.push(`quiet:${c.phone}`)
    }
    return new Response(JSON.stringify({ ok: true, sent: results.length, results }), { headers: CORS })
  }

  try {
    const db = sb()
    const body = await req.json().catch(() => ({}))
    console.log('WA webhook:', JSON.stringify(body).substring(0, 400))

    // Master switch
    const { data: setting } = await db.from('wa_agent_settings').select('value').eq('key', 'agent_master_enabled').single()
    if (setting && setting.value !== 'true') return new Response(JSON.stringify({ ok: true, note: 'agent disabled' }), { headers: CORS })

    // Parse WaSender inbound message shape
    if (body.event !== 'messages.received' && body.event !== 'messages.upsert') {
      return new Response(JSON.stringify({ ok: true, ignored: body.event }), { headers: CORS })
    }
    const m = body.data?.messages
    if (!m || m.key?.fromMe) return new Response(JSON.stringify({ ok: true, note: 'skip own/empty' }), { headers: CORS })

    const phone = (m.key?.cleanedSenderPn || m.key?.senderPn || m.key?.remoteJid || '').replace(/[^0-9]/g, '')
    if (!phone) return new Response(JSON.stringify({ ok: true, note: 'no phone' }), { headers: CORS })
    const text = m.messageBody || m.message?.conversation || m.message?.extendedTextMessage?.text || ''
    const mediaUrl = m.message?.imageMessage?.url || ''
    const waId = m.key?.id || ''

    // Dedupe (WaSender can resend)
    if (waId) {
      const { data: dup } = await db.from('wa_messages').select('id').eq('wa_message_id', waId).limit(1)
      if (dup && dup.length) return new Response(JSON.stringify({ ok: true, note: 'dup' }), { headers: CORS })
    }

    // Load or create conversation (memory)
    let { data: conv } = await db.from('wa_conversations').select('*').eq('phone', phone).single()
    if (!conv) {
      const { data: nc } = await db.from('wa_conversations').insert({ phone, last_message_at: new Date().toISOString() }).select('*').single()
      conv = nc
    }

    // If a human has taken over this chat, stay silent
    if (conv.agent_enabled === false) {
      await db.from('wa_messages').insert({ phone, role: 'user', content: text, media_url: mediaUrl, wa_message_id: waId })
      return new Response(JSON.stringify({ ok: true, note: 'human handling' }), { headers: CORS })
    }

    // Log the incoming message
    const userContent = text || (mediaUrl ? '[customer sent an image]' : '[message]')
    await db.from('wa_messages').insert({ phone, role: 'user', content: userContent, media_url: mediaUrl, wa_message_id: waId })
    await db.from('wa_conversations').update({ last_message_at: new Date().toISOString(), followed_up: false }).eq('phone', phone)

    // Build recent history for the model
    const { data: hist } = await db.from('wa_messages').select('role,content').eq('phone', phone).order('created_at', { ascending: false }).limit(16)
    const history = (hist || []).reverse().map((h: any) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }))

    // Think + reply
    const reply = await think(phone, conv, history)
    await waSend(phone, reply)
    await db.from('wa_messages').insert({ phone, role: 'assistant', content: reply })
    await db.from('wa_conversations').update({ last_agent_at: new Date().toISOString() }).eq('phone', phone)

    return new Response(JSON.stringify({ ok: true }), { headers: CORS })
  } catch (e) {
    console.log('Agent error:', e)
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { headers: CORS })
  }
})
