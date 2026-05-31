import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AnnotationSubMode } from '@/stores/browser-session-store'

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

export interface RegionCapturedPayload {
  browserTabId: string
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

export interface ElementCapturedPayload {
  browserTabId: string
  url: string
  title: string
  viewportWidth: number
  viewportHeight: number
  tagName: string
  selector: string
  selectorConfidence: 'unique-id' | 'unique-class' | 'fallback'
  attributes: Record<string, string>
  textContent: string
  textTruncated: boolean
  boundingBox: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface BrowserTabTitleChangedPayload {
  browserTabId: string
  title: string
}

export interface AnnotationMarkerClickedPayload {
  browserTabId: string
  annotationId: string
}

export interface MarkerAnnotation {
  id: string
  type: 'region' | 'element'
  x: number
  y: number
  width: number
  height: number
  selector?: string
  boundingBox?: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface BrowserEventSubscription {
  unlisten: () => void
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

export async function browserTabOpenDevtools(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_open_devtools', { tabId })
}


function createBrowserEventSubscription<T>(
  eventName: string,
  callback: (payload: T) => void
): BrowserEventSubscription {
  let resolvedUnlisten: UnlistenFn | null = null
  let unlistenCalledEarly = false

  void listen<T>(eventName, (event) => {
    callback(event.payload)
  })
    .then((unlisten) => {
      if (unlistenCalledEarly) {
        unlisten()
        return
      }
      resolvedUnlisten = unlisten
    })
    .catch(console.error)

  return {
    unlisten: () => {
      if (resolvedUnlisten) {
        resolvedUnlisten()
        resolvedUnlisten = null
      } else {
        unlistenCalledEarly = true
      }
    }
  }
}

export async function browserTabInjectAnnotation(
  tabId: string,
  mode: AnnotationSubMode
): Promise<IpcResult<void>> {
  return invoke('browser_tab_inject_annotation', { tabId, mode })
}

export async function browserTabRemoveAnnotationOverlay(tabId: string): Promise<IpcResult<void>> {
  return invoke('browser_tab_remove_annotation_overlay', { tabId })
}

export function onBrowserTabNavigated(
  callback: (payload: BrowserTabNavigatedPayload) => void
): BrowserEventSubscription {
  return createBrowserEventSubscription('browser-tab-navigated', callback)
}

export function onBrowserTabLoaded(
  callback: (payload: BrowserTabLoadedPayload) => void
): BrowserEventSubscription {
  return createBrowserEventSubscription('browser-tab-loaded', callback)
}

export function onBrowserTabRegionCaptured(
  callback: (payload: RegionCapturedPayload) => void
): BrowserEventSubscription {
  return createBrowserEventSubscription('browser-tab-region-captured', callback)
}

export function onBrowserTabElementCaptured(
  callback: (payload: ElementCapturedPayload) => void
): BrowserEventSubscription {
  return createBrowserEventSubscription('browser-tab-element-captured', callback)
}

export function onBrowserTabTitleChanged(
  callback: (payload: BrowserTabTitleChangedPayload) => void
): BrowserEventSubscription {
  return createBrowserEventSubscription('browser-tab-title-changed', callback)
}

export async function browserTabInjectAnnotationMarkers(
  tabId: string,
  annotations: MarkerAnnotation[],
  selectedId: string | null
): Promise<IpcResult<void>> {
  return invoke('browser_tab_inject_annotation_markers', { tabId, annotationsJson: JSON.stringify(annotations), selectedId })
}

export async function browserTabUpdateAnnotationMarkerSelection(
  tabId: string,
  selectedId: string | null
): Promise<IpcResult<void>> {
  return invoke('browser_tab_update_annotation_marker_selection', { tabId, selectedId })
}

export function onBrowserTabAnnotationMarkerClicked(
  callback: (payload: AnnotationMarkerClickedPayload) => void
): BrowserEventSubscription {
  return createBrowserEventSubscription('browser-tab-annotation-marker-clicked', callback)
}
