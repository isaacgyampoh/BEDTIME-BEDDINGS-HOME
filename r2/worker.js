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
    const token = request.headers.get('X-Upload-Token') || ''
    if (!env.UPLOAD_SECRET || !secretsMatch(token, env.UPLOAD_SECRET)) {
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
