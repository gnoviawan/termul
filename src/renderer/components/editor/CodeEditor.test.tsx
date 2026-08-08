import type { EditorView } from '@codemirror/view'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCodeMirror } from '@/hooks/use-codemirror'
import { CodeEditor } from './CodeEditor'

const mockFocus = vi.fn()
const mockSetContent = vi.fn()
const mockScrollToLine = vi.fn()
const mockRestoreViewState = vi.fn()

const { mobileRef, tocSettingsRef } = vi.hoisted(() => ({
  // Mutable so the mobile TOC-hide test can flip the shell on/off.
  mobileRef: { current: false as boolean },
  // Mutable so the TOC-visible path can be exercised (default isVisible=false
  // keeps the existing tests unchanged).
  tocSettingsRef: {
    current: {
      isLoaded: true,
      loadFailed: false,
      settings: { isVisible: false, width: 280 },
      setWidth: vi.fn()
    }
  }
}))

vi.mock('@/hooks/use-codemirror', () => ({
  useCodeMirror: vi.fn()
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

vi.mock('./TocPanel', () => ({
  TocPanel: () => <div data-toc-panel="toc" />
}))

vi.mock('@/stores/toc-settings-store', () => ({
  useTocSettingsStore: (selector: (state: unknown) => unknown) => selector(tocSettingsRef.current)
}))

const defaultProps = {
  filePath: '/project/src/example.ts',
  content: 'line 1\nline 2\nline 3',
  language: 'typescript',
  isVisible: true,
  onChange: vi.fn(),
  onCursorChange: vi.fn(),
  onScrollChange: vi.fn()
} as const

// Partial EditorView stub sufficient for CodeEditor's usage (only calls .focus()).
const fakeView = { focus: mockFocus } as unknown as EditorView

describe('CodeEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (global as { __termulPendingRevealLine?: unknown }).__termulPendingRevealLine
    mobileRef.current = false
    tocSettingsRef.current.settings.isVisible = false

    vi.mocked(useCodeMirror).mockReturnValue({
      view: fakeView,
      isReady: true,
      setContent: mockSetContent,
      flushPendingContent: vi.fn(),
      scrollToLine: mockScrollToLine,
      restoreViewState: mockRestoreViewState,
      getVisibleLineRange: vi.fn(() => null)
    })
  })

  it('restores initial cursor/scroll state once without re-triggering on later cursor updates', () => {
    const { rerender } = render(
      <CodeEditor
        {...defaultProps}
        initialCursorPosition={{ line: 10, col: 3 }}
        initialScrollTop={240}
      />
    )

    expect(mockRestoreViewState).toHaveBeenCalledTimes(1)
    expect(mockRestoreViewState).toHaveBeenCalledWith(10, 3, 240)
    expect(mockScrollToLine).not.toHaveBeenCalled()

    rerender(
      <CodeEditor
        {...defaultProps}
        initialCursorPosition={{ line: 11, col: 1 }}
        initialScrollTop={240}
      />
    )

    expect(mockRestoreViewState).toHaveBeenCalledTimes(1)
    expect(mockScrollToLine).not.toHaveBeenCalled()
  })

  it('still reveals lines for explicit reveal events', () => {
    render(
      <CodeEditor
        {...defaultProps}
        initialCursorPosition={{ line: 2, col: 1 }}
        initialScrollTop={0}
      />
    )

    window.dispatchEvent(
      new CustomEvent('termul:reveal-line', {
        detail: {
          filePath: '/project/src/example.ts',
          lineNumber: 7,
          searchTerm: 'needle'
        }
      })
    )

    expect(mockScrollToLine).toHaveBeenCalledWith(7, 'needle')
    expect(mockScrollToLine).toHaveBeenCalledTimes(1)
    expect(
      (global as { __termulPendingRevealLine?: unknown }).__termulPendingRevealLine
    ).toBeUndefined()
  })

  it('shows the loading overlay while the editor view is not ready', () => {
    vi.mocked(useCodeMirror).mockReturnValue({
      view: null,
      isReady: false,
      setContent: mockSetContent,
      flushPendingContent: vi.fn(),
      scrollToLine: mockScrollToLine,
      restoreViewState: mockRestoreViewState,
      getVisibleLineRange: vi.fn(() => null)
    })

    const { container, getByText } = render(<CodeEditor {...defaultProps} />)

    expect(getByText('Loading...')).toBeInTheDocument()
    const overlay = container.querySelector('[role="status"]')
    expect(overlay).not.toBeNull()
    expect(overlay?.getAttribute('aria-live')).toBe('polite')
  })
})

describe('CodeEditor mobile TOC hide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = false
    tocSettingsRef.current = {
      isLoaded: true,
      loadFailed: false,
      settings: { isVisible: true, width: 280 },
      setWidth: vi.fn()
    }
    vi.mocked(useCodeMirror).mockReturnValue({
      view: fakeView,
      isReady: true,
      setContent: mockSetContent,
      flushPendingContent: vi.fn(),
      scrollToLine: mockScrollToLine,
      restoreViewState: mockRestoreViewState,
      getVisibleLineRange: vi.fn(() => null)
    })
  })

  it('hides the TOC panel on mobile web shell so the editor gets full width', () => {
    // Desktop renders the TOC side-by-side, but that path exercises
    // `react-resizable-panels` whose 0-panel layout validator rejects jsdom's
    // zero clientWidth. The mobile branch is the CAP-5 fix under test: it
    // forces `canRenderToc=false` so the TOC panel never mounts.
    mobileRef.current = true
    const { container } = render(<CodeEditor {...defaultProps} language="markdown" />)

    expect(container.querySelector('[data-toc-panel]')).toBeNull()
  })
})
