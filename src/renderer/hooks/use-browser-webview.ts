import { useCallback, useEffect, useRef } from 'react'
import {
  browserTabCreate,
  browserTabDestroy,
  browserTabHide,
  browserTabNavigate,
  browserTabResize,
  browserTabShow,
  onBrowserTabLoaded,
  onBrowserTabNavigated
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
  const mountTokenRef = useRef(0)
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
    mountTokenRef.current += 1
    const mountToken = mountTokenRef.current
    const el = containerRef.current
    if (!el) return

    // Set loading true before creating
    useBrowserSessionStore.getState().setLoading(browserTabId, true)
    armLoadingTimeout()

    const bounds = getElementBounds(el)
    browserTabCreate(browserTabId, urlRef.current, bounds)
      .then((result) => {
        if (!mountedRef.current || mountToken !== mountTokenRef.current) {
          browserTabDestroy(browserTabId).catch(console.error)
          return
        }
        if (result.success) {
          createdRef.current = true
          // Resync bounds after creation. The container was measured once at
          // call time (before browserTabCreate above), but the pane layout can
          // still be mid-transition — pane wrappers use `transition-all
          // duration-150` (PaneContent) — or otherwise unsettled when the
          // async create resolves. Without a re-measure the native webview
          // keeps stale creation bounds and overflows into the adjacent pane
          // (issue #644). Poll across frames until the rect stops changing
          // (or a frame budget elapses) so we adopt *settled*, not transient,
          // bounds — then reveal. Mirrors ConnectedTerminal's
          // waitForStableLayout approach for the same class of race.
          const MAX_RESYNC_WAIT_FRAMES = 30 // ~0.5s at 60fps; covers the 150ms transition
          let prev: BrowserBounds | null = null
          let frames = 0
          const resyncAndShow = (): void => {
            if (!mountedRef.current || mountToken !== mountTokenRef.current) return
            const elNow = containerRef.current
            if (!elNow) return
            const next = getElementBounds(elNow)
            // Wait until the rect is stable across two consecutive frames so a
            // still-animating transition doesn't leave us at an intermediate size.
            const stable = prev !== null && prev.width === next.width && prev.height === next.height
            prev = next
            frames += 1
            if (!stable && frames < MAX_RESYNC_WAIT_FRAMES) {
              requestAnimationFrame(resyncAndShow)
              return
            }
            // Settled (or budget exhausted): resync via the shared helper so the
            // result.success branch is inspected (no silent failure), then show.
            updateBounds()
            if (visibilityRef.current) {
              browserTabShow(browserTabId)
                .then((r) => {
                  if (!r.success) console.error('[BrowserWebview] show failed:', r.error)
                })
                .catch(console.error)
            } else {
              browserTabHide(browserTabId)
                .then((r) => {
                  if (!r.success) console.error('[BrowserWebview] hide failed:', r.error)
                })
                .catch(console.error)
            }
          }
          requestAnimationFrame(resyncAndShow)
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
      mountTokenRef.current += 1
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
  }, [browserTabId, clearLoadingTimeout, armLoadingTimeout, updateBounds])

  // Show / hide on visibility change
  useEffect(() => {
    visibilityRef.current = isVisible
    if (!createdRef.current) return
    if (isVisible) {
      updateBounds()
      browserTabShow(browserTabId)
        .then((r) => {
          if (!r.success) console.error('[BrowserWebview] show failed:', r.error)
        })
        .catch(console.error)
    } else {
      browserTabHide(browserTabId)
        .then((r) => {
          if (!r.success) console.error('[BrowserWebview] hide failed:', r.error)
        })
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
  }, [url, browserTabId, clearLoadingTimeout, armLoadingTimeout])

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
    const navSubscription = onBrowserTabNavigated((payload) => {
      if (payload.browserTabId === browserTabId) {
        urlRef.current = payload.url
        useBrowserSessionStore.getState().updateUrl(browserTabId, payload.url)
      }
    })
    const loadedSubscription = onBrowserTabLoaded((payload) => {
      if (payload.browserTabId === browserTabId) {
        clearLoadingTimeout()
        useBrowserSessionStore.getState().setLoading(browserTabId, false)
      }
    })

    return () => {
      navSubscription.unlisten()
      loadedSubscription.unlisten()
      clearLoadingTimeout()
    }
  }, [browserTabId, clearLoadingTimeout])

  return { containerRef }
}
