import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { AnnotationExportModal } from './AnnotationExportModal'
import type { Annotation } from '@/stores/annotation-store'

// Mock the clipboard API
const mockWriteText = vi.fn().mockResolvedValue({ success: true })

vi.mock('@/lib/clipboard-api', () => ({
  clipboardApi: {
    writeText: (...args: unknown[]) => mockWriteText(...args),
  },
}))

const baseAnnotation: Annotation = {
  id: 'annotation-1',
  browserTabId: 'tab-1',
  url: 'https://example.com/page',
  normalizedUrl: 'https://example.com/page',
  pageTitle: 'Example Page',
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
    textContent: 'Submit now',
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
  description: 'Review this button',
  viewportWidth: 1440,
  viewportHeight: 900,
  schemaVersion: 1,
  createdAt: 1715000000000,
  updatedAt: 1715000000000,
}

/** Select the AFS tab in the export modal. Radix TabsTrigger listens to mouseDown. */
function selectAfsTab(): void {
  act(() => {
    fireEvent.mouseDown(screen.getByRole('tab', { name: /AFS/ }))
  })
}

/** Select the JSON tab in the export modal. */
function selectJsonTab(): void {
  act(() => {
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^JSON$/ }))
  })
}

/** Select the Markdown tab in the export modal. */
function selectMarkdownTab(): void {
  act(() => {
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Markdown' }))
  })
}

describe('AnnotationExportModal', () => {
  const onOpenChange = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders AFS tab alongside Markdown and JSON', () => {
    render(
      <AnnotationExportModal
        open={true}
        onOpenChange={onOpenChange}
        annotations={[baseAnnotation]}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Markdown' })).toBeDefined()
    expect(screen.getByRole('tab', { name: 'JSON' })).toBeDefined()
    expect(screen.getByRole('tab', { name: /AFS/ })).toBeDefined()
  })

  it('shows AFS JSON preview when AFS tab is selected', () => {
    render(
      <AnnotationExportModal
        open={true}
        onOpenChange={onOpenChange}
        annotations={[baseAnnotation]}
      />,
    )

    selectAfsTab()

    // The AFS tab panel should show valid JSON with annotations wrapper
    const afsPanel = screen.getByRole('tabpanel', { name: /AFS/ })
    expect(afsPanel).toBeDefined()

    const textContent = afsPanel.textContent ?? ''
    const parsed = JSON.parse(textContent)
    expect(parsed.annotations).toBeDefined()
    expect(parsed.annotations).toHaveLength(1)
    expect(parsed.annotations[0].id).toBe('annotation-1')
    expect(parsed.annotations[0].element).toBe('button')
  })

  it('copies AFS JSON to clipboard when copy clicked on AFS tab', () => {
    render(
      <AnnotationExportModal
        open={true}
        onOpenChange={onOpenChange}
        annotations={[baseAnnotation]}
      />,
    )

    selectAfsTab()
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    })

    expect(mockWriteText).toHaveBeenCalledOnce()

    // Verify the copied text is valid AFS JSON
    const copiedText = mockWriteText.mock.calls[0][0] as string
    const parsed = JSON.parse(copiedText)
    expect(parsed.annotations).toHaveLength(1)
    expect(parsed.annotations[0].id).toBe('annotation-1')
  })

  it('switching between formats preserves correct output', () => {
    render(
      <AnnotationExportModal
        open={true}
        onOpenChange={onOpenChange}
        annotations={[baseAnnotation]}
      />,
    )

    // Start on Markdown
    let markdownPanel = screen.getByRole('tabpanel', { name: 'Markdown' })
    expect(markdownPanel.textContent).toContain('Example Page')

    // Switch to AFS
    selectAfsTab()
    let afsPanel = screen.getByRole('tabpanel', { name: /AFS/ })
    const afsContent = afsPanel.textContent ?? ''
    const parsedAfs = JSON.parse(afsContent)
    expect(parsedAfs.annotations[0].element).toBe('button')
    expect(parsedAfs.annotations[0].comment).toBe('Review this button')

    // Switch to JSON (native)
    selectJsonTab()
    const jsonPanel = screen.getByRole('tabpanel', { name: /^JSON$/ })
    const jsonContent = jsonPanel.textContent ?? ''
    const parsedJson = JSON.parse(jsonContent)
    expect(parsedJson.annotations[0].type).toBe('element')
    expect(parsedJson.annotations[0].geometry).toBeDefined()

    // Switch back to Markdown — should still work
    selectMarkdownTab()
    markdownPanel = screen.getByRole('tabpanel', { name: 'Markdown' })
    expect(markdownPanel.textContent).toContain('Example Page')

    // Switch back to AFS — should still work
    selectAfsTab()
    afsPanel = screen.getByRole('tabpanel', { name: /AFS/ })
    const afsContent2 = afsPanel.textContent ?? ''
    const parsedAfs2 = JSON.parse(afsContent2)
    expect(parsedAfs2.annotations[0].element).toBe('button')
  })

  it('wraps empty annotations list in valid AFS envelope', () => {
    render(
      <AnnotationExportModal
        open={true}
        onOpenChange={onOpenChange}
        annotations={[]}
      />,
    )

    selectAfsTab()

    const afsPanel = screen.getByRole('tabpanel', { name: /AFS/ })
    const parsed = JSON.parse(afsPanel.textContent ?? '')
    expect(parsed.annotations).toEqual([])
  })
})
