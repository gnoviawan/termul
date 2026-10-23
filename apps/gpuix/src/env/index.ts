/**
 * The environment seam: the browser globals the shared renderer code touches,
 * defined once before any `src/renderer` module loads. Nothing else in
 * `apps/gpuix` defines a DOM global.
 *
 * What is here was found by running the project-list path (`use-project-registry`,
 * the `/ws` transport, `web-auth-token`, `web-client-identity`) and adding each
 * global the run touched:
 *
 * - `window.location`: `serverBase()` and the WS URL builders read the origin.
 *   Pointing it at the server makes every same-origin fetch and socket reach it.
 * - `window.localStorage` / `sessionStorage`: device id, auth token, protocol
 *   latch. `localStorage` persists per server origin under the client state dir.
 * - `window` and `document` as event targets with a `visibilityState`: the WS
 *   transport and the registry hook install page-lifecycle listeners.
 * - `window.innerWidth` / `innerHeight`: GPUIX's automation `initialize`
 *   handler reports them whenever a `window` global exists.
 *
 * `window.__TAURI_INTERNALS__` stays undefined, so `isTauriContext()` is false
 * and every facade picks its web transport.
 */

import path from 'node:path'
import type { ClientConfig } from './config'
import { FileStorage, MemoryStorage } from './storage'

/** The fields of `window.location` the shared code reads. */
export interface ClientLocation {
  href: string
  origin: string
  protocol: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
}

export interface BrowserEnv {
  location: ClientLocation
  localStorage: FileStorage
  sessionStorage: MemoryStorage
}

function storageFileFor(config: ClientConfig): string {
  const origin = config.serverUrl.host.replace(/[^A-Za-z0-9.-]/g, '_')
  return path.join(config.stateDir, 'web-storage', `${origin}.json`)
}

function locationFor(url: URL): ClientLocation {
  return Object.freeze({
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: '/',
    search: '',
    hash: ''
  })
}

let installed: BrowserEnv | null = null

export interface Viewport {
  width: number
  height: number
}

export function installBrowserEnv(config: ClientConfig, viewport: Viewport): BrowserEnv {
  if (installed) return installed
  const location = locationFor(config.serverUrl)
  const localStorage = new FileStorage(storageFileFor(config))
  const sessionStorage = new MemoryStorage()

  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
    hidden: false
  })
  const window = Object.assign(new EventTarget(), {
    location,
    localStorage,
    sessionStorage,
    document,
    innerWidth: viewport.width,
    innerHeight: viewport.height
  })

  Object.assign(globalThis, { window, document, localStorage, sessionStorage })
  installed = { location, localStorage, sessionStorage }
  return installed
}
