import { useEffect, useRef } from 'react'
import {
  browserTabInjectAnnotationMarkers,
  browserTabUpdateAnnotationMarkerSelection,
  type MarkerAnnotation,
  onBrowserTabAnnotationMarkerClicked,
  onBrowserTabLoaded
} from '@/lib/browser-api'
import { useAnnotationStore } from '@/stores/annotation-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

export function useAnnotationMarkers(
  browserTabId: string,
  isVisible: boolean,
  normalizedUrl: string
) {
  const annotationMode = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.annotationMode ?? false
  )

  const annotations = useAnnotationStore((state) => state.annotationsByUrl.get(normalizedUrl))
  const selectedId = useAnnotationStore(
    (state) => state.selectedAnnotationIdByUrl.get(normalizedUrl) ?? null
  )

  const pendingRef = useRef(false)
  const rafRef = useRef(0)

  // Clear selection when annotation mode turns OFF
  useEffect(() => {
    if (!annotationMode) {
      useAnnotationStore.getState().clearSelectedAnnotationId(normalizedUrl)
    }
  }, [annotationMode, normalizedUrl])

  // Coalesced marker update via RAF
  const prevAnnotationsRef = useRef<MarkerAnnotation[]>([])
  const prevSelectedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!annotationMode || !isVisible) return

    const annotationList = annotations ?? []

    // Auto-clear stale selection
    if (selectedId !== null) {
      const exists = annotationList.some((a) => a.id === selectedId)
      if (!exists) {
        useAnnotationStore.getState().clearSelectedAnnotationId(normalizedUrl)
      }
    }

    const callRust = () => {
      pendingRef.current = false

      const filtered = annotationList.filter(
        (a): a is typeof a & { type: 'region' | 'element' } =>
          a.type === 'region' || a.type === 'element'
      )

      const markerList: MarkerAnnotation[] = filtered.map((a) => {
        if (a.type === 'region' && a.geometry.type === 'rect') {
          return {
            id: a.id,
            type: 'region' as const,
            x: a.geometry.x,
            y: a.geometry.y,
            width: a.geometry.width,
            height: a.geometry.height
          }
        }
        if (a.type === 'element' && a.geometry.type === 'element') {
          return {
            id: a.id,
            type: 'element' as const,
            x: a.geometry.boundingBox.x,
            y: a.geometry.boundingBox.y,
            width: a.geometry.boundingBox.width,
            height: a.geometry.boundingBox.height,
            selector: a.geometry.selector,
            boundingBox: {
              x: a.geometry.boundingBox.x,
              y: a.geometry.boundingBox.y,
              width: a.geometry.boundingBox.width,
              height: a.geometry.boundingBox.height
            }
          }
        }
        return {
          id: a.id,
          type: 'region' as const,
          x: 0,
          y: 0,
          width: 0,
          height: 0
        }
      })

      const annotationsChanged =
        JSON.stringify(prevAnnotationsRef.current) !== JSON.stringify(markerList)
      const selectedChanged = prevSelectedRef.current !== selectedId

      if (annotationsChanged) {
        prevAnnotationsRef.current = markerList
        prevSelectedRef.current = selectedId
        void browserTabInjectAnnotationMarkers(browserTabId, markerList, selectedId)
      } else if (selectedChanged) {
        prevSelectedRef.current = selectedId
        void browserTabUpdateAnnotationMarkerSelection(browserTabId, selectedId)
      }
    }

    if (pendingRef.current) return
    pendingRef.current = true
    rafRef.current = requestAnimationFrame(callRust)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
        pendingRef.current = false
      }
    }
  }, [annotationMode, isVisible, annotations, selectedId, browserTabId, normalizedUrl])

  // Subscribe to marker-clicked IPC events
  useEffect(() => {
    const subscription = onBrowserTabAnnotationMarkerClicked((payload) => {
      if (payload.browserTabId !== browserTabId) return
      useAnnotationStore.getState().setSelectedAnnotationId(normalizedUrl, payload.annotationId)
    })
    return () => subscription.unlisten()
  }, [browserTabId, normalizedUrl])

  // Reset cached refs on page reload so reinjected overlay receives markers
  useEffect(() => {
    const subscription = onBrowserTabLoaded((payload) => {
      if (payload.browserTabId !== browserTabId) return
      prevAnnotationsRef.current = []
      prevSelectedRef.current = null
    })
    return () => subscription.unlisten()
  }, [browserTabId])
}
