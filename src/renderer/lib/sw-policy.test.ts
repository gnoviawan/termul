import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/**
 * Behavioral test for `public/sw.js` — covers the I/O-matrix rows that pure
 * file checks can't: the real service-worker source is evaluated in a `vm`
 * sandbox with stubbed `self`/`caches`/`fetch`, then synthetic install /
 * activate / fetch events are dispatched to the captured listeners.
 *
 * `CACHE_NAME`/`MAX_ASSET_ENTRIES`/`PRECACHE_URLS`/`isAllowlistedPath` are
 * read back from the evaluated worker (an appended export expression), so
 * the tests exercise the real constants instead of duplicating literals.
 */

const SW_PATH = resolve(__dirname, '../../../public/sw.js')
const SW_SOURCE = readFileSync(SW_PATH, 'utf8')
const ORIGIN = 'https://termul.example'

/** Minimal stand-in for the FetchEvent `request` — sw.js reads url/method/mode. */
type FakeRequest = { url: string; method: string; mode: string }
type LifecycleEvent = { waitUntil: (p: Promise<unknown>) => void }
type FakeFetchEvent = {
  request: FakeRequest
  respondWith: (p: Promise<Response>) => void
  waitUntil: (p: Promise<unknown>) => void
}
type SwHandler = (event: object) => void

/** The worker's own constants/functions, read back from the evaluated source. */
type SwInternals = {
  CACHE_NAME: string
  MAX_ASSET_ENTRIES: number
  MAX_ASSET_ENTRY_BYTES: number
  PRECACHE_URLS: string[]
  isAllowlistedPath: (pathname: string) => boolean
}

/** In-memory CacheStorage stub keyed by absolute URL (like the real Cache API). */
function createCaches(fetchMock: ReturnType<typeof vi.fn>) {
  const stores = new Map<string, Map<string, Response>>()
  const keyOf = (input: string | { url: string }) =>
    new URL(typeof input === 'string' ? input : input.url, ORIGIN).href

  return {
    stores,
    open: async (name: string) => {
      let store = stores.get(name)
      if (!store) {
        store = new Map()
        stores.set(name, store)
      }
      const s = store
      return {
        // `cache.add` fetches through the network stack AND rejects on a
        // non-OK status — exactly like the real Cache API.
        add: async (url: string) => {
          const res = (await fetchMock(url)) as Response
          if (!res.ok) {
            throw new TypeError(`cache.add refused: HTTP ${res.status}`)
          }
          s.set(keyOf(url), res)
        },
        // The real Cache API resolves a CLONE on match — the stored entry's
        // body must survive being read (install re-reads the cached shell to
        // discover the hashed entry bundle it references).
        match: async (input: string | { url: string }) => s.get(keyOf(input))?.clone(),
        put: async (input: string | { url: string }, res: Response) => {
          s.set(keyOf(input), res)
        },
        keys: async () => [...s.keys()].map((url) => ({ url })),
        delete: async (input: string | { url: string }) => s.delete(keyOf(input))
      }
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name)
  }
}

function loadWorker(extraGlobals: Record<string, unknown> = {}) {
  const handlers = new Map<string, SwHandler[]>()
  const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as FakeRequest).url
    return new Response(`BODY ${url}`, { status: 200 })
  })
  const cachesStub = createCaches(fetchMock)
  const selfStub = {
    addEventListener: (type: string, handler: SwHandler) => {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
    },
    location: { origin: ORIGIN },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn()
  }

  // Evaluate the real service worker with only the globals it uses, then read
  // its internal constants back out of the same evaluation (the appended
  // expression is the script's completion value).
  const sw = runInNewContext(
    `${SW_SOURCE}\n;({ CACHE_NAME, MAX_ASSET_ENTRIES, MAX_ASSET_ENTRY_BYTES, PRECACHE_URLS, isAllowlistedPath })`,
    {
      self: selfStub,
      caches: cachesStub,
      fetch: fetchMock,
      URL,
      Response,
      Promise,
      AbortSignal,
      ...extraGlobals
    }
  ) as SwInternals

  /** Dispatch install/activate and await everything waitUntil'd. */
  const fireLifecycle = async (type: 'install' | 'activate') => {
    const waits: Promise<unknown>[] = []
    const event: LifecycleEvent = { waitUntil: (p) => waits.push(p) }
    for (const handler of handlers.get(type) ?? []) {
      handler(event)
    }
    await Promise.all(waits)
  }

  /**
   * Dispatch a fetch event; `outcome()` returns the respondWith promise and
   * `waits` collects everything the handler passes to `event.waitUntil`
   * (populated asynchronously as the respondWith'd work runs).
   */
  const fireFetch = (req: { url: string; method?: string; mode?: string }) => {
    const request: FakeRequest = { method: 'GET', mode: 'cors', ...req }
    let outcome: Promise<Response> | undefined
    const respondWith = vi.fn((p: Promise<Response>) => {
      outcome = p
    })
    const waits: Promise<unknown>[] = []
    const event: FakeFetchEvent = {
      request,
      respondWith,
      waitUntil: (p) => waits.push(p)
    }
    for (const handler of handlers.get('fetch') ?? []) {
      handler(event)
    }
    return { request, respondWith, waits, outcome: () => outcome }
  }

  const store = () => cachesStub.stores.get(sw.CACHE_NAME)

  return {
    sw,
    fetchMock,
    stores: cachesStub.stores,
    self: selfStub,
    store,
    fireLifecycle,
    fireFetch
  }
}

describe('public/sw.js runtime policy', () => {
  it('exposes a coherent policy surface — every precached URL is allowlisted', () => {
    const worker = loadWorker()
    expect(worker.sw.CACHE_NAME).toBeTypeOf('string')
    expect(worker.sw.PRECACHE_URLS.length).toBeGreaterThan(0)
    for (const url of worker.sw.PRECACHE_URLS) {
      expect(worker.sw.isAllowlistedPath(url), `precached ${url} must be allowlisted`).toBe(true)
    }
  })

  it('server down: precached shell answers offline navigation (connect-error UI can boot)', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('SHELL_HTML'))
    await worker.fireLifecycle('install')

    // Host unreachable — the SW must fall back to the cached shell, not fail.
    worker.fetchMock.mockRejectedValue(new Error('connection refused'))
    const nav = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })

    expect(nav.respondWith).toHaveBeenCalledTimes(1)
    const res = await nav.outcome()
    expect(res).toBeDefined()
    expect(await res?.text()).toBe('SHELL_HTML')
  })

  it('a failing precache URL cannot abort install (Promise.allSettled)', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockImplementation(
      async (input) => new Response('x', { status: String(input) === '/favicon.ico' ? 404 : 200 })
    )
    // cache.add('/favicon.ico') rejects (non-OK) — install must still resolve.
    await worker.fireLifecycle('install')
    expect(worker.self.skipWaiting).toHaveBeenCalled()

    // The shell was still precached: an offline navigation resolves to it.
    worker.fetchMock.mockRejectedValue(new Error('down'))
    const nav = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    expect(await (await nav.outcome())?.text()).toBe('x')
  })

  it('install calls skipWaiting so open tabs cannot stall the update', async () => {
    const worker = loadWorker()
    await worker.fireLifecycle('install')
    expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1)
  })

  it('activate purges stale termul-pwa-* caches but keeps the current + foreign ones', async () => {
    const worker = loadWorker()
    worker.stores.set('termul-pwa-v0', new Map())
    worker.stores.set('termul-pwa-legacy', new Map())
    worker.stores.set(worker.sw.CACHE_NAME, new Map())
    worker.stores.set('other-app-cache', new Map())

    await worker.fireLifecycle('activate')

    expect(new Set(worker.stores.keys())).toEqual(
      new Set([worker.sw.CACHE_NAME, 'other-app-cache'])
    )
    expect(worker.self.clients.claim).toHaveBeenCalledTimes(1)
  })

  it('activate trims /assets/* entries to the newest MAX_ASSET_ENTRIES (bounded quota)', async () => {
    const worker = loadWorker()
    const max = worker.sw.MAX_ASSET_ENTRIES
    const store = new Map<string, Response>()
    // Insertion order = oldest first (matches real Cache.keys() ordering).
    for (let i = 0; i < max + 5; i++) {
      store.set(`${ORIGIN}/assets/chunk-${i}.js`, new Response(String(i)))
    }
    store.set(`${ORIGIN}/`, new Response('shell'))
    worker.stores.set(worker.sw.CACHE_NAME, store)

    await worker.fireLifecycle('activate')

    const remainingAssets = [...store.keys()].filter((k) => k.includes('/assets/'))
    expect(remainingAssets.length).toBe(max)
    // The oldest entries were dropped; non-asset entries are untouched.
    expect(store.has(`${ORIGIN}/assets/chunk-0.js`)).toBe(false)
    expect(store.has(`${ORIGIN}/assets/chunk-${max + 4}.js`)).toBe(true)
    expect(store.has(`${ORIGIN}/`)).toBe(true)
  })

  it.each([
    '/ws',
    '/terminal/ws',
    '/projects',
    '/fs/ls',
    '/log/frontend-error'
  ])('never intercepts GET %s (WS/API pass straight to the network)', (path) => {
    const worker = loadWorker()
    const evt = worker.fireFetch({
      url: `${ORIGIN}${path}`,
      method: 'GET',
      mode: 'cors'
    })
    expect(evt.respondWith).not.toHaveBeenCalled()
    expect(worker.fetchMock).not.toHaveBeenCalled()
  })

  it('never intercepts non-GET requests or cross-origin URLs', () => {
    const worker = loadWorker()

    const post = worker.fireFetch({
      url: `${ORIGIN}/`,
      method: 'POST',
      mode: 'navigate'
    })
    expect(post.respondWith).not.toHaveBeenCalled()

    const crossOrigin = worker.fireFetch({
      url: 'https://evil.example/index.html',
      method: 'GET',
      mode: 'navigate'
    })
    expect(crossOrigin.respondWith).not.toHaveBeenCalled()
    expect(worker.fetchMock).not.toHaveBeenCalled()
  })

  it('install precaches the hashed entry bundle referenced by index.html', async () => {
    const worker = loadWorker()
    const html =
      '<!doctype html><script type="module" src="/assets/index-abc.js"></script>' +
      '<link rel="stylesheet" href="/assets/index-def.css">'
    worker.fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/' || url === '/index.html') {
        return new Response(html, { status: 200 })
      }
      return new Response(`BODY ${url}`, { status: 200 })
    })

    await worker.fireLifecycle('install')

    // The entry JS+CSS the cached shell references must be in the SW cache —
    // otherwise an offline installed launch opens HTML that cannot boot.
    expect(worker.store()?.has(`${ORIGIN}/assets/index-abc.js`)).toBe(true)
    expect(worker.store()?.has(`${ORIGIN}/assets/index-def.css`)).toBe(true)
    // …and the shell still answers offline navigation.
    worker.fetchMock.mockRejectedValue(new Error('down'))
    const nav = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    expect(await (await nav.outcome())?.text()).toContain('/assets/index-abc.js')
  })

  it('navigation answered 502/503 falls back to the cached shell (proxy outage)', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('SHELL'))
    await worker.fireLifecycle('install')

    // Host unreachable but a tunnel/proxy answers — 5xx is the same outage.
    worker.fetchMock.mockResolvedValue(new Response('BAD GATEWAY', { status: 502 }))
    const nav = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    const res = await nav.outcome()
    expect(res?.status).toBe(200)
    expect(await res?.text()).toBe('SHELL')
  })

  it('navigation answered 4xx passes through — not an outage', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('SHELL'))
    await worker.fireLifecycle('install')

    worker.fetchMock.mockResolvedValue(new Response('NOT FOUND', { status: 404 }))
    const nav = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    const res = await nav.outcome()
    expect(res?.status).toBe(404)
    expect(await res?.text()).toBe('NOT FOUND')
  })

  it('runtime /assets/* writes are bounded — trim runs at write time, not just activate', async () => {
    const worker = loadWorker()
    const max = worker.sw.MAX_ASSET_ENTRIES
    const store = new Map<string, Response>()
    for (let i = 0; i < max; i++) {
      store.set(`${ORIGIN}/assets/chunk-${i}.js`, new Response(String(i)))
    }
    worker.stores.set(worker.sw.CACHE_NAME, store)

    worker.fetchMock.mockResolvedValue(new Response('NEW'))
    const evt = worker.fireFetch({ url: `${ORIGIN}/assets/new.js`, mode: 'no-cors' })
    expect(await (await evt.outcome())?.text()).toBe('NEW')
    await Promise.all(evt.waits)

    const remaining = [...store.keys()].filter((k) => k.includes('/assets/'))
    expect(remaining.length).toBe(max)
    expect(store.has(`${ORIGIN}/assets/new.js`)).toBe(true)
    expect(store.has(`${ORIGIN}/assets/chunk-0.js`)).toBe(false)
  })

  it('an /assets/* response over MAX_ASSET_ENTRY_BYTES is never cached', async () => {
    const worker = loadWorker()
    const tooBig = worker.sw.MAX_ASSET_ENTRY_BYTES + 1
    worker.fetchMock.mockResolvedValue(
      new Response('HUGE', {
        status: 200,
        headers: { 'Content-Length': String(tooBig) }
      })
    )
    const evt = worker.fireFetch({ url: `${ORIGIN}/assets/huge.wasm`, mode: 'no-cors' })
    expect(await (await evt.outcome())?.text()).toBe('HUGE')
    await Promise.all(evt.waits)
    expect(worker.store()?.has(`${ORIGIN}/assets/huge.wasm`)).toBe(false)
  })

  it('navigations are network-first, carry a timeout, and repopulate the cache', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('SHELL_V2'))

    const online = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    expect(online.respondWith).toHaveBeenCalledTimes(1)
    expect(await (await online.outcome())?.text()).toBe('SHELL_V2')
    expect(worker.fetchMock).toHaveBeenCalledTimes(1)
    // The navigation fetch carries an AbortSignal timeout (hung server →
    // cache fallback instead of spinning forever).
    const init = worker.fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)

    // The fresh copy was stored: with the network down, it is served.
    worker.fetchMock.mockRejectedValue(new Error('down'))
    const offline = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    expect(await (await offline.outcome())?.text()).toBe('SHELL_V2')
  })

  it('navigations still work when AbortSignal.timeout is unavailable (older iOS)', async () => {
    const worker = loadWorker({ AbortSignal: undefined })
    worker.fetchMock.mockResolvedValue(new Response('SHELL'))

    const nav = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    expect(await (await nav.outcome())?.text()).toBe('SHELL')
    // No init object was built — the feature-detect short-circuited.
    expect(worker.fetchMock.mock.calls[0]?.[1]).toBeUndefined()
  })

  it.each([
    '/manifest.webmanifest',
    '/sw.js',
    '/favicon.ico',
    '/icons/pwa-192.png'
  ])('unversioned %s is network-first (fresh copy wins over a stale cache entry)', async (path) => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('V1'))
    const first = worker.fireFetch({ url: `${ORIGIN}${path}`, mode: 'cors' })
    expect(await (await first.outcome())?.text()).toBe('V1')

    // A newer network response wins over the cached V1 — proves the SW did
    // NOT pin the unversioned file behind cache-first.
    worker.fetchMock.mockResolvedValue(new Response('V2'))
    const second = worker.fireFetch({ url: `${ORIGIN}${path}`, mode: 'cors' })
    expect(await (await second.outcome())?.text()).toBe('V2')

    // Offline, the freshest cached copy is the fallback.
    worker.fetchMock.mockRejectedValue(new Error('down'))
    const third = worker.fireFetch({ url: `${ORIGIN}${path}`, mode: 'cors' })
    expect(await (await third.outcome())?.text()).toBe('V2')
  })

  it('cache.put is covered by event.waitUntil (the worker cannot die mid-write)', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('S'))
    const nav = worker.fireFetch({ url: `${ORIGIN}/`, mode: 'navigate' })
    await nav.outcome()

    // The put was handed to waitUntil, not left floating on the fetch promise.
    expect(nav.waits.length).toBeGreaterThan(0)
    await Promise.all(nav.waits)
    expect(worker.store()?.has(`${ORIGIN}/`)).toBe(true)
  })

  it('an offline navigate to a non-allowlisted path resolves the cached / shell', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('SHELL'))
    await worker.fireLifecycle('install')

    worker.fetchMock.mockRejectedValue(new Error('down'))
    const nav = worker.fireFetch({
      url: `${ORIGIN}/some/client/route`,
      mode: 'navigate'
    })
    expect(nav.respondWith).toHaveBeenCalledTimes(1)
    expect(await (await nav.outcome())?.text()).toBe('SHELL')
    // …but a non-allowlisted response is never stored.
    expect(worker.store()?.has(`${ORIGIN}/some/client/route`)).toBe(false)
  })

  it('/assets/* cache keys ignore the query string', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('CHUNK'))

    const first = worker.fireFetch({ url: `${ORIGIN}/assets/x.js?q=1`, mode: 'no-cors' })
    expect(await (await first.outcome())?.text()).toBe('CHUNK')

    // Same pathname, different query → served from the SAME cache entry.
    const second = worker.fireFetch({ url: `${ORIGIN}/assets/x.js?q=2`, mode: 'no-cors' })
    expect(await (await second.outcome())?.text()).toBe('CHUNK')
    expect(worker.fetchMock).toHaveBeenCalledTimes(1)
    expect(worker.store()?.has(`${ORIGIN}/assets/x.js`)).toBe(true)
  })

  it('GET /assets/* is cache-first: a repeat request never hits the network', async () => {
    const worker = loadWorker()
    worker.fetchMock.mockResolvedValue(new Response('CHUNK'))
    const url = `${ORIGIN}/assets/chunk-abc.js`

    const first = worker.fireFetch({ url, mode: 'no-cors' })
    expect(first.respondWith).toHaveBeenCalledTimes(1)
    expect(await (await first.outcome())?.text()).toBe('CHUNK')

    const second = worker.fireFetch({ url, mode: 'no-cors' })
    expect(second.respondWith).toHaveBeenCalledTimes(1)
    expect(await (await second.outcome())?.text()).toBe('CHUNK')

    // One network fetch total — the second response came from the cache.
    expect(worker.fetchMock).toHaveBeenCalledTimes(1)
  })
})
