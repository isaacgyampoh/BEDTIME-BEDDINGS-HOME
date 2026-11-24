/**
 * The image store, as a Cloudflare Worker in front of an R2 bucket.
 *
 * WHY A WORKER AND NOT DIRECT R2 ACCESS
 * The POS and the shop front are static sites with no server of their own, so
 * there is nowhere in them that an R2 access key could live without being
 * shipped to every browser. A Worker with an R2 *binding* has no key at all:
 * the binding is granted by the platform at the edge, so the credential never
 * exists in a form that can leak. That is the whole reason this file exists
 * rather than the apps talking to R2 with the S3 API.
 *
 * WHAT IT DOES
 *   GET    /img/<path>     public read, cached at the edge
 *   PUT    /img/<path>     upload, requires the staff secret
 *   DELETE /img/<path>     delete, requires the staff secret
 *   GET    /health         is the binding wired up
 *
 * Thumbnails are NOT generated here. Supabase's transform endpoint bills per
 * origin image per month, and paying Cloudflare for resizing instead would
 * only move the bill. (An earlier note here said the organisation was 553
 * against an allowance of 100; that came from the dashboard and the
 * Management API exposes no usage endpoint, so treat it as indicative.) The apps
 * resize in the browser before uploading (src/lib/productImage.js), which
 * costs nothing, uploads faster on a slow connection, and means the stored
 * file is already the size that gets served.
 */

// The deployment-account installer, bundled as text at build time from its
// canonical copy in the repository. Importing it means the script served by
// /deploy-access and the script reviewed in git cannot drift apart.
import INSTALLER from '../deploy/access/install-deploy-account.sh'

const CORS = (origin, allowed) => ({
  'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Upload-Token',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
})

/** Only these types, so the bucket cannot be used to host anything else. */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
const MAX_BYTES = 8 * 1024 * 1024

/**
 * Constant-time compare, so a wrong token cannot be guessed a character at a
 * time from how long the answer takes.
 */
/**
 * Is this request from a signed-in member of shop staff?
 *
 * WHY THIS EXISTS
 * The POS is a static site. An upload secret placed in it would be shipped to
 * every browser that loads the page, which is the whole reason uploads used to
 * go through Supabase Storage instead of here. So the browser presents the
 * GoTrue session it already has, and this verifies it.
 *
 * NO SECRET IS INVOLVED, on either side. The project signs tokens with an
 * ES256 key and publishes the PUBLIC half at /auth/v1/.well-known/jwks.json,
 * so verification needs nothing confidential: not in the browser, not here.
 *
 * Checked: the signature against the published key, `exp`, and the presence of
 * app_metadata.staff_id -- the claim super-service's staff-login puts on a
 * staff session after a correct PIN. A customer token, an anon key or an
 * expired staff token all fail.
 */
let JWKS_CACHE = { at: 0, keys: null }

async function jwks(env) {
  const now = Date.now()
  if (JWKS_CACHE.keys && now - JWKS_CACHE.at < 3600_000) return JWKS_CACHE.keys
  const base = (env.AUTH_BASE || env.ORIGIN_BASE || '').replace(/\/+$/, '')
  if (!base) return null
  const r = await fetch(`${base}/auth/v1/.well-known/jwks.json`, { cf: { cacheTtl: 3600 } })
  if (!r.ok) return null
  const d = await r.json()
  if (!Array.isArray(d.keys) || !d.keys.length) return null
  JWKS_CACHE = { at: now, keys: d.keys }
  return d.keys
}

const b64u = (s) => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function staffFromToken(token, env) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return null
    const header = JSON.parse(new TextDecoder().decode(b64u(parts[0])))
    if (header.alg !== 'ES256') return null          // only the published alg
    const keys = await jwks(env)
    if (!keys) return null
    const jwk = keys.find((k) => k.kid === header.kid) || keys[0]
    if (!jwk || jwk.kty !== 'EC') return null

    const key = await crypto.subtle.importKey(
      'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])

    // JOSE ES256 signatures are raw r||s, which is what Web Crypto expects.
    const sig = b64u(parts[2])
    if (sig.length !== 64) return null
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed))) return null

    const claims = JSON.parse(new TextDecoder().decode(b64u(parts[1])))
    if (!claims.exp || claims.exp * 1000 <= Date.now()) return null
    const staffId = claims?.app_metadata?.staff_id
    if (!staffId) return null
    return { id: String(staffId), name: claims?.app_metadata?.staff_name || '' }
  } catch {
    return null
  }
}

function secretsMatch(a, b) {
  const x = new TextEncoder().encode(String(a || ''))
  const y = new TextEncoder().encode(String(b || ''))
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

/**
 * A path that cannot escape its prefix or collide with another product's file.
 * Rejects traversal, absolute paths, and anything but the characters the app
 * actually generates.
 */
function safePath(raw) {
  const p = decodeURIComponent(String(raw || '')).replace(/^\/+/, '')
  if (!p) return null
  if (p.includes('..') || p.includes('//') || p.startsWith('/')) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/.test(p)) return null
  if (!/^(products|invoices|promos)\//.test(p)) return null
  return p
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') || ''
    const allowed = String(env.ALLOWED_ORIGINS || 'https://bedtimehome.com')
      .split(',').map(s => s.trim()).filter(Boolean)
    const cors = CORS(origin, allowed)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })

    if (url.pathname === '/health') {
      const ok = !!env.IMAGES
      return Response.json({ ok, bucket: ok ? 'bound' : 'MISSING' }, { status: ok ? 200 : 500, headers: cors })
    }

    // ── /deploy-access?p=<project> ───────────────────────────────────────
    // Serves the deployment-account installer as plain text, with that
    // project's PUBLIC key substituted in, so establishing access on a server
    // we can only reach through a provider's web console is one short line
    // typed at that console instead of eighty characters of base64.
    //
    // Nothing secret is served. An SSH public key is public by definition,
    // and the script it returns only ever ADDS a per-project account -- it
    // cannot read anything, and running it anywhere else is inert. The
    // canonical, reviewable copy is deploy/access/install-deploy-account.sh
    // in the repository; this route serves that same file.
    //
    // Reusable: a new project is one more entry in DEPLOY_KEYS.
    // /da/<project> is the short form, so the line typed at a provider's web
    // console -- often without a working clipboard -- stays under 80
    // characters. A path segment rather than ?p= means no shell quoting is
    // needed either, since ? is a glob character.
    if (url.pathname === '/deploy-access' || url.pathname.startsWith('/da/')) {
      const project = (url.pathname.startsWith('/da/')
        ? url.pathname.slice('/da/'.length)
        : (url.searchParams.get('p') || '')).trim()
      if (!/^[a-z0-9-]{2,32}$/.test(project)) {
        return new Response('# bad or missing ?p=<project>\n', { status: 400, headers: { 'Content-Type': 'text/plain' } })
      }
      let keys = {}
      try { keys = JSON.parse(env.DEPLOY_KEYS || '{}') } catch { keys = {} }
      const pub = keys[project]
      if (!pub) {
        return new Response(`# no deployment key registered for '${project}'\n`, { status: 404, headers: { 'Content-Type': 'text/plain' } })
      }
      const script = INSTALLER.replace('__PUBKEY__', pub).replace('__PROJECT__', project)
      return new Response(script, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    if (!url.pathname.startsWith('/img/')) {
      return new Response('Not found', { status: 404, headers: cors })
    }
    const key = safePath(url.pathname.slice('/img/'.length))
    if (!key) return new Response('Bad path', { status: 400, headers: cors })

    // ── read: public, and cached hard. The filename carries a timestamp, so
    //    a replaced photo is a new name and this can never serve a stale one.
    if (request.method === 'GET' || request.method === 'HEAD') {
      const object = await env.IMAGES.get(key)
      if (object) {
        const headers = new Headers(cors)
        object.writeHttpMetadata(headers)
        headers.set('etag', object.httpEtag)
        headers.set('Cache-Control', 'public, max-age=31536000, immutable')
        headers.set('X-Image-Source', 'r2')
        return new Response(request.method === 'HEAD' ? null : object.body, { headers })
      }

      // ── a miss is NOT a 404 ─────────────────────────────────────────────
      // The apps still upload new product photos to Supabase Storage. If a
      // miss ended here, switching VITE_IMAGE_HOST to this Worker would serve
      // every photo added after the migration as a broken image -- the one
      // sharp edge in the whole move, and it would show up on the shop floor
      // rather than in a test.
      //
      // So read through to the origin and heal the gap: serve the file from
      // Supabase now, and copy it into R2 in the background so the next
      // request is local. That also covers anything the bulk copy missed,
      // which means the migration cannot leave a hole behind.
      if (!env.ORIGIN_BASE) {
        return new Response('Not found', { status: 404, headers: cors })
      }
      const originUrl = `${env.ORIGIN_BASE.replace(/\/+$/, '')}/storage/v1/object/public/${env.ORIGIN_BUCKET || 'product-images'}/${key}`
      const upstream = await fetch(originUrl, { cf: { cacheTtl: 300 } })
      if (!upstream.ok) {
        return new Response('Not found', { status: 404, headers: cors })
      }
      const ctype = (upstream.headers.get('Content-Type') || '').split(';')[0].trim()
      if (!ALLOWED_TYPES.has(ctype)) {
        // The origin is public, so refuse to relay anything that is not an
        // image rather than becoming an open proxy for the bucket.
        return new Response('Not an image', { status: 415, headers: cors })
      }

      // One body, two consumers: tee so the client is not made to wait for
      // the R2 write, and the write still gets the whole stream.
      const [toClient, toBucket] = upstream.body.tee()
      const len = upstream.headers.get('Content-Length')
      if (!len || Number(len) <= MAX_BYTES) {
        ctx.waitUntil(
          env.IMAGES.put(key, toBucket, { httpMetadata: { contentType: ctype } })
            .catch((e) => console.log('heal failed for', key, String(e)))
        )
      } else {
        // Too big to store; drain the branch so the stream is not left open.
        ctx.waitUntil(toBucket.cancel().catch(() => {}))
      }

      const headers = new Headers(cors)
      headers.set('Content-Type', ctype)
      headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      headers.set('X-Image-Source', 'origin-healed')
      if (request.method === 'HEAD') {
        ctx.waitUntil(toClient.cancel().catch(() => {}))
        return new Response(null, { headers })
      }
      return new Response(toClient, { headers })
    }

    // ── write and delete: staff only.
    // Two ways to be allowed to write, and neither puts a secret in a browser:
    //   * X-Upload-Token  -- the migration script, run from a trusted machine
    //   * Authorization    -- a signed-in staff member's own GoTrue session
    const token = request.headers.get('X-Upload-Token') || ''
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    const bySecret = !!env.UPLOAD_SECRET && secretsMatch(token, env.UPLOAD_SECRET)
    const staff = bySecret ? null : await staffFromToken(bearer, env)
    if (!bySecret && !staff) {
      // Say nothing about which part was wrong.
      return new Response('Unauthorized', { status: 401, headers: cors })
    }

    if (request.method === 'PUT') {
      const type = request.headers.get('Content-Type') || ''
      if (!ALLOWED_TYPES.has(type.split(';')[0].trim())) {
        return Response.json({ error: 'that file type is not allowed' }, { status: 415, headers: cors })
      }
      const declared = Number(request.headers.get('Content-Length') || 0)
      if (declared > MAX_BYTES) {
        return Response.json({ error: 'that photo is too large' }, { status: 413, headers: cors })
      }
      // Refuse to overwrite: every upload gets a fresh name from the app, so
      // a collision means a bug, and silently replacing a live product photo
      // is the kind of thing nobody notices until the wrong picture is on the
      // shop front.
      const existing = await env.IMAGES.head(key)
      if (existing) {
        return Response.json({ error: 'a file already exists at that name' }, { status: 409, headers: cors })
      }
      const body = await request.arrayBuffer()
      if (body.byteLength === 0) return Response.json({ error: 'empty file' }, { status: 400, headers: cors })
      if (body.byteLength > MAX_BYTES) return Response.json({ error: 'too large' }, { status: 413, headers: cors })

      await env.IMAGES.put(key, body, { httpMetadata: { contentType: type } })
      return Response.json({ ok: true, path: key, bytes: body.byteLength }, { headers: cors })
    }

    if (request.method === 'DELETE') {
      await env.IMAGES.delete(key)
      return Response.json({ ok: true, path: key }, { headers: cors })
    }

    return new Response('Method not allowed', { status: 405, headers: cors })
  },
}
