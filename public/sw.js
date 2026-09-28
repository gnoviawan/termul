/* Termul PWA service worker (termul-server / shared-live web client).
 *
 * Hand-rolled runtime caching for the static shell only — no build-time
 * precache of the JS/CSS bundle, no offline data. Terminals and chat need the
 * live server; the cache only speeds repeat startups and lets an installed
 * launch reach the app's own connection-error UI when the host is down.
 *
 * Cache policy:
 * - Navigations (any same-origin GET navigate, incl. non-allowlisted paths)
 *   and /index.html → network-first (fresh shell after an upgrade; cached
 *   copy is the offline fallback). Navigations get an 8s AbortSignal timeout
 *   (feature-detected — older iOS SW runtimes lack it) so a hung connection
 *   falls back to the shell instead of spinning.
 * - /assets/* (Vite content-hashed) → cache-first (immutable by name).
 * - Other allowlisted unversioned files (/manifest.webmanifest, /sw.js,
 *   /favicon.ico, /icons/*) → network-first. Cache-first would pin them
 *   until a CACHE_NAME bump, defeating the server's no-cache headers.
 * - Everything the SW is allowed to cache is an explicit allowlist — API
 *   routes (/projects, /fs/, /git/, /log/, …) and the WS endpoints (/ws,
 *   /terminal/ws) are never intercepted and never cached. Non-allowlisted
 *   navigations ARE intercepted (so an offline deep-link boots the cached
 *   shell) but their responses are never stored.
 *
 * Keys are normalized to the URL pathname (query strings ignored) so
 * ?foo=bar variants share one entry. Cache writes are waitUntil'd so the
 * worker can't terminate mid-put; CacheStorage failures degrade to plain
 * fetch (the page keeps working when caching is unavailable).
 *
 * Bump CACHE_NAME whenever the caching strategy or allowlist changes; the
 * activate handler purges stale `termul-pwa-*` caches and trims /assets/
 * entries to the newest MAX_ASSET_ENTRIES so repeated deploys don't grow the
 * origin quota monotonically.
 */
const CACHE_NAME = 'termul-pwa-v1'

/** Upper bound on cached /assets/* entries kept across deploys. */
const MAX_ASSET_ENTRIES = 150

/** Milliseconds a navigation fetch may hang before we fall back to cache. */
const NAVIGATION_TIMEOUT_MS = 8000

// Same-origin shell files precached on install so an installed launch can
// boot to the app's connect-error UI even when the host is unreachable.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icons/pwa-192.png',
  '/icons/pwa-512.png',
  '/icons/pwa-maskable-512.png',
  '/icons/apple-touch-icon.png'
]

/** True iff `pathname` is an allowlisted static path the SW may serve/cache. */
function isAllowlistedPath(pathname) {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/sw.js' ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/')
  )
}

/**
 * Open the cache, tolerating CacheStorage being unavailable or rejecting
 * (private mode, quota pressure, disabled storage). Returns null on failure —
 * callers then behave like a pass-through proxy so the page still works.
 */
async function openCache() {
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

/** Best-effort `cache.put` covered by the fetch event's lifetime. */
function putAsync(event, cache, key, response) {
  if (!cache) {
    return
  }
  // waitUntil keeps the worker alive until the write finishes — a floating
  // put could be killed mid-write once respondWith's promise resolves. The
  // catch keeps a quota/serialization failure from poisoning the event.
  event.waitUntil(cache.put(key, response).catch(() => {}))
}

/**
 * fetch() init for navigations: an AbortSignal timeout so a hung server
 * connection falls back to the cached shell instead of spinning forever.
 * `AbortSignal.timeout` is missing on older iOS SW runtimes — feature-detect.
 */
function navigationFetchInit(request) {
  if (
    request.mode === 'navigate' &&
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return { signal: AbortSignal.timeout(NAVIGATION_TIMEOUT_MS) }
  }
  return undefined
}

/**
 * Network-first: fresh response when reachable; the pathname-keyed cached
 * copy (navigations may fall back to the cached `/` shell) when offline.
 * Responses are only stored for allowlisted paths.
 */
async function networkFirst(request, event) {
  const url = new URL(request.url)
  const cacheKey = isAllowlistedPath(url.pathname) ? url.pathname : null
  const cache = await openCache()
  try {
    const response = await fetch(request, navigationFetchInit(request))
    if (response.ok && cacheKey) {
      putAsync(event, cache, cacheKey, response.clone())
    }
    return response
  } catch {
    if (cache) {
      if (cacheKey) {
        try {
          const cached = await cache.match(cacheKey)
          if (cached) {
            return cached
          }
        } catch {
          // match failed — fall through to the shell fallback below.
        }
      }
      // A navigation anywhere falls back to the cached root shell — the
      // hash router resolves the route client-side once the shell boots.
      if (request.mode === 'navigate') {
        try {
          const shell = await cache.match('/')
          if (shell) {
            return shell
          }
        } catch {
          // match failed — nothing cached to fall back to.
        }
      }
    }
    return Response.error()
  }
}

/**
 * Cache-first for immutable content-hashed assets — keyed by pathname so a
 * differing query string still hits the stored entry. Miss → fetch + store.
 */
async function cacheFirst(request, event) {
  const key = new URL(request.url).pathname
  const cache = await openCache()
  if (cache) {
    try {
      const cached = await cache.match(key)
      if (cached) {
        return cached
      }
    } catch {
      // match failed — treat as a miss and hit the network.
    }
  }
  const response = await fetch(request)
  if (response.ok) {
    putAsync(event, cache, key, response.clone())
  }
  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Precache is best-effort: a single missing file (or a missing
      // CacheStorage) must not abort install — runtime caching still
      // populates the shell on the next online visit.
      const cache = await openCache()
      if (cache) {
        await Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url)))
      }
    })()
  )
  // Activate immediately: installed PWAs and kept-open tabs must not stall a
  // new worker (and its updated caches) behind the old one.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((name) => name.startsWith('termul-pwa-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
      // Bound quota growth: every deploy emits NEW hashed /assets/* names and
      // the old ones are never re-requested, so the cache grows monotonically
      // without a cap. cache.keys() is insertion-ordered — drop the oldest.
      const cache = await openCache()
      if (cache) {
        try {
          const keys = await cache.keys()
          const assetKeys = keys.filter((req) =>
            new URL(req.url).pathname.startsWith('/assets/')
          )
          const excess = assetKeys.length - MAX_ASSET_ENTRIES
          if (excess > 0) {
            await Promise.all(assetKeys.slice(0, excess).map((req) => cache.delete(req)))
          }
        } catch {
          // keys()/delete() failed (quota, transient) — trimming is
          // best-effort; the next activate retries.
        }
      }
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  // GET only — POSTs and every other method go straight to the network.
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  // Same-origin only — cross-origin requests are never touched.
  if (url.origin !== self.location.origin) {
    return
  }
  // ANY same-origin GET navigation goes network-first, even on a
  // non-allowlisted path, so an offline deep-link reload boots the cached
  // shell (fallback to '/') instead of the browser's error page. The
  // response is stored only when the path is allowlisted.
  if (
    request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  ) {
    event.respondWith(networkFirst(request, event))
    return
  }
  // Non-navigation requests outside the allowlist — WS endpoints and API
  // routes (/ws, /terminal/ws, /projects, /fs/, /git/, /log/, …) — are never
  // intercepted and never cached.
  if (!isAllowlistedPath(url.pathname)) {
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, event))
  } else {
    // Unversioned files (sw.js, manifest.webmanifest, favicon, icons):
    // network-first — cache-first would pin them until a CACHE_NAME bump.
    event.respondWith(networkFirst(request, event))
  }
})
