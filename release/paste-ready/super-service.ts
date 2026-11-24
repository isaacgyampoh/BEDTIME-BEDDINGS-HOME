// ===========================================================================
// super-service, on HOSTED SUPABASE, after cutover: a forwarder, nothing more.
//
// Bedtime moved to https://api.bedtimehome.com on 24 November 2026. Two kinds
// of request still arrive here and cannot be redirected from our side:
//
//   * NaloPay callbacks for charges begun BEFORE cutover. The callback URL was
//     baked into the charge at the time, pointing at this project.
//   * USSD requests, if the provider's configured endpoint still names this
//     project. That setting lives in NaloPay's dashboard, not in our code.
//
// THE PROBLEM WITH SERVING THEM HERE
//
// The old function still works, and that is precisely the danger: it would
// settle the order in THIS database, which nothing reads any more. The order
// would show paid here and unpaid on Contabo, stock would move in one place
// and not the other, and the two would drift with nothing to reconcile them.
// Returning an error instead is no better -- NaloPay would retry and then give
// up, and a customer's real payment would be lost.
//
// So every request is forwarded to Contabo and the reply passed back verbatim.
// There is exactly one source of truth, and the provider cannot tell the
// difference.
//
// WHY NO SECRET IS NEEDED HERE
//
// A NaloPay callback already carries `?s=<shared secret>`, and that secret is
// byte-identical on both backends (recovered from the Keychain and verified
// against this project's own SHA-256 digest before being installed on
// Contabo). Forwarding the query string unchanged therefore authenticates on
// arrival exactly as it would have here. This function holds no secret of its
// own and needs none.
//
// SAFETY NET
//
// If a forward fails, Contabo's btm-reconcile-payments job asks NaloPay for
// the status of every pending charge every five minutes, so a settlement
// cannot be lost by this function being unavailable -- only delayed.
//
// Deploy with:  migration-package/scripts/deploy-functions.sh super-service
// Roll back by redeploying release/rollback/super-service-v18-DEPLOYED.ts.
// ===========================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const TARGET = Deno.env.get('FORWARD_TO') || 'https://api.bedtimehome.com'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

/** The query string with the shared secret masked, for logging. */
function safeQuery(u: URL): string {
  return u.search.replace(/([?&]s=)[^&]*/g, '$1***REDACTED***')
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const inUrl = new URL(req.url)
  // Keep the path after the function name, so /super-service/foo still maps.
  const tail = inUrl.pathname.replace(/^\/+functions\/v1\/super-service/, '')
  const out = `${TARGET}/functions/v1/super-service${tail}${inUrl.search}`

  // The body is read once and reused, so a retry inside this function cannot
  // consume it twice.
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()

  // Pass the provider's own headers through, minus the ones that must not be
  // copied: Host would name the wrong server, and the hop-by-hop encoding
  // headers would describe a body we have already decoded.
  const headers = new Headers()
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase()
    if (key === 'host' || key === 'content-length' || key === 'connection' ||
        key === 'transfer-encoding' || key === 'accept-encoding') continue
    headers.set(k, v)
  }
  headers.set('x-forwarded-from', 'supabase-wqkgfvmvuljzexhevlnp')

  console.log(`FORWARD ${req.method} ${inUrl.pathname}${safeQuery(inUrl)} -> ${TARGET}`)

  // One retry, because a single network hiccup should not lose a settlement.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(out, { method: req.method, headers, body })
      const text = await res.text()
      console.log(`FORWARD result ${res.status} (attempt ${attempt}), ${text.length} bytes`)
      const outHeaders = new Headers(CORS)
      outHeaders.set('Content-Type', res.headers.get('Content-Type') || 'application/json')
      outHeaders.set('x-forwarded-to', 'api.bedtimehome.com')
      return new Response(text, { status: res.status, headers: outHeaders })
    } catch (e) {
      console.error(`FORWARD attempt ${attempt} failed:`, e instanceof Error ? e.message : String(e))
      if (attempt === 2) {
        // 503 rather than 200: the provider should retry, and
        // btm-reconcile-payments will pick it up regardless.
        return new Response(
          JSON.stringify({ success: false, error: 'Bedtime has moved; forwarding failed. Retry.' }),
          { status: 503, headers: { ...CORS, 'Content-Type': 'application/json' } },
        )
      }
    }
  }
  // Unreachable; present so every path returns a Response.
  return new Response(JSON.stringify({ success: false }), { status: 503, headers: CORS })
})
