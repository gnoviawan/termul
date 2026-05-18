import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { CodeEditor } from './CodeEditor'

const mockFocus = vi.fn()
const mockSetContent = vi.fn()
const mockScrollToLine = vi.fn()
const mockRestoreViewState = vi.fn()

vi.mock('@/hooks/use-codemirror', () => ({
  useCodeMirror: () => ({
    view: {
      focus: mockFocus
    },
    setContent: mockSetContent,
    scrollToLine: mockScrollToLine,
    restoreViewState: mockRestoreViewState,
    getVisibleLineRange: vi.fn(() => null)
  })
}))

vi.mock('@/stores/toc-settings-store', () => ({
  useTocSettingsStore: (selector: (state: unknown) => unknown) => selector({
    isLoaded: true,
    loadFailed: false,
    settings: {
      isVisible: false,
      width: 280
    },
    setWidth: vi.fn()
  })
}))

describe('CodeEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete (global as { __termulPendingRevealLine?: unknown }).__termulPendingRevealLine
  })

  it('restores initial cursor/scroll state once without re-triggering on later cursor updates', () => {
    const { rerender } = render(
      <CodeEditor
        filePath="/project/src/example.ts"
        content={'line 1\nline 2\nline 3'}
        language="typescript"
        isVisible
        initialCursorPosition={{ line: 10, col: 3 }}
        initialScrollTop={240}
        onChange={vi.fn()}
        onCursorChange={vi.fn()}
        onScrollChange={vi.fn()}
      />
    )

    expect(mockRestoreViewState).toHaveBeenCalledTimes(1)
    expect(mockRestoreViewState).toHaveBeenCalledWith(10, 3, 240)
    expect(mockScrollToLine).not.toHaveBeenCalled()

    rerender(
      <CodeEditor
        filePath="/project/src/example.ts"
        content={'line 1\nline 2\nline 3'}
        language="typescript"
        isVisible
        initialCursorPosition={{ line: 11, col: 1 }}
        initialScrollTop={240}
        onChange={vi.fn()}
        onCursorChange={vi.fn()}
        onScrollChange={vi.fn()}
      />
    )

    expect(mockRestoreViewState).toHaveBeenCalledTimes(1)
    expect(mockScrollToLine).not.toHaveBeenCalled()
  })

  it('still reveals lines for explicit reveal events', () => {
    render(
      <CodeEditor
        filePath="/project/src/example.ts"
        content={'line 1\nline 2\nline 3'}
        language="typescript"
        isVisible
        initialCursorPosition={{ line: 2, col: 1 }}
        initialScrollTop={0}
        onChange={vi.fn()}
        onCursorChange={vi.fn()}
        onScrollChange={vi.fn()}
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
    expect((global as { __termulPendingRevealLine?: unknown }).__termulPendingRevealLine).toBeUndefined()
  })
})
