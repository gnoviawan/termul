/**
 * The environment seam: the browser globals the shared renderer code touches,
 * defined once before any `src/renderer` module loads. Nothing else in
 * `apps/gpuix` defines a DOM global.
 *
 * What is here was found by running the project-list path (`use-project-registry`,
 * the `/ws` transport, `web-auth-token`, `web-client-identity`) and adding each
 * global the run touched:
 *
 * - `window.location` and `window.history` (`history.ts`): `serverBase()` and the
 *   WS URL builders read the origin; the hash router and the overlay back stack
 *   read and push the fragment.
 * - `window.localStorage` / `sessionStorage`: device id, auth token, protocol
 *   latch. `localStorage` persists per server origin under the client state dir.
 * - `window` is the global object, as in a page (`window.setInterval`,
 *   `window.fetch`); Bun's global is already an event target, so the WS
 *   transport's page-lifecycle listeners land on it. `document` is an event
 *   target with a `visibilityState`.
 * - `window.innerWidth` / `innerHeight`: GPUIX's automation `initialize`
 *   handler reports them whenever a `window` global exists.
 *
 * - the element-facing DOM surface (focus, tree queries, observers, matchMedia):
 *   `dom.ts`, backed by `src/compat/dom-node.ts`.
 *
 * `window.__TAURI_INTERNALS__` stays undefined, so `isTauriContext()` is false
 * and every facade picks its web transport.
 */

import path from 'node:path'
import { installCometFrames } from './comet-frames'
import type { ClientConfig } from './config'
import { installDom } from './dom'
import { createSessionHistory } from './history'
import { FileStorage, MemoryStorage } from './storage'

export interface BrowserEnv {
  location: Location
  history: History
  localStorage: FileStorage
  sessionStorage: MemoryStorage
}

function storageFileFor(config: ClientConfig): string {
  const origin = config.serverUrl.host.replace(/[^A-Za-z0-9.-]/g, '_')
  return path.join(config.stateDir, 'web-storage', `${origin}.json`)
}

let installed: BrowserEnv | null = null

export interface Viewport {
  width: number
  height: number
}

export function installBrowserEnv(config: ClientConfig, viewport: Viewport): BrowserEnv {
  if (installed) return installed
  const localStorage = new FileStorage(storageFileFor(config))
  const sessionStorage = new MemoryStorage()

  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
    hidden: false
  })
  // The page's global object is `window`; Bun's global is already an event target.
  const window = globalThis as unknown as EventTarget & Record<string, unknown>
  const { location, history } = createSessionHistory(config.serverUrl, window)
  Object.assign(window, {
    window,
    self: window,
    location,
    history,
    localStorage,
    sessionStorage,
    document,
    innerWidth: viewport.width,
    innerHeight: viewport.height
  })
  Object.assign(document, { defaultView: window })

  installDom(viewport, { reducedMotion: process.env.GPUIX_REDUCED_MOTION === '1' })
  installCometFrames(path.join(config.stateDir, 'comet-frames'))
  installed = { location, history, localStorage, sessionStorage }
  return installed
}
