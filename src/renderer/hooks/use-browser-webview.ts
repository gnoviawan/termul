import { useEffect, useRef, useCallback } from 'react'
import {
  browserTabCreate,
  browserTabDestroy,
  browserTabHide,
  browserTabNavigate,
  browserTabResize,
  browserTabShow,
  onBrowserTabNavigated,
  onBrowserTabLoaded,
} from '@/lib/browser-api'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

function getElementBounds(el: HTMLElement): BrowserBounds {
  const rect = el.getBoundingClientRect()
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  }
}

export function useBrowserWebview(browserTabId: string, isVisible: boolean, url: string) {
  const containerRef = useRef<HTMLDivElement>(null)
  const createdRef = useRef(false)
  const mountedRef = useRef(true)
  const urlRef = useRef(url)
  const visibilityRef = useRef(isVisible)
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearLoadingTimeout = useCallback(() => {
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current)
      loadingTimeoutRef.current = null
    }
  }, [])

  const armLoadingTimeout = useCallback(() => {
    clearLoadingTimeout()
    loadingTimeoutRef.current = setTimeout(() => {
      useBrowserSessionStore.getState().setLoading(browserTabId, false)
      loadingTimeoutRef.current = null
    }, 6000)
  }, [browserTabId, clearLoadingTimeout])

  const updateBounds = useCallback(() => {
    const el = containerRef.current
    if (!el || !createdRef.current) return
    const bounds = getElementBounds(el)
    browserTabResize(browserTabId, bounds)
      .then((result) => {
        if (!result.success) {
          console.error('[BrowserWebview] resize failed:', result.error)
        }
      })
      .catch((err) => {
        console.error('[BrowserWebview] resize error:', err)
      })
  }, [browserTabId])

  // Create / destroy webview lifecycle
  useEffect(() => {
    mountedRef.current = true
    const el = containerRef.current
    if (!el) return

    // Set loading true before creating
    useBrowserSessionStore.getState().setLoading(browserTabId, true)
    armLoadingTimeout()

    const bounds = getElementBounds(el)
    browserTabCreate(browserTabId, urlRef.current, bounds)
      .then((result) => {
        if (!mountedRef.current) {
          browserTabDestroy(browserTabId).catch(console.error)
          return
        }
        if (result.success) {
          createdRef.current = true
          if (visibilityRef.current) {
            browserTabShow(browserTabId)
              .then((r) => { if (!r.success) console.error('[BrowserWebview] show failed:', r.error) })
              .catch(console.error)
          } else {
            browserTabHide(browserTabId)
              .then((r) => { if (!r.success) console.error('[BrowserWebview] hide failed:', r.error) })
              .catch(console.error)
          }
        } else {
          console.error('[BrowserWebview] create failed:', result.error)
          clearLoadingTimeout()
          useBrowserSessionStore.getState().setLoading(browserTabId, false)
        }
      })
      .catch((err) => {
        console.error('[BrowserWebview] create error:', err)
        clearLoadingTimeout()
        useBrowserSessionStore.getState().setLoading(browserTabId, false)
      })

    return () => {
      mountedRef.current = false
      clearLoadingTimeout()
      browserTabDestroy(browserTabId)
        .then((result) => {
          if (!result.success) {
            console.error('[BrowserWebview] destroy failed:', result.error)
          }
        })
        .catch(console.error)
      createdRef.current = false
    }
  }, [browserTabId])

  // Show / hide on visibility change
  useEffect(() => {
    visibilityRef.current = isVisible
    if (!createdRef.current) return
    if (isVisible) {
      updateBounds()
      browserTabShow(browserTabId)
        .then((r) => { if (!r.success) console.error('[BrowserWebview] show failed:', r.error) })
        .catch(console.error)
    } else {
      browserTabHide(browserTabId)
        .then((r) => { if (!r.success) console.error('[BrowserWebview] hide failed:', r.error) })
        .catch(console.error)
    }
  }, [isVisible, browserTabId, updateBounds])

  // Navigate when url prop changes externally
  useEffect(() => {
    if (url === urlRef.current) return
    urlRef.current = url
    if (!createdRef.current) return
    useBrowserSessionStore.getState().setLoading(browserTabId, true)
    armLoadingTimeout()
    browserTabNavigate(browserTabId, url)
      .then((result) => {
        if (!result.success) {
          console.error('[BrowserWebview] navigate failed:', result.error)
          clearLoadingTimeout()
          useBrowserSessionStore.getState().setLoading(browserTabId, false)
        }
      })
      .catch((err) => {
        console.error('[BrowserWebview] navigate error:', err)
        clearLoadingTimeout()
        useBrowserSessionStore.getState().setLoading(browserTabId, false)
      })
  }, [url, browserTabId])

  // Resize observer
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const ro = new ResizeObserver(() => {
      updateBounds()
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
    }
  }, [updateBounds])

  // Listen for URL sync and loaded events from webview poller
  useEffect(() => {
    let disposed = false
    let unlistenNav: () => void = () => {}
    let unlistenLoaded: () => void = () => {}

    const navSubscription = onBrowserTabNavigated((payload) => {
      if (payload.browserTabId === browserTabId) {
        useBrowserSessionStore.getState().updateUrl(browserTabId, payload.url)
      }
    })
    if (disposed) {
      navSubscription.unlisten()
    } else {
      unlistenNav = () => navSubscription.unlisten()
    }

    const loadedSubscription = onBrowserTabLoaded((payload) => {
      if (payload.browserTabId === browserTabId) {
        clearLoadingTimeout()
        useBrowserSessionStore.getState().setLoading(browserTabId, false)
      }
    })
    if (disposed) {
      loadedSubscription.unlisten()
    } else {
      unlistenLoaded = () => loadedSubscription.unlisten()
    }

    return () => {
      disposed = true
      unlistenNav()
      unlistenLoaded()
      clearLoadingTimeout()
    }
  }, [browserTabId, clearLoadingTimeout])

  return { containerRef }
}
