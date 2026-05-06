import { useEffect } from 'react'
import { onBrowserTabRegionCaptured, type RegionCapturedPayload } from '@/lib/browser-api'
import { useAnnotationStore, type AnnotationType, type Intent, type Severity, normalizeUrl } from '@/stores/annotation-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

export function useAnnotationCapture(browserTabId: string) {
  useEffect(() => {
    const subscription = onBrowserTabRegionCaptured((payload: RegionCapturedPayload) => {
      if (payload.browserTabId !== browserTabId) return

      const tab = useBrowserSessionStore.getState().getTab(browserTabId)
      if (!tab) return

      const url = tab.url
      const normalizedUrl = normalizeUrl(url)
      const pageTitle = tab.title || ''

      // Default to current viewport size (best effort)
      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080

      useAnnotationStore.getState().addAnnotation({
        browserTabId,
        url,
        normalizedUrl,
        pageTitle,
        type: 'region' as AnnotationType,
        geometry: {
          type: 'rect',
          x: payload.x,
          y: payload.y,
          width: payload.width,
          height: payload.height,
        },
        intent: 'question' as Intent,
        severity: 'suggestion' as Severity,
        description: '',
        viewportWidth,
        viewportHeight,
      })
    })

    return () => {
      subscription.unlisten()
    }
  }, [browserTabId])
}
