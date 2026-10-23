/**
 * The DOM globals `src/renderer/lib/web-terminal-api.ts` and its import graph
 * read when they run under bun. Measured by importing the facade with no
 * globals and adding one global per failure:
 *
 * - `window.location` (WS URL, auth token fragment, `serverBase()`)
 * - `window.localStorage` / `window.sessionStorage` (device id, client
 *   instance id, web auth token, command journal)
 * - `window.addEventListener` (`focus`, `online`, `pagehide`, `pageshow`)
 * - `document.visibilityState` + `document.addEventListener`
 * - `window.history.replaceState` (token fragment scrub)
 * - `window.innerWidth/innerHeight` (read by GPUIX automation, not Termul)
 *
 * Install once, before the first import of any `@/lib/*` module. Unit P0 owns
 * the app-wide seam under `apps/gpuix/src/env/`; this module is the terminal
 * slice of it and should fold into that seam when the branches merge.
 */

class MemoryStorage {
  private readonly map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

export interface TerminalEnvOptions {
  /** `http://127.0.0.1:8191` style origin of the termul-server. */
  origin: string
  /** Bearer token for a gated host. Omitted on an ungated loopback bind. */
  token?: string
  /**
   * `@gpuix/native/automation` treats a defined `window` as the browser build
   * and reports `window.innerWidth/innerHeight` to the driver, so the seam
   * carries the native window size. Defaults to the 1280x800 capture size.
   */
  windowSize?: { width: number; height: number }
}

let installedOrigin: string | null = null

export function installTerminalEnv(options: TerminalEnvOptions): void {
  if (installedOrigin === options.origin) return
  if (installedOrigin !== null) {
    throw new Error(`terminal env already installed for ${installedOrigin}`)
  }
  const url = new URL(options.origin)
  const noop = (): void => {}
  const location = {
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    origin: url.origin,
    href: `${url.origin}/`,
    pathname: '/',
    search: '',
    hash: options.token ? `#token=${encodeURIComponent(options.token)}` : '',
    reload: noop
  }
  const windowLike = {
    innerWidth: options.windowSize?.width ?? 1280,
    innerHeight: options.windowSize?.height ?? 800,
    location,
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    history: { state: null, replaceState: noop },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout
  }
  const documentLike = {
    visibilityState: 'visible',
    hidden: false,
    addEventListener: noop,
    removeEventListener: noop
  }
  Object.assign(globalThis, { window: windowLike, document: documentLike })
  installedOrigin = options.origin
}

export function terminalEnvOrigin(): string | null {
  return installedOrigin
}
