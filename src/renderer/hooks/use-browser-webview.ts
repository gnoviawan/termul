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
          useBrowserSessionStore.getState().setLoading(browserTabId, false)
        }
      })
      .catch((err) => {
        console.error('[BrowserWebview] create error:', err)
        useBrowserSessionStore.getState().setLoading(browserTabId, false)
      })

    return () => {
      mountedRef.current = false
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
    browserTabNavigate(browserTabId, url)
      .then((result) => {
        if (!result.success) {
          console.error('[BrowserWebview] navigate failed:', result.error)
          useBrowserSessionStore.getState().setLoading(browserTabId, false)
        }
      })
      .catch((err) => {
        console.error('[BrowserWebview] navigate error:', err)
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
    let unlistenNav: (() => void) | undefined
    let unlistenLoaded: (() => void) | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    onBrowserTabNavigated((payload) => {
      if (payload.browserTabId === browserTabId) {
        useBrowserSessionStore.getState().updateUrl(browserTabId, payload.url)
      }
    }).then((fn) => { unlistenNav = fn }).catch(console.error)

    onBrowserTabLoaded((payload) => {
      if (payload.browserTabId === browserTabId) {
        useBrowserSessionStore.getState().setLoading(browserTabId, false)
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
      }
    }).then((fn) => { unlistenLoaded = fn }).catch(console.error)

    // Safety timeout: clear loading after 6 seconds regardless
    // (in case the webview poller fails or the page is a slow SPA)
    timeoutId = setTimeout(() => {
      useBrowserSessionStore.getState().setLoading(browserTabId, false)
    }, 6000)

    return () => {
      if (unlistenNav) unlistenNav()
      if (unlistenLoaded) unlistenLoaded()
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [browserTabId])

  return { containerRef }
}
