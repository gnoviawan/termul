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
import { logFrontendError } from '@/lib/log-api'
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

  const updateBounds = useCallback((): Promise<void> => {
    const el = containerRef.current
    if (!el || !createdRef.current) return Promise.resolve()
    const bounds = getElementBounds(el)
    return browserTabResize(browserTabId, bounds)
      .then((result) => {
        if (!result.success) {
          void logFrontendError({
            message: `browserTabResize failed for tab ${browserTabId}: ${result.error}`,
            source: 'useBrowserWebview'
          })
        }
      })
      .catch((err) => {
        void logFrontendError({
          message: `browserTabResize rejected for tab ${browserTabId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          source: 'useBrowserWebview'
        })
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
          browserTabDestroy(browserTabId).catch((e) => {
            void logFrontendError({
              message: `browserTabDestroy after stale mount for tab ${browserTabId}: ${
                e instanceof Error ? e.message : String(e)
              }`,
              source: 'useBrowserWebview'
            })
          })
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
          const resyncAndShow = async (): Promise<void> => {
            if (!mountedRef.current || mountToken !== mountTokenRef.current) return
            const elNow = containerRef.current
            if (!elNow) return
            const next = getElementBounds(elNow)
            // Wait until the full rect (position + size) is stable across two
            // consecutive frames: a same-size container can still MOVE during a
            // layout transition (sidebar toggle, gutter drag), so x/y must
            // settle too, not just width/height.
            const stable =
              prev !== null &&
              prev.x === next.x &&
              prev.y === next.y &&
              prev.width === next.width &&
              prev.height === next.height
            prev = next
            frames += 1
            if (!stable && frames < MAX_RESYNC_WAIT_FRAMES) {
              requestAnimationFrame(() => {
                void resyncAndShow()
              })
              return
            }
            // Settled (or budget exhausted): resync via the shared helper so the
            // result.success branch is inspected (no silent failure), then
            // reveal. Await the resize before showing so the webview is never
            // revealed at stale creation bounds.
            await updateBounds()
            if (visibilityRef.current) {
              browserTabShow(browserTabId)
                .then((r) => {
                  if (!r.success) {
                    void logFrontendError({
                      message: `browserTabShow failed for tab ${browserTabId}: ${r.error}`,
                      source: 'useBrowserWebview'
                    })
                  }
                })
                .catch((err) => {
                  void logFrontendError({
                    message: `browserTabShow rejected for tab ${browserTabId}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                    source: 'useBrowserWebview'
                  })
                })
            } else {
              browserTabHide(browserTabId)
                .then((r) => {
                  if (!r.success) {
                    void logFrontendError({
                      message: `browserTabHide failed for tab ${browserTabId}: ${r.error}`,
                      source: 'useBrowserWebview'
                    })
                  }
                })
                .catch((err) => {
                  void logFrontendError({
                    message: `browserTabHide rejected for tab ${browserTabId}: ${
                      err instanceof Error ? err.message : String(err)
                    }`,
                    source: 'useBrowserWebview'
                  })
                })
            }
          }
          requestAnimationFrame(() => {
            void resyncAndShow()
          })
        } else {
          void logFrontendError({
            message: `browserTabCreate failed for tab ${browserTabId}: ${result.error ?? 'unknown'} [${result.code ?? 'NO_CODE'}]`,
            source: 'useBrowserWebview'
          })
          clearLoadingTimeout()
          useBrowserSessionStore.getState().setLoading(browserTabId, false)
        }
      })
      .catch((err) => {
        void logFrontendError({
          message: `browserTabCreate rejected for tab ${browserTabId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          source: 'useBrowserWebview'
        })
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
            void logFrontendError({
              message: `browserTabDestroy failed for tab ${browserTabId}: ${result.error ?? 'unknown'}`,
              source: 'useBrowserWebview'
            })
          }
        })
        .catch((e) => {
          void logFrontendError({
            message: `browserTabDestroy rejected for tab ${browserTabId}: ${
              e instanceof Error ? e.message : String(e)
            }`,
            source: 'useBrowserWebview'
          })
        })
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
          if (!r.success) {
            void logFrontendError({
              message: `browserTabShow failed for tab ${browserTabId}: ${r.error}`,
              source: 'useBrowserWebview'
            })
          }
        })
        .catch((err) => {
          void logFrontendError({
            message: `browserTabShow rejected for tab ${browserTabId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            source: 'useBrowserWebview'
          })
        })
    } else {
      browserTabHide(browserTabId)
        .then((r) => {
          if (!r.success) {
            void logFrontendError({
              message: `browserTabHide failed for tab ${browserTabId}: ${r.error}`,
              source: 'useBrowserWebview'
            })
          }
        })
        .catch((err) => {
          void logFrontendError({
            message: `browserTabHide rejected for tab ${browserTabId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            source: 'useBrowserWebview'
          })
        })
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
          void logFrontendError({
            message: `browserTabNavigate failed for tab ${browserTabId}: ${result.error}`,
            source: 'useBrowserWebview'
          })
          clearLoadingTimeout()
          useBrowserSessionStore.getState().setLoading(browserTabId, false)
        }
      })
      .catch((err) => {
        void logFrontendError({
          message: `browserTabNavigate rejected for tab ${browserTabId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          source: 'useBrowserWebview'
        })
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
