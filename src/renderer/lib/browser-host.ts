/**
 * Browser host seam: a non-Tauri desktop shell (the GPUIX client) registers
 * the native webviews the browser pane needs, and every `browser-api.ts`
 * facade routes to it. With no host registered (the browser and phone client)
 * the facades keep their web behavior; Tauri never registers one, so its
 * `invoke` path is unchanged.
 *
 * A host provides the whole set or nothing, like `desktop-host.ts`, so the
 * facade never has to handle a half-capable host. Register it before the app
 * tree renders.
 */

import type {
  BrowserBounds,
  BrowserEventSubscription,
  BrowserTabInfo,
  BrowserTabLoadedPayload,
  BrowserTabNavigatedPayload,
  BrowserTabTitleChangedPayload,
  IpcResult
} from './browser-api'
import { isTauriContext } from './tauri-runtime'

export interface BrowserHost {
  create(tabId: string, url: string, bounds: BrowserBounds): Promise<IpcResult<BrowserTabInfo>>
  navigate(tabId: string, url: string): Promise<IpcResult<void>>
  resize(tabId: string, bounds: BrowserBounds): Promise<IpcResult<void>>
  show(tabId: string): Promise<IpcResult<void>>
  hide(tabId: string): Promise<IpcResult<void>>
  destroy(tabId: string): Promise<IpcResult<void>>
  goBack(tabId: string): Promise<IpcResult<void>>
  goForward(tabId: string): Promise<IpcResult<void>>
  reload(tabId: string): Promise<IpcResult<void>>
  openDevtools(tabId: string): Promise<IpcResult<void>>
  injectAgentation(tabId: string): Promise<IpcResult<void>>
  onNavigated(callback: (payload: BrowserTabNavigatedPayload) => void): BrowserEventSubscription
  onLoaded(callback: (payload: BrowserTabLoadedPayload) => void): BrowserEventSubscription
  onTitleChanged(
    callback: (payload: BrowserTabTitleChangedPayload) => void
  ): BrowserEventSubscription
}

let host: BrowserHost | null = null

export function registerBrowserHost(next: BrowserHost): void {
  host = next
}

export function getBrowserHost(): BrowserHost | null {
  return host
}

/**
 * Whether this surface can show browser panes: the Tauri desktop app, or a
 * desktop shell that registered a browser host. The browser and phone client
 * cannot, so their entry points stay hidden.
 */
export function nativeBrowserPanesAvailable(): boolean {
  return isTauriContext() || host !== null
}

/** @internal Testing only. */
export function _resetBrowserHostForTesting(): void {
  host = null
}
