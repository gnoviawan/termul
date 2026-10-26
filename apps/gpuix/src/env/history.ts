/**
 * `window.location` and `window.history` for a process with no page: a session
 * history of `{ url, state }` entries with the browser's semantics, so the web
 * root's `createHashRouter` and the overlay back stack run unchanged.
 *
 * - `pushState` drops the forward entries and appends; `replaceState` swaps the
 *   current entry. Neither fires an event, like the browser.
 * - `go(delta)` moves the index on a later task, then fires `popstate` with the
 *   entry's state, and `hashchange` when the fragment changed.
 * - Setting `location.hash` pushes an entry and fires `hashchange`.
 *
 * The origin is fixed to the server's, so every same-origin fetch and socket
 * the shared code builds reaches it.
 */

import { log } from '../log'

interface Entry {
  url: URL
  state: unknown
}

export interface SessionHistory {
  readonly location: Location
  readonly history: History
}

function hashEvent(type: 'hashchange', oldURL: string, newURL: string): Event {
  return Object.assign(new Event(type), { oldURL, newURL })
}

/**
 * `GPUIX_START_HASH`, a hash route (`#/snapshots`) to boot on. The parity
 * matrix uses it for a route no desktop shell links to; anything not shaped
 * `#/...` is ignored.
 */
export function startHash(raw: string | undefined): string {
  const hash = raw?.trim() ?? ''
  if (hash === '' || hash.startsWith('#/')) return hash
  log.warn('history', `GPUIX_START_HASH ${JSON.stringify(hash)} is not a #/ route; ignored`)
  return ''
}

/** `startHash` (`#/snapshots`) is the first entry's fragment: the route the app boots on. */
export function createSessionHistory(
  origin: URL,
  events: EventTarget,
  startHash = ''
): SessionHistory {
  const entries: Entry[] = [{ url: new URL(`/${startHash}`, origin), state: null }]
  let index = 0
  const current = () => entries[index]

  const resolve = (url: string | URL | null | undefined): URL => {
    if (url === null || url === undefined) return new URL(current().url)
    const next = new URL(String(url), current().url)
    if (next.origin !== origin.origin) {
      throw new DOMException(
        `history: ${next.href} is not same-origin with ${origin.origin}`,
        'SecurityError'
      )
    }
    return next
  }

  const push = (url: URL, state: unknown) => {
    entries.splice(index + 1)
    entries.push({ url, state })
    index = entries.length - 1
  }

  const history = {
    get length() {
      return entries.length
    },
    get state() {
      return current().state
    },
    scrollRestoration: 'manual' as ScrollRestoration,
    pushState(state: unknown, _unused: string, url?: string | URL | null) {
      push(resolve(url), structuredClone(state))
    },
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      entries[index] = { url: resolve(url), state: structuredClone(state) }
    },
    go(delta = 0) {
      const target = index + delta
      if (delta === 0 || target < 0 || target >= entries.length) return
      setTimeout(() => {
        const before = current().url
        index = target
        events.dispatchEvent(Object.assign(new Event('popstate'), { state: current().state }))
        if (before.hash !== current().url.hash) {
          events.dispatchEvent(hashEvent('hashchange', before.href, current().url.href))
        }
      }, 0)
    },
    back() {
      history.go(-1)
    },
    forward() {
      history.go(1)
    }
  }

  const location = {
    get href() {
      return current().url.href
    },
    get origin() {
      return origin.origin
    },
    get protocol() {
      return origin.protocol
    },
    get host() {
      return origin.host
    },
    get hostname() {
      return origin.hostname
    },
    get port() {
      return origin.port
    },
    get pathname() {
      return current().url.pathname
    },
    get search() {
      return current().url.search
    },
    get hash() {
      return current().url.hash
    },
    set hash(value: string) {
      const before = current().url
      const next = new URL(before)
      next.hash = value
      if (next.href === before.href) return
      push(next, null)
      setTimeout(() => events.dispatchEvent(hashEvent('hashchange', before.href, next.href)), 0)
    },
    get ancestorOrigins() {
      return [] as unknown as DOMStringList
    },
    assign(url: string | URL) {
      push(resolve(url), null)
    },
    replace(url: string | URL) {
      entries[index] = { url: resolve(url), state: null }
    },
    reload() {
      log.warn('history', 'location.reload() has no page to reload; ignored')
    },
    toString() {
      return current().url.href
    }
  }

  return { location: location as Location, history: history as History }
}
