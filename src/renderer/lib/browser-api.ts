import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

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
}

export interface BrowserTabNavigatedPayload {
  browserTabId: string
  url: string
}

export interface BrowserTabLoadedPayload {
  browserTabId: string
}

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string }

export async function browserTabCreate(
  tabId: string,
  url: string,
  bounds: BrowserBounds
): Promise<IpcResult<BrowserTabInfo>> {
  return invoke('browser_tab_create', { tabId, url, bounds })
}

export async function browserTabNavigate(
  tabId: string,
  url: string
): Promise<IpcResult<void>> {
  return invoke('browser_tab_navigate', { tabId, url })
}

export async function browserTabResize(
  tabId: string,
  bounds: BrowserBounds
): Promise<IpcResult<void>> {
  return invoke('browser_tab_resize', { tabId, bounds })
}

export async function browserTabShow(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_show', { tabId })
}

export async function browserTabHide(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_hide', { tabId })
}

export async function browserTabDestroy(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_destroy', { tabId })
}

export async function browserTabGoBack(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_go_back', { tabId })
}

export async function browserTabGoForward(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_go_forward', { tabId })
}

export async function browserTabReload(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_reload', { tabId })
}

// Event listeners for URL sync from webview poller
export function onBrowserTabNavigated(
  callback: (payload: BrowserTabNavigatedPayload) => void
): Promise<UnlistenFn> {
  return listen<BrowserTabNavigatedPayload>('browser-tab-navigated', (event) => {
    callback(event.payload)
  })
}

export function onBrowserTabLoaded(
  callback: (payload: BrowserTabLoadedPayload) => void
): Promise<UnlistenFn> {
  return listen<BrowserTabLoadedPayload>('browser-tab-loaded', (event) => {
    callback(event.payload)
  })
}
