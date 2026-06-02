import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import { useAnnotationCapture } from '@/hooks/use-annotation-capture'
import { useAnnotationMarkers } from '@/hooks/use-annotation-markers'
import { useBrowserWebview } from '@/hooks/use-browser-webview'
import {
  browserTabHide,
  browserTabInjectAnnotation,
  browserTabRemoveAnnotationOverlay,
  browserTabShow,
  onBrowserTabLoaded,
  onBrowserTabTitleChanged
} from '@/lib/browser-api'
import { cn } from '@/lib/utils'
import { EMPTY_ANNOTATION_ARRAY, normalizeUrl, useAnnotationStore } from '@/stores/annotation-store'
import { type AnnotationSubMode, useBrowserSessionStore } from '@/stores/browser-session-store'
import { AnnotationExportModal } from './AnnotationExportModal'
import { AnnotationPanel } from './AnnotationPanel'
import { BrowserControls } from './BrowserControls'

interface BrowserPanelProps {
  browserTabId: string
  isVisible: boolean
}

const DEFAULT_URL = 'https://www.google.com'
const ANNOTATION_UNAVAILABLE_MESSAGE =
  'Annotation mode is not available on this page due to security policies'

export function BrowserPanel({ browserTabId, isVisible }: BrowserPanelProps): React.JSX.Element {
  const url = useBrowserSessionStore((state) => state.tabs.get(browserTabId)?.url || DEFAULT_URL)
  const tabTitle = useBrowserSessionStore((state) => state.tabs.get(browserTabId)?.title ?? '')
  const loading = useBrowserSessionStore((state) => state.tabs.get(browserTabId)?.loading ?? false)
  const annotationMode = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.annotationMode ?? false
  )
  const annotationSubMode = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.annotationSubMode ?? 'draw'
  )

  const [exportOpen, setExportOpen] = useState(false)
  const webviewWasVisibleRef = useRef(false)

  const annotations = useAnnotationStore(
    useShallow((state) => {
      if (!url) return EMPTY_ANNOTATION_ARRAY
      return state.getAnnotationsForUrl(url)
    })
  )

  const handleAddNote = useCallback(() => {
    if (!url) return
    const normalizedUrl = normalizeUrl(url)
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080

    useAnnotationStore.getState().addAnnotation({
      browserTabId,
      url,
      normalizedUrl,
      pageTitle: tabTitle || '',
      type: 'note',
      geometry: { type: 'point', x: 0, y: 0 },
      intent: 'question',
      severity: 'suggestion',
      description: '',
      viewportWidth,
      viewportHeight
    })
  }, [browserTabId, url, tabTitle])

  const handleOpenExport = useCallback(() => {
    if (exportOpen) return
    browserTabHide(browserTabId)
      .then((result) => {
        if (result.success) {
          webviewWasVisibleRef.current = true
        }
      })
      .catch(console.error)
    setExportOpen(true)
  }, [browserTabId, exportOpen])

  const handleCloseExport = useCallback(
    (open: boolean) => {
      setExportOpen(open)
      if (!open && webviewWasVisibleRef.current) {
        if (isVisible) {
          browserTabShow(browserTabId).catch(console.error)
        }
        webviewWasVisibleRef.current = false
      }
    },
    [browserTabId, isVisible]
  )

  const handleExitAnnotationMode = useCallback(() => {
    useBrowserSessionStore.getState().setAnnotationMode(browserTabId, false)
  }, [browserTabId])

  const handleChangeAnnotationSubMode = useCallback(
    (mode: AnnotationSubMode) => {
      useBrowserSessionStore.getState().setAnnotationSubMode(browserTabId, mode)
    },
    [browserTabId]
  )

  const { containerRef } = useBrowserWebview(browserTabId, isVisible, url)
  const injectedModeRef = useRef<AnnotationSubMode | null>(null)
  const desiredModeRef = useRef<AnnotationSubMode | null>(null)
  const reconcileChainRef = useRef<Promise<void>>(Promise.resolve())
  const [annotationOverlayAvailable, setAnnotationOverlayAvailable] = useState(true)

  // Subscribe to annotation capture events
  useAnnotationCapture(browserTabId)

  // Mount annotation markers hook
  useAnnotationMarkers(browserTabId, isVisible, normalizeUrl(url))

  // Listen for title changes and update store
  useEffect(() => {
    const subscription = onBrowserTabTitleChanged((payload) => {
      if (payload.browserTabId === browserTabId) {
        useBrowserSessionStore.getState().updateTitle(browserTabId, payload.title)
      }
    })
    return () => subscription.unlisten()
  }, [browserTabId])

  // Serialized overlay reconciler.
  //
  // Overlay presence is tracked in three places that drift apart under rapid
  // tab/project switches: this renderer ref, the Rust `annotation_injected` map,
  // and the live webview DOM. The fix is to (1) keep a single `desiredModeRef`
  // describing what SHOULD be injected (a mode, or null for "removed"), and
  // (2) funnel every inject/remove IPC through one promise chain so a hide's
  // remove always settles before a later show's inject. Each reconcile pass
  // re-reads the latest desired state, so stale in-flight passes converge on the
  // newest intent instead of clobbering it.
  const reconcileOverlay = useCallback(() => {
    const run = async () => {
      // Tracks a mode we tore down specifically to switch modes, so a failed
      // re-inject can roll the store's submode back to the last working mode
      // (preserves the pre-existing rollback-on-mode-change behavior).
      let tornDownForSwitch: AnnotationSubMode | null = null

      // Loop until the actual injected mode matches the latest desired mode.
      // Re-reading desiredModeRef each iteration absorbs intent changes that
      // landed while a prior IPC was in flight.
      for (;;) {
        const desired = desiredModeRef.current
        const current = injectedModeRef.current

        if (desired === current) return

        if (desired === null) {
          await browserTabRemoveAnnotationOverlay(browserTabId).catch(console.error)
          injectedModeRef.current = null
          continue
        }

        // Switching modes requires a clean teardown first so the overlay rewires
        // handlers for the new mode rather than reconciling in place.
        if (current !== null) {
          tornDownForSwitch = current
          await browserTabRemoveAnnotationOverlay(browserTabId).catch(console.error)
          injectedModeRef.current = null
          // Desired may have changed during the await; re-evaluate from the top.
          continue
        }

        const result = await browserTabInjectAnnotation(browserTabId, desired)
        if (result.success) {
          injectedModeRef.current = desired
          setAnnotationOverlayAvailable(true)
        } else {
          injectedModeRef.current = null
          setAnnotationOverlayAvailable(false)
          toast.error(ANNOTATION_UNAVAILABLE_MESSAGE)
          // Desired injection is impossible on this page; stop retrying.
          desiredModeRef.current = null
          // If this failure was a mode switch, roll the submode back to the last
          // working mode (re-triggers reconcile to restore the prior overlay).
          if (tornDownForSwitch && tornDownForSwitch !== desired) {
            useBrowserSessionStore.getState().setAnnotationSubMode(browserTabId, tornDownForSwitch)
          }
          return
        }
      }
    }

    // Chain onto the previous reconcile so overlay IPC never overlaps.
    const next = reconcileChainRef.current.then(run, run)
    reconcileChainRef.current = next
    return next
  }, [browserTabId])

  useEffect(() => {
    if (!annotationMode || !isVisible || loading) {
      // Loading is transient: only force removal when annotation is actually off
      // or the panel is hidden. While loading with annotation on, leave the
      // desired mode intact so the post-load effect re-injects.
      if (!annotationMode || !isVisible) {
        desiredModeRef.current = null
      }
      void reconcileOverlay()
      return
    }

    desiredModeRef.current = annotationSubMode
    void reconcileOverlay()
  }, [annotationMode, annotationSubMode, loading, isVisible, reconcileOverlay])

  // Re-inject overlay when page loads while annotation mode is enabled.
  // The webview's prior overlay is gone after navigation, so reset the actual
  // state and let the serialized reconciler drive it back to the desired mode.
  useEffect(() => {
    const subscription = onBrowserTabLoaded((payload) => {
      if (payload.browserTabId !== browserTabId) return
      injectedModeRef.current = null
      desiredModeRef.current = annotationMode && isVisible ? annotationSubMode : null
      void reconcileOverlay()
    })
    return () => subscription.unlisten()
  }, [annotationMode, annotationSubMode, browserTabId, isVisible, reconcileOverlay])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      desiredModeRef.current = null
      void reconcileOverlay()
    }
  }, [reconcileOverlay])

  return (
    <div
      className={cn(
        'w-full h-full flex flex-col',
        isVisible ? 'visible' : 'invisible absolute inset-0'
      )}
    >
      {isVisible && <BrowserControls browserTabId={browserTabId} />}
      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="flex-1 bg-background relative">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10 motion-safe:animate-fade-in">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="mt-2 text-sm text-muted-foreground">Loading...</span>
            </div>
          )}
        </div>
        {annotationMode && (
          <AnnotationPanel
            url={url}
            annotationSubMode={annotationSubMode}
            annotationOverlayAvailable={annotationOverlayAvailable}
            onExitAnnotationMode={handleExitAnnotationMode}
            onChangeAnnotationSubMode={handleChangeAnnotationSubMode}
            onAddNote={handleAddNote}
            onExport={handleOpenExport}
          />
        )}
      </div>
      <AnnotationExportModal
        open={exportOpen}
        onOpenChange={handleCloseExport}
        annotations={annotations}
      />
    </div>
  )
}
