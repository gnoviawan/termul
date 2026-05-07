import { describe, expect, it } from 'vitest'
import { exportAnnotationsToJson, exportAnnotationsToMarkdown, exportAnnotationsToAfsJson } from './annotation-export'
import type { Annotation } from '@/stores/annotation-store'

const baseAnnotation: Annotation = {
  id: 'annotation-1',
  browserTabId: 'tab-1',
  url: 'https://example.com/page',
  normalizedUrl: 'https://example.com/page',
  pageTitle: 'Example *Page*',
  type: 'element',
  geometry: {
    type: 'element',
    tagName: 'button',
    selector: 'button.btn-primary[data-testid="submit-button"]',
    selectorConfidence: 'unique-class',
    attributes: {
      class: 'btn-primary',
      'data-testid': 'submit-button',
    },
    textContent: 'Submit **now** > later',
    textTruncated: false,
    boundingBox: {
      x: 10,
      y: 20,
      width: 120,
      height: 36,
    },
  },
  intent: 'question',
  severity: 'suggestion',
  description: 'Review this _button_',
  viewportWidth: 1440,
  viewportHeight: 900,
  schemaVersion: 1,
  createdAt: 1715000000000,
  updatedAt: 1715000000000,
}

describe('annotation-export', () => {
  it('exports element annotations in compact markdown', () => {
    const markdown = exportAnnotationsToMarkdown([baseAnnotation], 'compact')

    expect(markdown).toContain('# Example \\*Page\\*')
    expect(markdown).toContain('1. button > button\\.btn\\-primary\\[data\\-testid="submit\\-button"\\] (unique-class)')
    expect(markdown).toContain('> Review this \\_button\\_')
  })

  it('exports element annotations in standard markdown with text preview', () => {
    const markdown = exportAnnotationsToMarkdown([baseAnnotation], 'standard')

    expect(markdown).toContain('Element: button > button\\.btn\\-primary\\[data\\-testid="submit\\-button"\\] (unique-class)')
    expect(markdown).toContain('Text: Submit \\*\\*now\\*\\* \\> later')
  })

  it('exports element annotations in detailed markdown with attributes table and bounding box', () => {
    const markdown = exportAnnotationsToMarkdown([baseAnnotation], 'detailed')

    expect(markdown).toContain('- **Tag:** button')
    expect(markdown).toContain('- **Selector Confidence:** unique-class')
    expect(markdown).toContain('- **Bounding Box:** x=10, y=20, w=120, h=36')
    expect(markdown).toContain('| Attribute | Value |')
    expect(markdown).toContain('| class | btn\\-primary |')
    expect(markdown).toContain('| data\\-testid | submit\\-button |')
  })

  it('truncates long element selector and text previews in markdown', () => {
    const annotation: Annotation = {
      ...baseAnnotation,
      geometry: {
        type: 'element',
        tagName: 'button',
        selector: `button.${'x'.repeat(80)}`,
        selectorConfidence: 'unique-class',
        attributes: {
          class: 'btn-primary',
          'data-testid': 'submit-button',
        },
        textContent: 'a'.repeat(120),
        textTruncated: false,
        boundingBox: {
          x: 10,
          y: 20,
          width: 120,
          height: 36,
        },
      },
    }

    const markdown = exportAnnotationsToMarkdown([annotation], 'standard')

    expect(markdown).toContain(`${'x'.repeat(52)}…`)
    expect(markdown).toContain(`${'a'.repeat(79)}…`)
  })

  it('exports full element geometry in json', () => {
    const json = exportAnnotationsToJson([baseAnnotation])
    const parsed = JSON.parse(json)

    expect(parsed.annotations).toHaveLength(1)
    expect(parsed.annotations[0].type).toBe('element')
    expect(parsed.annotations[0].geometry).toEqual(baseAnnotation.geometry)
    expect(parsed.annotations[0].geometry.boundingBox.width).toBe(120)
  })

  // ─── AFS export tests ──────────────────────────────────────────────

  describe('exportAnnotationsToAfsJson', () => {
    it('maps element annotation to AFS with all mapped fields', () => {
      const json = exportAnnotationsToAfsJson([baseAnnotation])
      const parsed = JSON.parse(json)

      expect(parsed.annotations).toHaveLength(1)
      const afs = parsed.annotations[0]

      expect(afs.id).toBe('annotation-1')
      expect(afs.comment).toBe('Review this _button_')
      expect(afs.elementPath).toBe('button.btn-primary[data-testid="submit-button"]')
      expect(afs.timestamp).toBe(1715000000000)
      expect(afs.url).toBe('https://example.com/page')
      expect(afs.intent).toBe('question')
      expect(afs.severity).toBe('suggestion')
      expect(afs.element).toBe('button')
      expect(afs.boundingBox).toEqual({ x: 10, y: 20, width: 120, height: 36 })
      // Coordinate conversion: x = (10 / 1440) * 100 ≈ 0.694...
      expect(afs.x).toBeCloseTo(0.694, 2)
      expect(afs.y).toBe(20)
    })

    it('maps region annotation with rect fallback for elementPath', () => {
      const regionAnnotation: Annotation = {
        ...baseAnnotation,
        type: 'region',
        geometry: {
          type: 'rect',
          x: 50,
          y: 100,
          width: 300,
          height: 200,
        },
      }

      const json = exportAnnotationsToAfsJson([regionAnnotation])
      const parsed = JSON.parse(json)
      const afs = parsed.annotations[0]

      expect(afs.elementPath).toBe('rect(50, 100, 300, 200)')
      expect(afs.element).toBe('div')
      expect(afs.boundingBox).toEqual({ x: 50, y: 100, width: 300, height: 200 })
      expect(afs.x).toBeCloseTo((50 / 1440) * 100, 2)
      expect(afs.y).toBe(100)
    })

    it('omits elementPath and boundingBox for note annotations', () => {
      const noteAnnotation: Annotation = {
        ...baseAnnotation,
        type: 'note',
        geometry: {
          type: 'point',
          x: 200,
          y: 400,
        },
      }

      const json = exportAnnotationsToAfsJson([noteAnnotation])
      const parsed = JSON.parse(json)
      const afs = parsed.annotations[0]

      expect(afs.element).toBe('body')
      expect(afs.x).toBe(0)
      expect(afs.y).toBe(0)
      expect(afs).not.toHaveProperty('elementPath')
      expect(afs).not.toHaveProperty('boundingBox')
    })

    it('produces correct per-type mappings for mixed annotations', () => {
      const regionAnnotation: Annotation = {
        ...baseAnnotation,
        id: 'region-1',
        type: 'region',
        geometry: {
          type: 'rect',
          x: 100,
          y: 200,
          width: 400,
          height: 300,
        },
      }

      const noteAnnotation: Annotation = {
        ...baseAnnotation,
        id: 'note-1',
        type: 'note',
        geometry: {
          type: 'point',
          x: 300,
          y: 500,
        },
      }

      const json = exportAnnotationsToAfsJson([
        baseAnnotation,
        regionAnnotation,
        noteAnnotation,
      ])
      const parsed = JSON.parse(json)

      expect(parsed.annotations).toHaveLength(3)

      // Element
      const el = parsed.annotations[0]
      expect(el.id).toBe('annotation-1')
      expect(el.element).toBe('button')
      expect(el).toHaveProperty('elementPath')
      expect(el).toHaveProperty('boundingBox')

      // Region
      const region = parsed.annotations[1]
      expect(region.id).toBe('region-1')
      expect(region.element).toBe('div')
      expect(region.elementPath).toBe('rect(100, 200, 400, 300)')

      // Note
      const note = parsed.annotations[2]
      expect(note.id).toBe('note-1')
      expect(note.element).toBe('body')
      expect(note).not.toHaveProperty('elementPath')
      expect(note).not.toHaveProperty('boundingBox')
    })

    it('excludes all AFS-unsupported fields from output', () => {
      const json = exportAnnotationsToAfsJson([baseAnnotation])
      const parsed = JSON.parse(json)
      const afs = parsed.annotations[0]

      const unsupported = [
        'status', 'thread', 'resolvedBy', 'resolvedAt',
        'reactComponents', 'cssClasses', 'computedStyles',
        'accessibility', 'nearbyText', 'selectedText',
        'isFixed', 'isMultiSelect', 'fullPath', 'nearbyElements',
        'kind', 'placement', 'rearrange',
      ]

      for (const field of unsupported) {
        expect(afs).not.toHaveProperty(field)
      }
    })

    it('uses empty string for empty description', () => {
      const noDescription: Annotation = {
        ...baseAnnotation,
        description: '',
      }

      const json = exportAnnotationsToAfsJson([noDescription])
      const parsed = JSON.parse(json)

      expect(parsed.annotations[0].comment).toBe('')
    })

    it('wraps output in annotations array', () => {
      const json = exportAnnotationsToAfsJson([])
      const parsed = JSON.parse(json)

      expect(parsed).toHaveProperty('annotations')
      expect(parsed.annotations).toEqual([])
    })
  })
})
