import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MarkerAnnotation } from './browser-api'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  browserTabInjectAnnotationMarkers,
  browserTabUpdateAnnotationMarkerSelection,
  onBrowserTabAnnotationMarkerClicked,
} from './browser-api'

describe('browser-api marker wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('browserTabInjectAnnotationMarkers', () => {
    it('invokes with serialized annotations and selectedId', async () => {
      const annotations: MarkerAnnotation[] = [
        { id: 'anno-1', type: 'region', x: 10, y: 20, width: 100, height: 50 },
        { id: 'anno-2', type: 'element', x: 5, y: 10, width: 200, height: 40, selector: '#btn' },
      ]

      ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: undefined })

      const result = await browserTabInjectAnnotationMarkers('tab-1', annotations, 'anno-1')

      expect(invoke).toHaveBeenCalledWith('browser_tab_inject_annotation_markers', {
        tabId: 'tab-1',
        annotationsJson: JSON.stringify(annotations),
        selectedId: 'anno-1',
      })
      expect(result.success).toBe(true)
    })

    it('invokes with null selectedId', async () => {
      ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: undefined })

      await browserTabInjectAnnotationMarkers('tab-1', [], null)

      expect(invoke).toHaveBeenCalledWith('browser_tab_inject_annotation_markers', {
        tabId: 'tab-1',
        annotationsJson: '[]',
        selectedId: null,
      })
    })

    it('returns error on failure', async () => {
      ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false, error: 'Inject failed', code: 'INJECT_FAILED' })

      const result = await browserTabInjectAnnotationMarkers('tab-1', [], null)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Inject failed')
      }
    })
  })

  describe('browserTabUpdateAnnotationMarkerSelection', () => {
    it('invokes with selectedId', async () => {
      ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: undefined })

      const result = await browserTabUpdateAnnotationMarkerSelection('tab-1', 'anno-1')

      expect(invoke).toHaveBeenCalledWith('browser_tab_update_annotation_marker_selection', {
        tabId: 'tab-1',
        selectedId: 'anno-1',
      })
      expect(result.success).toBe(true)
    })

    it('invokes with null selectedId', async () => {
      ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, data: undefined })

      await browserTabUpdateAnnotationMarkerSelection('tab-1', null)

      expect(invoke).toHaveBeenCalledWith('browser_tab_update_annotation_marker_selection', {
        tabId: 'tab-1',
        selectedId: null,
      })
    })
  })

  describe('onBrowserTabAnnotationMarkerClicked', () => {
    it('creates subscription with correct event name', () => {
      const mockUnlisten = vi.fn()
      ;(listen as ReturnType<typeof vi.fn>).mockResolvedValue(mockUnlisten)

      const callback = vi.fn()
      const sub = onBrowserTabAnnotationMarkerClicked(callback)

      expect(listen).toHaveBeenCalledWith('browser-tab-annotation-marker-clicked', expect.any(Function))
      expect(sub).toHaveProperty('unlisten')

      sub.unlisten()
      expect(sub.unlisten).toBeDefined()
    })

    it('calls callback with payload', async () => {
      const mockUnlisten = vi.fn()
      let listenerHandler: ((event: { payload: unknown }) => void) | null = null

      ;(listen as ReturnType<typeof vi.fn>).mockImplementation(async (_name: string, handler: unknown) => {
        listenerHandler = handler as (event: { payload: unknown }) => void
        return mockUnlisten
      })

      const callback = vi.fn()
      onBrowserTabAnnotationMarkerClicked(callback)

      await new Promise((r) => setTimeout(r, 10))

      expect(listenerHandler).not.toBeNull()
      listenerHandler!({ payload: { browserTabId: 'tab-1', annotationId: 'anno-1' } })

      expect(callback).toHaveBeenCalledWith({ browserTabId: 'tab-1', annotationId: 'anno-1' })
    })
  })
})
