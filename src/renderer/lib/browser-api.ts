import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauriContext } from '@/lib/tauri-runtime'
import { randomUUID } from '@/lib/uuid'

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

/** One tab as the host's tab registry reports it, from engine events. */
export interface BrowserTabView {
  tabId: string
  url: string
  title: string
  loading: boolean
  agentControlled: boolean
  /** Bumped on every new document the tab commits. */
  epoch: number
}

export interface BrowserEventSubscription {
  unlisten: () => void
}

export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string }

const USER_TAB_LABEL = /^tab-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A label the host registry accepts for a tab the user opens. Agent tab
 *  labels are minted by the host only. */
export function newUserBrowserTabId(): string {
  return `tab-${randomUUID().toLowerCase()}`
}

export function isUserBrowserTabId(id: string): boolean {
  return USER_TAB_LABEL.test(id)
}

export async function browserTabCreate(
  tabId: string,
  url: string,
  bounds: BrowserBounds
): Promise<IpcResult<BrowserTabInfo>> {
  return invoke('browser_tab_create', { tabId, url, bounds })
}

export async function browserTabNavigate(tabId: string, url: string): Promise<IpcResult<void>> {
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

export async function browserTabOpenDevtools(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_open_devtools', { tabId })
}

export async function browserTabInjectAgentation(tabId: string): Promise<IpcResult<void>> {
  if (!isTauriContext()) {
    return {
      success: false,
      error: 'Agentation injection requires Tauri desktop',
      code: 'NOT_TAURI'
    }
  }
  return invoke('browser_tab_inject_agentation', { tabId })
}

function createBrowserEventSubscription<T>(
  eventName: string,
  callback: (payload: T) => void
): BrowserEventSubscription {
  const unlistenPromise = listen<T>(eventName, (event) => {
    callback(event.payload)
  })
  return {
    unlisten: () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }
}

/** Every change the host registry makes to a tab's URL, title, loading
 *  state or document epoch. */
export function onBrowserTabUpdated(
  callback: (view: BrowserTabView) => void
): BrowserEventSubscription {
  return createBrowserEventSubscription('browser_tab_updated', callback)
}
