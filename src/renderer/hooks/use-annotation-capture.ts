import { useEffect } from 'react'
import {
  onBrowserTabRegionCaptured,
  onBrowserTabElementCaptured,
  type RegionCapturedPayload,
  type ElementCapturedPayload,
} from '@/lib/browser-api'
import { useAnnotationStore, normalizeUrl } from '@/stores/annotation-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

export function useAnnotationCapture(browserTabId: string) {
  useEffect(() => {
    const regionSubscription = onBrowserTabRegionCaptured((payload: RegionCapturedPayload) => {
      if (payload.browserTabId !== browserTabId) return

      const tab = useBrowserSessionStore.getState().getTab(browserTabId)
      if (!tab) return

      const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1920
      const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 1080
      const normalizedUrl = normalizeUrl(tab.url)

      useAnnotationStore.getState().addAnnotation({
        browserTabId,
        url: tab.url,
        normalizedUrl,
        pageTitle: tab.title || '',
        type: 'region',
        geometry: {
          type: 'rect',
          x: payload.x,
          y: payload.y,
          width: payload.width,
          height: payload.height,
        },
        intent: 'question',
        severity: 'suggestion',
        description: '',
        viewportWidth,
        viewportHeight,
      })
    })

    const elementSubscription = onBrowserTabElementCaptured((payload: ElementCapturedPayload) => {
      if (payload.browserTabId !== browserTabId) return

      const normalizedUrl = normalizeUrl(payload.url)

      useAnnotationStore.getState().addAnnotation({
        browserTabId,
        url: payload.url,
        normalizedUrl,
        pageTitle: payload.title,
        type: 'element',
        geometry: {
          type: 'element',
          tagName: payload.tagName,
          selector: payload.selector,
          selectorConfidence: payload.selectorConfidence,
          attributes: payload.attributes,
          textContent: payload.textContent,
          textTruncated: payload.textTruncated,
          boundingBox: {
            x: payload.boundingBox.x,
            y: payload.boundingBox.y,
            width: payload.boundingBox.width,
            height: payload.boundingBox.height,
          },
        },
        intent: 'question',
        severity: 'suggestion',
        description: '',
        viewportWidth: payload.viewportWidth,
        viewportHeight: payload.viewportHeight,
      })
    })

    return () => {
      regionSubscription.unlisten()
      elementSubscription.unlisten()
    }
  }, [browserTabId])
}
