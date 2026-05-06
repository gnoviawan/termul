import { describe, expect, it } from 'vitest'
import { exportAnnotationsToJson, exportAnnotationsToMarkdown } from './annotation-export'
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
})
