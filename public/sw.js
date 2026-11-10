/**
 * Beatbreak service worker.
 *
 * Offline strategy:
 *  - On install the full build output (JS/CSS/icons/manifest) is precached. The manifest is
 *    injected at build time by the `sw-precache` Vite plugin, so hashed asset names
 *    are always in sync with the bundle.
 *  - Navigations: network first, but a fetch that has not answered in NAV_TIMEOUT_MS gets the
 *    cached shell (a weak signal hangs instead of failing). The fetch still refreshes the cache.
 *  - Everything else same-origin: cache first (assets are content-hashed and immutable).
 *  - The previous build's cache is kept: a tab opened before a deploy still runs the old code and
 *    loads its worker and lazy screens by their old hashed names, which the host no longer has.
 *
 * There is deliberately no runtime dependency on any network service: gameplay, analysis and
 * rendering all run locally in the page.
 */
const PRECACHE_MANIFEST = "__PRECACHE_MANIFEST__"
// Replaced at build time with a hash of the precache manifest (see vite.config.ts).
const VERSION = 'pulsegrid-__BUILD_VERSION__'
const PRECACHE = `${VERSION}-precache`
const RUNTIME = `${VERSION}-runtime`
/** Which builds' caches exist, newest last, so activate can keep the one before this. */
const BUILDS = 'pulsegrid-builds'
const KEEP_BUILDS = 2
const NAV_TIMEOUT_MS = 3000

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
      // Entries are cached one by one so an icon or a font cannot sink the install. The shell, the
      // scripts and the styles can: without them offline is a blank page, so the install fails,
      // the old worker stays, and the browser tries again on the next visit.
      const missing = []
      await Promise.all(
        precacheEntries.map(async (entry) => {
          try {
            await cache.add(new Request(scoped(entry.url), { cache: 'reload' }))
          } catch (err) {
            console.warn('[beatbreak/sw] precache miss', entry.url, err)
            if (/\.(js|css|html)$/.test(entry.url)) missing.push(entry.url)
          }
        }),
      )
      if (missing.length > 0) throw new Error(`precache failed for ${missing.join(', ')}`)
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const book = await caches.open(BUILDS)
      const listed = await book.match('builds')
      let builds = []
      try {
        builds = listed ? await listed.json() : []
      } catch {
        builds = []
      }
      builds = [...builds.filter((v) => v !== VERSION), VERSION].slice(-KEEP_BUILDS)
      await book.put('builds', new Response(JSON.stringify(builds), { headers: { 'Content-Type': 'application/json' } }))
      const keep = new Set([BUILDS, ...builds.flatMap((v) => [`${v}-precache`, `${v}-runtime`])])
      const keys = await caches.keys()
      // The singer files are cached by the page itself and outlive builds.
      await Promise.all(keys.filter((k) => !keep.has(k) && !k.startsWith('beatbreak-voice')).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'Beatbreak_SKIP_WAITING') self.skipWaiting()
})

function isNavigation(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // never proxy third-party requests
  // The singer files (tens of MB) are cached by the page in their own cache, once.
  if (url.pathname.includes('/voice/')) return

  if (isNavigation(request)) {
    event.respondWith(
      (async () => {
        const network = fetch(request).then(async (fresh) => {
          if (fresh.ok) {
            const cache = await caches.open(RUNTIME)
            // Always keep the app shell (index.html), whatever route the navigation targeted.
            await cache.put(SHELL, fresh.clone())
          }
          return fresh
        })
        event.waitUntil(network.catch(() => undefined))
        const cached = (await caches.match(SHELL)) || (await caches.match(request))
        const offline = () =>
          new Response('<h1>Beatbreak is offline</h1><p>Open the app once while online to cache it.</p>', {
            headers: { 'Content-Type': 'text/html' },
            status: 200,
          })
        if (!cached) return network.catch(offline)
        const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS))
        return Promise.race([network.catch(() => cached), timeout])
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
