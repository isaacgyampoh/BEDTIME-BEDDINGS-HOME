// BEDTIME BEDDINGS & HOME POS — service worker
//
// Scope note: this cache holds STATIC APP SHELL ASSETS ONLY. The previous
// version cached every successful GET, which included Supabase REST responses.
// That meant a POS could be served stale products, stock levels and orders from
// disk after a network blip — dangerous at a till — and it wrote API payloads
// to the device's cache storage. API traffic is now always network-only.

const CACHE_NAME = 'bedtime-pos-v3'

// Only these same-origin file types are worth caching for offline shell load.
const CACHEABLE_DESTINATIONS = ['document', 'script', 'style', 'font', 'image']

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    await self.clients.claim()
  })())
})

function isCacheable(request) {
  if (request.method !== 'GET') return false

  let url
  try { url = new URL(request.url) } catch { return false }

  // Never touch anything that isn't our own origin: Supabase REST/realtime/
  // storage, the Edge Functions, fonts CDN, payment providers.
  if (url.origin !== self.location.origin) return false

  // Belt and braces in case the app is ever proxied through its own origin.
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/rest/') ||
      url.pathname.startsWith('/functions/')) return false

  return CACHEABLE_DESTINATIONS.includes(request.destination)
}

self.addEventListener('fetch', (e) => {
  const { request } = e

  // Everything not on the static allowlist goes straight to the network with no
  // caching and no offline fallback, so the POS never acts on stale data.
  if (!isCacheable(request)) return

  // Network-first for the shell: fresh when online, last-known copy when not.
  e.respondWith((async () => {
    try {
      const res = await fetch(request)
      if (res && res.ok && res.type === 'basic') {
        const clone = res.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {})
      }
      return res
    } catch (err) {
      const cached = await caches.match(request)
      if (cached) return cached
      // A navigation with nothing cached still needs a response, not a throw.
      if (request.mode === 'navigate') {
        const shell = await caches.match('/index.html')
        if (shell) return shell
      }
      throw err
    }
  })())
})

// Badge updates pushed from the app (pending + paid order count).
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'UPDATE_BADGE') {
    const count = e.data.count || 0
    if (count > 0) self.registration.setAppBadge?.(count).catch(() => {})
    else self.registration.clearAppBadge?.().catch(() => {})
  }
})
