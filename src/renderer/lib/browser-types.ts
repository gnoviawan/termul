/**
 * Browser pane contracts shared by `browser-api.ts` and the browser host seam
 * (`browser-host.ts`). A leaf module, so a non-Tauri shell can implement the
 * host without loading the Tauri facade.
 */

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTabInfo {
  id: string
  url: string
  title: string
  /** True when the host claimed this webview for a pending agent open. */
  agentControlled: boolean
}

export interface BrowserTabNavigatedPayload {
  browserTabId: string
  url: string
}

export interface BrowserTabLoadedPayload {
  browserTabId: string
}

export interface BrowserTabTitleChangedPayload {
  browserTabId: string
  title: string
}

export interface BrowserEventSubscription {
  unlisten: () => void
}

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string }
