import { beforeEach, describe, expect, it } from 'vitest'
import { type Annotation, normalizeUrl, useAnnotationStore } from './annotation-store'

describe('annotation-store', () => {
  beforeEach(() => {
    // Reset store state before each test
    useAnnotationStore.setState({
      annotationsByUrl: new Map(),
      selectedAnnotationIdByUrl: new Map()
    })
  })

  describe('normalizeUrl', () => {
    it('strips tracking params', () => {
      expect(normalizeUrl('https://example.com/?utm_source=newsletter&page=1')).toBe(
        'https://example.com/?page=1'
      )
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
        viewportHeight: 1080
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

      store.addAnnotation(makeRegionAnnotation(url1, 'tab-1'))
      store.addAnnotation(makeRegionAnnotation(url1, 'tab-1'))
      store.addAnnotation(makeRegionAnnotation(url2, 'tab-1'))

      expect(store.getAnnotationsForUrl('https://example.com/page1')).toHaveLength(2)
      expect(store.getAnnotationsForUrl('https://example.com/page2')).toHaveLength(1)
    })

    it('sanitizes and stores element annotations in geometry union', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com/page')

      const added = store.addAnnotation({
        browserTabId: 'tab-1',
        url: 'https://example.com/page',
        normalizedUrl: url,
        pageTitle: 'Example Page',
        type: 'element',
        geometry: {
          type: 'element',
          tagName: 'button',
          selector: '#submit-button',
          selectorConfidence: 'unique-id',
          attributes: {
            id: 'submit-button',
            class: 'btn btn-primary'
          },
          textContent: 'Submit',
          textTruncated: false,
          boundingBox: { x: 12, y: 24, width: 140, height: 40 }
        },
        intent: 'question',
        severity: 'suggestion',
        description: 'Captured button',
        viewportWidth: 1280,
        viewportHeight: 720
      })

      expect(added.type).toBe('element')
      expect(added.geometry.type).toBe('element')
      if (added.geometry.type === 'element') {
        expect(added.geometry.tagName).toBe('button')
        expect(added.geometry.selector).toBe('#submit-button')
        expect(added.geometry.selectorConfidence).toBe('unique-id')
        expect(added.geometry.attributes).toEqual({
          id: 'submit-button',
          class: 'btn btn-primary'
        })
        expect(added.geometry.textContent).toBe('Submit')
        expect(added.geometry.boundingBox.width).toBe(140)
      }
    })
  })

  describe('getAnnotationsForUrl', () => {
    it('returns annotations keyed by normalized url', () => {
      const store = useAnnotationStore.getState()
      const url = 'https://example.com?utm_source=track'
      store.addAnnotation(makeRegionAnnotation(normalizeUrl(url), 'tab-1'))

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
      const added = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))

      store.updateAnnotation(url, added.id, {
        intent: 'change',
        severity: 'important',
        description: 'Updated description'
      })

      const updated = store.getAnnotationsForUrl('https://example.com')[0]
      expect(updated.intent).toBe('change')
      expect(updated.severity).toBe('important')
      expect(updated.description).toBe('Updated description')
      expect(updated.updatedAt).toBeGreaterThanOrEqual(added.createdAt)
    })

    it('roundtrips element geometry without type loss', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com/element')
      const added = store.addAnnotation(makeElementAnnotation(url, 'tab-1'))

      store.updateAnnotation(url, added.id, {
        description: 'Updated element annotation'
      })

      const updated = store.getAnnotationsForUrl('https://example.com/element')[0]
      expect(updated.type).toBe('element')
      expect(updated.geometry.type).toBe('element')
      if (updated.geometry.type === 'element') {
        expect(updated.geometry.selector).toBe('#submit-button')
      }
    })
  })

  describe('removeAnnotation', () => {
    it('removes annotation by id', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))

      store.removeAnnotation(url, added.id)
      expect(store.getAnnotationsForUrl('https://example.com')).toHaveLength(0)
    })

    it('removes element annotations by id', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com/element')
      const added = store.addAnnotation(makeElementAnnotation(url, 'tab-1'))

      store.removeAnnotation(url, added.id)
      expect(store.getAnnotationsForUrl('https://example.com/element')).toHaveLength(0)
    })

    it('cleans up empty url entries', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))

      store.removeAnnotation(url, added.id)
      expect(store.annotationsByUrl.has(url)).toBe(false)
    })
  })

  describe('clearAnnotationsForTab', () => {
    it('removes annotations only for specified tab', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))
      store.addAnnotation(makeRegionAnnotation(url, 'tab-2'))

      store.clearAnnotationsForTab('tab-1')

      expect(store.getAnnotationsForUrl('https://example.com')).toHaveLength(1)
      expect(store.getAnnotationsForUrl('https://example.com')[0].browserTabId).toBe('tab-2')
    })

    it('clears selection for urls that become empty', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))
      store.setSelectedAnnotationId(url, added.id)

      store.clearAnnotationsForTab('tab-1')

      expect(store.selectedAnnotationIdByUrl.has(url)).toBe(false)
    })
  })

  describe('selectedAnnotationIdByUrl', () => {
    it('sets and gets selected annotation id per url', () => {
      const url1 = normalizeUrl('https://example.com/page1')
      const url2 = normalizeUrl('https://example.com/page2')

      useAnnotationStore.getState().setSelectedAnnotationId(url1, 'anno-1')
      useAnnotationStore.getState().setSelectedAnnotationId(url2, 'anno-2')

      expect(useAnnotationStore.getState().selectedAnnotationIdByUrl.get(url1)).toBe('anno-1')
      expect(useAnnotationStore.getState().selectedAnnotationIdByUrl.get(url2)).toBe('anno-2')
    })

    it('clears selected id on removal if it matches', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))
      store.setSelectedAnnotationId(url, added.id)

      store.removeAnnotation(url, added.id)

      expect(useAnnotationStore.getState().selectedAnnotationIdByUrl.get(url)).toBeNull()
    })

    it('does not clear selected id on removal of a different annotation', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added1 = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))
      const added2 = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))
      store.setSelectedAnnotationId(url, added1.id)

      store.removeAnnotation(url, added2.id)

      expect(useAnnotationStore.getState().selectedAnnotationIdByUrl.get(url)).toBe(added1.id)
    })

    it('isolates selections across urls', () => {
      const store = useAnnotationStore.getState()
      const url1 = normalizeUrl('https://example.com/page1')
      const url2 = normalizeUrl('https://example.com/page2')

      store.setSelectedAnnotationId(url1, 'anno-1')
      expect(useAnnotationStore.getState().selectedAnnotationIdByUrl.get(url2)).toBeUndefined()
    })

    it('clears selection via clearSelectedAnnotationId', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      store.setSelectedAnnotationId(url, 'anno-1')

      store.clearSelectedAnnotationId(url)

      expect(useAnnotationStore.getState().selectedAnnotationIdByUrl.get(url)).toBeNull()
    })

    it('persists selection across unrelated updates', () => {
      const store = useAnnotationStore.getState()
      const url = normalizeUrl('https://example.com')
      const added = store.addAnnotation(makeRegionAnnotation(url, 'tab-1'))
      store.setSelectedAnnotationId(url, added.id)

      store.updateAnnotation(url, added.id, { description: 'Updated' })

      expect(useAnnotationStore.getState().selectedAnnotationIdByUrl.get(url)).toBe(added.id)
    })
  })
})

function makeRegionAnnotation(
  normalizedUrl: string,
  browserTabId: string
): Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'> {
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
    viewportHeight: 1080
  }
}

function makeElementAnnotation(
  normalizedUrl: string,
  browserTabId: string
): Omit<Annotation, 'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'> {
  return {
    browserTabId,
    url: 'https://example.com/element',
    normalizedUrl,
    pageTitle: 'Example Element',
    type: 'element',
    geometry: {
      type: 'element',
      tagName: 'button',
      selector: '#submit-button',
      selectorConfidence: 'unique-id',
      attributes: {
        id: 'submit-button',
        class: 'btn btn-primary'
      },
      textContent: 'Submit now',
      textTruncated: false,
      boundingBox: {
        x: 10,
        y: 20,
        width: 100,
        height: 40
      }
    },
    intent: 'question',
    severity: 'suggestion',
    description: 'Element annotation',
    viewportWidth: 1440,
    viewportHeight: 900
  }
}
