import { describe, it, expect, beforeEach } from 'vitest'
import { useAnnotationStore, normalizeUrl, type Annotation } from './annotation-store'

describe('annotation-store', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAnnotationStore.setState({ annotationsByUrl: new Map() })
  })

  describe('normalizeUrl', () => {
    it('strips tracking params', () => {
      expect(normalizeUrl('https://example.com/?utm_source=newsletter&page=1')).toBe('https://example.com/?page=1')
    })

    it('strips hash anchors', () => {
      expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page')
    })

    it('lowercases host', () => {
      expect(normalizeUrl('https://EXAMPLE.COM/Page')).toBe('https://example.com/Page')
    })

    it('normalizes trailing slash for root', () => {
      expect(normalizeUrl('https://example.com/')).toBe('https://example.com')
    })
  })

  describe('addAnnotation', () => {
    it('creates a region annotation with auto-generated id and timestamps', () => {
      const result = useAnnotationStore.getState().addAnnotation({
        browserTabId: 'tab-1',
        url: 'https://example.com',
        normalizedUrl: normalizeUrl('https://example.com'),
        pageTitle: 'Example',
        type: 'region',
        geometry: { type: 'rect', x: 10, y: 20, width: 100, height: 50 },
        intent: 'fix',
        severity: 'blocking',
        description: 'Button is misaligned',
        viewportWidth: 1920,
        viewportHeight: 1080,
      })

      expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.type).toBe('region')
      expect(result.intent).toBe('fix')
      expect(result.schemaVersion).toBe(1)
      expect(result.createdAt).toBeGreaterThan(0)
      expect(result.updatedAt).toBe(result.createdAt)
    })

    it('groups annotations by normalizedUrl', () => {
      const store = useAnnotationStore.getState()
      const url1 = normalizeUrl('https://example.com/page1')
      const url2 = normalizeUrl('https://example.com/page2')

      store.addAnnotation(makeAnnotation(url1, 'tab-1'))
      store.addAnnotation(makeAnnotation(url1, 'tab-1'))
      store.addAnnotation(makeAnnotation(url2, 'tab-1'))

      expect(store.getAnnotationsForUrl('https://example.com/page1')).toHaveLength(2)
      expect(store.getAnnotationsForUrl('https://example.com/page2')).toHaveLength(1)
    })
  })

  describe('getAnnotationsForUrl', () => {
    it('returns annotations keyed by normalized url', () => {
      const store = useAnnotationStore.getState()
      const url = 'https://example.com?utm_source=track'
      store.addAnnotation(makeAnnotation(normalizeUrl(url), 'tab-1'))

      expect(store.getAnnotationsForUrl(url)).toHaveLength(1)
      expect(store.getAnnotationsForUrl('https://example.com')).toHaveLength(1)
    })

    it('returns empty array for unknown urls', () => {
      const store = useAnnotationStore.getState()
      expect(store.getAnnotationsForUrl('https://unknown.com')).toHaveLength(0)
    })
  })

  describe('updateAnnotation', () => {
    it('updates intent, severity and description', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeAnnotation(url, 'tab-1'))

      store.updateAnnotation(url, added.id, {
        intent: 'change',
        severity: 'important',
        description: 'Updated description',
      })

      const updated = store.getAnnotationsForUrl('https://example.com')[0]
      expect(updated.intent).toBe('change')
      expect(updated.severity).toBe('important')
      expect(updated.description).toBe('Updated description')
      expect(updated.updatedAt).toBeGreaterThanOrEqual(added.createdAt)
    })
  })

  describe('removeAnnotation', () => {
    it('removes annotation by id', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeAnnotation(url, 'tab-1'))

      store.removeAnnotation(url, added.id)
      expect(store.getAnnotationsForUrl('https://example.com')).toHaveLength(0)
    })

    it('cleans up empty url entries', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeAnnotation(url, 'tab-1'))

      store.removeAnnotation(url, added.id)
      expect(store.annotationsByUrl.has(url)).toBe(false)
    })
  })

  describe('clearAnnotationsForTab', () => {
    it('removes annotations only for specified tab', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      store.addAnnotation(makeAnnotation(url, 'tab-1'))
      store.addAnnotation(makeAnnotation(url, 'tab-2'))

      store.clearAnnotationsForTab('tab-1')

      expect(store.getAnnotationsForUrl('https://example.com')).toHaveLength(1)
      expect(store.getAnnotationsForUrl('https://example.com')[0].browserTabId).toBe('tab-2')
    })
  })
})

function makeAnnotation(normalizedUrl: string, browserTabId: string): Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'> {
  return {
    browserTabId,
    url: 'https://example.com',
    normalizedUrl,
    pageTitle: 'Example',
    type: 'region',
    geometry: { type: 'rect', x: 0, y: 0, width: 100, height: 100 },
    intent: 'question',
    severity: 'suggestion',
    description: 'Test annotation',
    viewportWidth: 1920,
    viewportHeight: 1080,
  }
}
