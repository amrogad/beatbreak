/**
 * PULSEGRID service worker.
 *
 * Offline strategy:
 *  - On install the full build output (JS/CSS/icons/manifest) is precached. The manifest is
 *    injected at build time by the `pulsegrid-sw-precache` Vite plugin, so hashed asset names
 *    are always in sync with the bundle.
 *  - Navigations: network first, falling back to the cached shell. This keeps the app usable
 *    offline with zero remote dependencies (no CDNs, no remote fonts, no analytics).
 *  - Everything else same-origin: cache first (assets are content-hashed and immutable).
 *
 * There is deliberately no runtime dependency on any network service: gameplay, analysis and
 * rendering all run locally in the page.
 */
const PRECACHE_MANIFEST = "__PRECACHE_MANIFEST__"
// Replaced at build time with a hash of the precache manifest (see vite.config.ts).
const VERSION = 'pulsegrid-__BUILD_VERSION__'
const PRECACHE = `${VERSION}-precache`
const RUNTIME = `${VERSION}-runtime`

let precacheEntries = []
try {
  precacheEntries = JSON.parse(PRECACHE_MANIFEST)
  if (!Array.isArray(precacheEntries)) precacheEntries = []
} catch {
  // Placeholder (development) or an injection error: fall back to runtime caching only.
  precacheEntries = []
}

const SHELL = new URL('./index.html', self.registration.scope).toString()
const SCOPE = self.registration.scope

/** Resolve a manifest-relative URL against the SW scope (never against the site root). */
function scoped(url) {
  return new URL(url, SCOPE).toString()
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE)
      // Cache entries individually so a single failure cannot abort the whole install.
      await Promise.all(
        precacheEntries.map(async (entry) => {
          try {
            await cache.add(new Request(scoped(entry.url), { cache: 'reload' }))
          } catch (err) {
            console.warn('[pulsegrid/sw] precache miss', entry.url, err)
          }
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== PRECACHE && k !== RUNTIME).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'PULSEGRID_SKIP_WAITING') self.skipWaiting()
})

function isNavigation(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // never proxy third-party requests

  if (isNavigation(request)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          const cache = await caches.open(RUNTIME)
          // Always keep the app shell (index.html), whatever route the navigation targeted.
          cache.put(SHELL, fresh.clone())
          return fresh
        } catch {
          const cached = (await caches.match(SHELL)) || (await caches.match(request))
          return (
            cached ||
            new Response('<h1>PULSEGRID is offline</h1><p>Open the app once while online to cache it.</p>', {
              headers: { 'Content-Type': 'text/html' },
              status: 200,
            })
          )
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      try {
        const response = await fetch(request)
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(RUNTIME)
          cache.put(request, response.clone())
        }
        return response
      } catch (err) {
        const fallback = await caches.match(request)
        if (fallback) return fallback
        throw err
      }
    })(),
  )
})
