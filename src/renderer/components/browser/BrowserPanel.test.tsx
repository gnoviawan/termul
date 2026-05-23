import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrowserPanel } from './BrowserPanel'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

vi.mock('@/hooks/use-browser-webview', () => ({
  useBrowserWebview: () => ({ containerRef: { current: null } })
}))

vi.mock('@/hooks/use-annotation-capture', () => ({
  useAnnotationCapture: vi.fn()
}))

vi.mock('@/hooks/use-annotation-markers', () => ({
  useAnnotationMarkers: vi.fn()
}))

vi.mock('@/stores/annotation-store', () => ({
  useAnnotationStore: (selector: (state: { getAnnotationsForUrl: () => []; }) => unknown) =>
    selector({ getAnnotationsForUrl: () => [] }),
  normalizeUrl: (url: string) => url,
  EMPTY_ANNOTATION_ARRAY: []
}))

vi.mock('./AnnotationPanel', () => ({
  AnnotationPanel: () => <div data-testid="annotation-panel" />
}))

vi.mock('./AnnotationExportModal', () => ({
  AnnotationExportModal: () => null
}))

vi.mock('@/lib/browser-api', () => ({
  browserTabInjectAnnotation: vi.fn(),
  browserTabRemoveAnnotationOverlay: vi.fn(),
  browserTabHide: vi.fn(),
  browserTabShow: vi.fn(),
  onBrowserTabTitleChanged: () => ({ unlisten: () => {} }),
  onBrowserTabLoaded: () => ({ unlisten: () => {} })
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false
}))

function renderPanel(): void {
  render(
    <TooltipProvider>
      <BrowserPanel browserTabId="browser-1" isVisible />
    </TooltipProvider>
  )
}

describe('BrowserPanel web mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useBrowserSessionStore.setState({ tabs: new Map() })
    useBrowserSessionStore.getState().createTab('browser-1', 'https://example.com')
    window.open = vi.fn()
  })

  it('renders iframe-based browser UI in web mode', () => {
    renderPanel()

    expect(screen.getByTitle('Open in new tab')).toBeInTheDocument()
    expect(screen.getByTitle('Embedded browser content')).toBeInTheDocument()
    expect(screen.queryByText('Browser tabs require the desktop app')).not.toBeInTheDocument()
  })

  it('opens the current URL in a new tab', () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }))

    expect(window.open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
  })

  it('shows fallback message when iframe load stalls', () => {
    renderPanel()

    act(() => {
      vi.advanceTimersByTime(4500)
    })

    expect(screen.getByText('This site may be blocking iframe access')).toBeInTheDocument()
    expect(screen.getByText(/X-Frame-Options/)).toBeInTheDocument()
    expect(screen.getByText(/Content-Security-Policy/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry embed' })).toBeInTheDocument()
  })
})
