import { describe, it, expect, beforeEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { AnnotationPanel } from './AnnotationPanel'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAnnotationStore, normalizeUrl, type Annotation } from '@/stores/annotation-store'

// Mock scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn()

// Wrapper component that provides TooltipProvider context
function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>
}

function renderWithProvider(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

// Helper to create a region annotation in the store
function addRegionAnnotation(url: string, tabId: string, description = 'Test region') {
  const normalizedUrl = normalizeUrl(url)
  return useAnnotationStore.getState().addAnnotation({
    browserTabId: tabId,
    url,
    normalizedUrl,
    pageTitle: 'Example',
    type: 'region',
    geometry: { type: 'rect', x: 10, y: 20, width: 100, height: 50 },
    intent: 'fix',
    severity: 'blocking',
    description,
    viewportWidth: 1920,
    viewportHeight: 1080,
  })
}

// Helper to create an element annotation in the store
function addElementAnnotation(url: string, tabId: string, description = 'Test element') {
  const normalizedUrl = normalizeUrl(url)
  return useAnnotationStore.getState().addAnnotation({
    browserTabId: tabId,
    url,
    normalizedUrl,
    pageTitle: 'Example',
    type: 'element',
    geometry: {
      type: 'element',
      tagName: 'button',
      selector: '#submit-btn',
      selectorConfidence: 'unique-id',
      attributes: { id: 'submit-btn', class: 'btn-primary' },
      textContent: 'Submit',
      textTruncated: false,
      boundingBox: { x: 50, y: 60, width: 120, height: 40 },
    },
    intent: 'change',
    severity: 'important',
    description,
    viewportWidth: 1920,
    viewportHeight: 1080,
  })
}

const DEFAULT_PROPS = {
  url: 'https://example.com',
  annotationSubMode: 'draw' as const,
  annotationOverlayAvailable: true,
  onExitAnnotationMode: () => {},
  onChangeAnnotationSubMode: () => {},
  onAddNote: () => {},
  onExport: () => {},
}

describe('AnnotationPanel', () => {
  beforeEach(() => {
    useAnnotationStore.setState({
      annotationsByUrl: new Map(),
      selectedAnnotationIdByUrl: new Map(),
    })
  })

  describe('empty state', () => {
    it('renders empty state when no annotations exist', () => {
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(screen.getByText('No annotations on this page.')).toBeInTheDocument()
    })

    it('shows session-scoped notice', () => {
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(
        screen.getByText(/Session-scoped/i)
      ).toBeInTheDocument()
    })
  })

  describe('tool group rendering', () => {
    it('renders Draw button with aria-pressed when draw mode is active', () => {
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} annotationSubMode="draw" />)
      const drawBtn = screen.getByLabelText('Draw rectangle annotations')
      expect(drawBtn).toBeInTheDocument()
      expect(drawBtn.getAttribute('aria-pressed')).toBe('true')
    })

    it('renders Select button with aria-pressed when select mode is active', () => {
      renderWithProvider(
        <AnnotationPanel
          {...DEFAULT_PROPS}
          annotationSubMode="select"
          annotationOverlayAvailable={true}
        />
      )
      const selectBtn = screen.getByLabelText('Select elements')
      expect(selectBtn).toBeInTheDocument()
      expect(selectBtn.getAttribute('aria-pressed')).toBe('true')
    })

    it('Draw button has aria-pressed false when select mode is active', () => {
      renderWithProvider(
        <AnnotationPanel
          {...DEFAULT_PROPS}
          annotationSubMode="select"
          annotationOverlayAvailable={true}
        />
      )
      const drawBtn = screen.getByLabelText('Draw rectangle annotations')
      expect(drawBtn.getAttribute('aria-pressed')).toBe('false')
    })

    it('Select button is disabled when overlay is unavailable', () => {
      renderWithProvider(
        <AnnotationPanel
          {...DEFAULT_PROPS}
          annotationSubMode="draw"
          annotationOverlayAvailable={false}
        />
      )
      const selectBtn = screen.getByLabelText('Select unavailable on this page')
      expect(selectBtn).toBeDisabled()
    })

    it('shows correct aria-label when Select is disabled', () => {
      renderWithProvider(
        <AnnotationPanel
          {...DEFAULT_PROPS}
          annotationSubMode="draw"
          annotationOverlayAvailable={false}
        />
      )
      expect(
        screen.getByLabelText('Select unavailable on this page')
      ).toBeInTheDocument()
    })

    it('calls onChangeAnnotationSubMode when Draw button is clicked', () => {
      const onChange = vi.fn()
      renderWithProvider(
        <AnnotationPanel
          {...DEFAULT_PROPS}
          annotationSubMode="select"
          onChangeAnnotationSubMode={onChange}
        />
      )
      fireEvent.click(screen.getByLabelText('Draw rectangle annotations'))
      expect(onChange).toHaveBeenCalledWith('draw')
    })

    it('calls onChangeAnnotationSubMode when Select button is clicked', () => {
      const onChange = vi.fn()
      renderWithProvider(
        <AnnotationPanel
          {...DEFAULT_PROPS}
          annotationSubMode="draw"
          onChangeAnnotationSubMode={onChange}
        />
      )
      fireEvent.click(screen.getByLabelText('Select elements'))
      expect(onChange).toHaveBeenCalledWith('select')
    })

    it('renders Note and Export buttons', () => {
      addRegionAnnotation(DEFAULT_PROPS.url, 'tab-1')
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(screen.getByLabelText('Add page note')).toBeInTheDocument()
      expect(screen.getByLabelText('Export annotations')).toBeInTheDocument()
    })

    it('Export button is disabled when no annotations', () => {
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(screen.getByLabelText('No annotations to export')).toBeDisabled()
    })
  })

  describe('card list', () => {
    it('renders region annotation card with rect geometry display', () => {
      addRegionAnnotation(DEFAULT_PROPS.url, 'tab-1', 'Fix alignment')
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(screen.getByText('Fix alignment')).toBeInTheDocument()
      expect(screen.getByText(/rect/i)).toBeInTheDocument()
    })

    it('renders element annotation card with tag badge', () => {
      addElementAnnotation(DEFAULT_PROPS.url, 'tab-1')
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(screen.getByText(/<button>/i)).toBeInTheDocument()
    })

    it('renders intent badge for each card', () => {
      addRegionAnnotation(DEFAULT_PROPS.url, 'tab-1', 'Fix alignment')
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      // Use getAllByText since tooltip may duplicate the text
      const intentElements = screen.getAllByText('fix')
      // At least one should be the badge (not the tooltip portal content)
      expect(intentElements.length).toBeGreaterThanOrEqual(1)
      // Filter to ensure we find the badge element specifically
      const badgeElement = intentElements.find(
        el => el.classList.contains('bg-red-100')
      )
      expect(badgeElement).toBeTruthy()
    })

    it('renders severity label for each card', () => {
      addRegionAnnotation(DEFAULT_PROPS.url, 'tab-1', 'Fix alignment')
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      const severityElements = screen.getAllByText('blocking')
      expect(severityElements.length).toBeGreaterThanOrEqual(1)
      // The severity label is a <span> with capitalize class
      const labelElement = severityElements.find(
        el => el.tagName === 'SPAN' && el.classList.contains('capitalize')
      )
      expect(labelElement).toBeTruthy()
    })

    it('shows element selector confidence badge', () => {
      addElementAnnotation(DEFAULT_PROPS.url, 'tab-1')
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(screen.getByText('unique-id')).toBeInTheDocument()
    })
  })

  describe('selected state', () => {
    it('applies ring styling to selected card', () => {
      const annotation = addRegionAnnotation(
        DEFAULT_PROPS.url,
        'tab-1',
        'Selected card'
      )
      useAnnotationStore
        .getState()
        .setSelectedAnnotationId(
          normalizeUrl(DEFAULT_PROPS.url),
          annotation.id
        )

      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)

      // The selected card should have ring-2 ring-primary class
      const card = screen.getByText('Selected card').closest('[class*="ring-2"]')
      expect(card).toBeTruthy()
    })

    it('sets selected id on card click', () => {
      const annotation = addRegionAnnotation(
        DEFAULT_PROPS.url,
        'tab-1',
        'Click me'
      )
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)

      const card = screen.getByText('Click me').closest('div[class*="cursor-pointer"]')
      expect(card).toBeTruthy()
      fireEvent.click(card!)

      const selectedId = useAnnotationStore
        .getState()
        .selectedAnnotationIdByUrl.get(normalizeUrl(DEFAULT_PROPS.url))
      expect(selectedId).toBe(annotation.id)
    })

    it('does not apply ring to unselected cards', () => {
      const ann1 = addRegionAnnotation(DEFAULT_PROPS.url, 'tab-1', 'Card A')
      const ann2 = addRegionAnnotation(DEFAULT_PROPS.url, 'tab-1', 'Card B')
      useAnnotationStore
        .getState()
        .setSelectedAnnotationId(normalizeUrl(DEFAULT_PROPS.url), ann1.id)

      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)

      // Card A should be selected (ring present)
      const cardA = screen.getByText('Card A').closest('[class*="ring-2"]')
      expect(cardA).toBeTruthy()

      // Card B should NOT have ring
      const cardB = screen.getByText('Card B').closest('[class*="ring-2"]')
      expect(cardB).toBeFalsy()
    })
  })

  describe('exit button', () => {
    it('renders exit annotation mode button', () => {
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)
      expect(
        screen.getByLabelText('Exit annotation mode')
      ).toBeInTheDocument()
    })

    it('calls onExitAnnotationMode when exit button is clicked', () => {
      const onExit = vi.fn()
      renderWithProvider(
        <AnnotationPanel {...DEFAULT_PROPS} onExitAnnotationMode={onExit} />
      )
      fireEvent.click(screen.getByLabelText('Exit annotation mode'))
      expect(onExit).toHaveBeenCalledOnce()
    })
  })

  describe('delete annotation', () => {
    it('calls removeAnnotation when delete button is clicked', () => {
      addRegionAnnotation(DEFAULT_PROPS.url, 'tab-1', 'Delete me')
      renderWithProvider(<AnnotationPanel {...DEFAULT_PROPS} />)

      // The delete button uses title="Delete annotation" since Radix TooltipTrigger
      // may interfere with aria-label query
      const deleteBtn = screen.getByTitle('Delete annotation')
      fireEvent.click(deleteBtn)

      const annotations = useAnnotationStore
        .getState()
        .getAnnotationsForUrl(DEFAULT_PROPS.url)
      expect(annotations).toHaveLength(0)
    })
  })
})
