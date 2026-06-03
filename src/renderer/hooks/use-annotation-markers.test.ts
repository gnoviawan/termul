import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserTabInjectAnnotationMarkers,
  browserTabUpdateAnnotationMarkerSelection,
  onBrowserTabAnnotationMarkerClicked,
  onBrowserTabLoaded
} from '@/lib/browser-api'
import { useAnnotationStore } from '@/stores/annotation-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useAnnotationMarkers } from './use-annotation-markers'

// Mock all browser API functions
vi.mock('@/lib/browser-api', () => ({
  browserTabInjectAnnotationMarkers: vi.fn().mockResolvedValue({ success: true }),
  browserTabUpdateAnnotationMarkerSelection: vi.fn().mockResolvedValue({ success: true }),
  onBrowserTabAnnotationMarkerClicked: vi.fn(),
  onBrowserTabLoaded: vi.fn()
}))

const mockOnMarkerClicked = onBrowserTabAnnotationMarkerClicked as ReturnType<typeof vi.fn>
const mockOnBrowserTabLoaded = onBrowserTabLoaded as ReturnType<typeof vi.fn>

// Helper to setup browser tab state
function setupBrowserTab(tabId: string, annotationMode: boolean, options?: { url?: string }) {
  useBrowserSessionStore.getState().createTab(tabId, options?.url)
  if (annotationMode) {
    useBrowserSessionStore.getState().setAnnotationMode(tabId, true)
  }
}

// Helper to add a region annotation
function addRegionAnnotation(normalizedUrl: string, tabId: string, id = 'anno-1') {
  const store = useAnnotationStore.getState()
  // addAnnotation generates a random UUID, so we use the store directly to set data
  const annotations = store.annotationsByUrl.get(normalizedUrl) ?? []
  const newAnnotations = [
    ...annotations,
    {
      id,
      browserTabId: tabId,
      url: 'https://example.com',
      normalizedUrl,
      pageTitle: 'Example',
      type: 'region' as const,
      geometry: { type: 'rect' as const, x: 10, y: 20, width: 100, height: 50 },
      intent: 'question' as const,
      severity: 'suggestion' as const,
      description: 'Test',
      viewportWidth: 1920,
      viewportHeight: 1080,
      schemaVersion: 1 as const,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ]
  const next = new Map(store.annotationsByUrl)
  next.set(normalizedUrl, newAnnotations)
  useAnnotationStore.setState({ annotationsByUrl: next })
}

// Helper to add an element annotation
function _addElementAnnotation(normalizedUrl: string, tabId: string, id = 'anno-elem') {
  const store = useAnnotationStore.getState()
  const annotations = store.annotationsByUrl.get(normalizedUrl) ?? []
  const newAnnotations = [
    ...annotations,
    {
      id,
      browserTabId: tabId,
      url: 'https://example.com',
      normalizedUrl,
      pageTitle: 'Example',
      type: 'element' as const,
      geometry: {
        type: 'element' as const,
        tagName: 'button',
        selector: '#btn',
        selectorConfidence: 'unique-id' as const,
        attributes: { id: 'btn' },
        textContent: 'Click',
        textTruncated: false,
        boundingBox: { x: 50, y: 60, width: 100, height: 40 }
      },
      intent: 'fix' as const,
      severity: 'blocking' as const,
      description: 'Element',
      viewportWidth: 1920,
      viewportHeight: 1080,
      schemaVersion: 1 as const,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
  ]
  const next = new Map(store.annotationsByUrl)
  next.set(normalizedUrl, newAnnotations)
  useAnnotationStore.setState({ annotationsByUrl: next })
}

describe('useAnnotationMarkers', () => {
  beforeEach(() => {
    // Reset stores
    useAnnotationStore.setState({
      annotationsByUrl: new Map(),
      selectedAnnotationIdByUrl: new Map()
    })
    useBrowserSessionStore.setState({ tabs: new Map() })

    // Reset mocks
    vi.clearAllMocks()
    ;(browserTabInjectAnnotationMarkers as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })
    ;(browserTabUpdateAnnotationMarkerSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })

    // Default mock for onMarkerClicked — returns a subscription object
    mockOnMarkerClicked.mockReturnValue({ unlisten: vi.fn() })
    // Default mock for onBrowserTabLoaded — returns a subscription object
    mockOnBrowserTabLoaded.mockReturnValue({ unlisten: vi.fn() })
  })

  describe('no-regression selection updates', () => {
    it('calls browserTabInjectAnnotationMarkers when annotations change', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      const { rerender, unmount } = renderHook(
        ({ tabId, visible, url }: { tabId: string; visible: boolean; url: string }) =>
          useAnnotationMarkers(tabId, visible, url),
        {
          initialProps: {
            tabId: 'tab-1',
            visible: true,
            url: normalizedUrl
          }
        }
      )

      await act(async () => {
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-1')
        rerender({ tabId: 'tab-1', visible: true, url: normalizedUrl })
      })

      // RAF coalescing means we need to wait for the next frame
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      expect(browserTabInjectAnnotationMarkers).toHaveBeenCalledWith(
        'tab-1',
        expect.any(Array),
        null
      )

      unmount()
    })

    it('calls browserTabUpdateAnnotationMarkerSelection when only selection changes', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      // Add an annotation first
      await act(async () => {
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-1')
      })

      const { rerender, unmount } = renderHook(
        ({ tabId, visible, url }: { tabId: string; visible: boolean; url: string }) =>
          useAnnotationMarkers(tabId, visible, url),
        {
          initialProps: {
            tabId: 'tab-1',
            visible: true,
            url: normalizedUrl
          }
        }
      )

      // Wait for initial marker injection
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      // Clear previous calls
      vi.clearAllMocks()
      ;(browserTabInjectAnnotationMarkers as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      })
      ;(browserTabUpdateAnnotationMarkerSelection as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true
      })

      // Change selection only
      await act(async () => {
        useAnnotationStore.getState().setSelectedAnnotationId(normalizedUrl, 'anno-1')
        rerender({ tabId: 'tab-1', visible: true, url: normalizedUrl })
      })

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      expect(browserTabUpdateAnnotationMarkerSelection).toHaveBeenCalledWith('tab-1', 'anno-1')

      unmount()
    })
  })

  describe('coalesced RAF updates', () => {
    it('coalesces multiple rapid updates into a single IPC call', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      const { rerender, unmount } = renderHook(
        ({ tabId, visible, url }: { tabId: string; visible: boolean; url: string }) =>
          useAnnotationMarkers(tabId, visible, url),
        {
          initialProps: {
            tabId: 'tab-1',
            visible: true,
            url: normalizedUrl
          }
        }
      )

      // Rapidly add multiple annotations — should coalesce into 1 IPC call
      await act(async () => {
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-1')
        rerender({ tabId: 'tab-1', visible: true, url: normalizedUrl })
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-2')
        rerender({ tabId: 'tab-1', visible: true, url: normalizedUrl })
      })

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      // Should have been called at most once (from the final state)
      const injectCalls = (browserTabInjectAnnotationMarkers as ReturnType<typeof vi.fn>).mock.calls
      expect(injectCalls.length).toBeLessThanOrEqual(1)

      unmount()
    })
  })

  describe('stale-ID clearing', () => {
    it('clears selection when selected annotation no longer exists', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      // Set a nonexistent selected annotation
      useAnnotationStore.getState().setSelectedAnnotationId(normalizedUrl, 'nonexistent')

      const { rerender, unmount } = renderHook(
        ({ tabId, visible, url }: { tabId: string; visible: boolean; url: string }) =>
          useAnnotationMarkers(tabId, visible, url),
        {
          initialProps: {
            tabId: 'tab-1',
            visible: true,
            url: normalizedUrl
          }
        }
      )

      // Add a real annotation
      await act(async () => {
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-real')
        rerender({ tabId: 'tab-1', visible: true, url: normalizedUrl })
      })

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      // The stale ID should have been cleared
      const selectedId = useAnnotationStore.getState().selectedAnnotationIdByUrl.get(normalizedUrl)
      expect(selectedId).toBeNull() // or undefined, depending on if clearSelectedAnnotationId was called

      unmount()
    })

    it('does not clear selection when selected annotation exists', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      await act(async () => {
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-1')
      })

      useAnnotationStore.getState().setSelectedAnnotationId(normalizedUrl, 'anno-1')

      const { rerender, unmount } = renderHook(
        ({ tabId, visible, url }: { tabId: string; visible: boolean; url: string }) =>
          useAnnotationMarkers(tabId, visible, url),
        {
          initialProps: {
            tabId: 'tab-1',
            visible: true,
            url: normalizedUrl
          }
        }
      )

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        rerender({ tabId: 'tab-1', visible: true, url: normalizedUrl })
      })

      const selectedId = useAnnotationStore.getState().selectedAnnotationIdByUrl.get(normalizedUrl)
      expect(selectedId).toBe('anno-1')

      unmount()
    })

    it('clears selection when annotation mode turns OFF', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      await act(async () => {
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-1')
      })

      useAnnotationStore.getState().setSelectedAnnotationId(normalizedUrl, 'anno-1')

      const { rerender, unmount } = renderHook(
        ({ tabId, visible, url }: { tabId: string; visible: boolean; url: string }) =>
          useAnnotationMarkers(tabId, visible, url),
        {
          initialProps: {
            tabId: 'tab-1',
            visible: true,
            url: normalizedUrl
          }
        }
      )

      // Turn off annotation mode
      await act(async () => {
        useBrowserSessionStore.getState().setAnnotationMode('tab-1', false)
        rerender({ tabId: 'tab-1', visible: true, url: normalizedUrl })
      })

      const selectedId = useAnnotationStore.getState().selectedAnnotationIdByUrl.get(normalizedUrl)
      expect(selectedId).toBeNull()

      unmount()
    })
  })

  describe('no duplicate IPC calls', () => {
    it('does not call IPC when annotation mode is off', async () => {
      setupBrowserTab('tab-1', false)
      const normalizedUrl = 'https://example.com'

      const { unmount } = renderHook(() => useAnnotationMarkers('tab-1', true, normalizedUrl), {})

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      expect(browserTabInjectAnnotationMarkers).not.toHaveBeenCalled()

      unmount()
    })

    it('does not call IPC when tab is not visible', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-1')

      const { unmount } = renderHook(() => useAnnotationMarkers('tab-1', false, normalizedUrl), {})

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      expect(browserTabInjectAnnotationMarkers).not.toHaveBeenCalled()

      unmount()
    })

    it('subscribes to marker-clicked IPC events', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      const { unmount } = renderHook(() => useAnnotationMarkers('tab-1', true, normalizedUrl), {})

      expect(mockOnMarkerClicked).toHaveBeenCalled()

      unmount()
    })
  })

  describe('marker click handling', () => {
    it('sets selected annotation when marker is clicked for the current tab', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      await act(async () => {
        addRegionAnnotation(normalizedUrl, 'tab-1', 'anno-marker')
      })

      // Capture the callback that the hook registered
      let capturedCallback:
        | ((payload: { browserTabId: string; annotationId: string }) => void)
        | null = null
      mockOnMarkerClicked.mockImplementation(
        (cb: (payload: { browserTabId: string; annotationId: string }) => void) => {
          capturedCallback = cb
          return { unlisten: vi.fn() }
        }
      )

      const { unmount } = renderHook(() => useAnnotationMarkers('tab-1', true, normalizedUrl), {})

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      // Simulate a marker click event for the current tab
      expect(capturedCallback).not.toBeNull()
      act(() => {
        capturedCallback!({ browserTabId: 'tab-1', annotationId: 'anno-marker' })
      })

      const selectedId = useAnnotationStore.getState().selectedAnnotationIdByUrl.get(normalizedUrl)
      expect(selectedId).toBe('anno-marker')

      unmount()
    })

    it('ignores marker click events for other tabs', async () => {
      setupBrowserTab('tab-1', true)
      const normalizedUrl = 'https://example.com'

      let capturedCallback:
        | ((payload: { browserTabId: string; annotationId: string }) => void)
        | null = null
      mockOnMarkerClicked.mockImplementation(
        (cb: (payload: { browserTabId: string; annotationId: string }) => void) => {
          capturedCallback = cb
          return { unlisten: vi.fn() }
        }
      )

      const { unmount } = renderHook(() => useAnnotationMarkers('tab-1', true, normalizedUrl), {})

      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      // Simulate a marker click for a different tab — should be ignored
      act(() => {
        capturedCallback!({ browserTabId: 'tab-2', annotationId: 'other' })
      })

      const selectedId = useAnnotationStore.getState().selectedAnnotationIdByUrl.get(normalizedUrl)
      expect(selectedId).toBeFalsy()

      unmount()
    })
  })
})
