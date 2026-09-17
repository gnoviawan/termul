import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useBlockNote } from '@/hooks/use-blocknote'
import { MarkdownEditor } from './MarkdownEditor'

// Story 9 (QA repro): the Markdown editor missed the mobile TOC gate the code
// editor has — toggling TOC on a ~390px viewport squeezed BlockNote to ~225px.
// The gate must mirror CodeEditor.tsx:94-98: canRenderToc is false whenever
// the mobile web shell is active, so no TOC panel renders.

const { mobileRef, tocSettingsRef } = vi.hoisted(() => ({
  // Mutable so the mobile gate test can flip the shell on/off.
  mobileRef: { current: false as boolean },
  // Mutable so the TOC-visible path can be exercised (default isVisible=false
  // keeps the existing tests unchanged).
  tocSettingsRef: {
    current: {
      isLoaded: true,
      loadFailed: false,
      settings: { isVisible: true, width: 280 },
      setWidth: vi.fn()
    }
  }
}))

vi.mock('@blocknote/react', () => ({
  BlockNoteViewRaw: () => <div data-testid="blocknote-view" />
}))

vi.mock('@/components/ui/resizable', () => {
  // jsdom reports clientWidth 0, which react-resizable-panels' layout
  // validator rejects ("Invalid 0 panel layout"). Stub the local wrapper
  // so the desktop TOC path mounts without layout validation.
  const PanelGroup = ({
    children,
    ref
  }: {
    children: React.ReactNode
    ref?: React.Ref<{ getLayout: () => number[]; setLayout: (sizes: number[]) => void }>
  }) => (
    <div data-testid="panel-group" ref={ref as React.Ref<HTMLDivElement>}>
      {children}
    </div>
  )
  return {
    ResizablePanelGroup: PanelGroup,
    ResizablePanel: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="panel">{children}</div>
    ),
    ResizableHandle: () => <div data-testid="resize-handle" />
  }
})

vi.mock('@/hooks/use-blocknote', () => ({
  useBlockNote: vi.fn()
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

const CONTENT = `---
title: Spec
---
# Heading

Body text.
`

const mockUseBlockNote = vi.mocked(useBlockNote)

describe('MarkdownEditor mobile TOC gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = false
    tocSettingsRef.current = {
      isLoaded: true,
      loadFailed: false,
      settings: { isVisible: true, width: 280 },
      setWidth: vi.fn()
    }
    mockUseBlockNote.mockReturnValue({
      editor: {} as never,
      replaceContent: vi.fn(),
      flushPendingContent: vi.fn(),
      capturePendingContent: vi.fn(async () => null),
      getHeadings: () => [],
      scrollToBlock: vi.fn()
    })
  })

  it('hides the TOC panel on the mobile web shell even when TOC is visible (full-width editor)', () => {
    // TOC hydrat + visible: desktop would render the panel; the mobile gate
    // must force canRenderToc=false so BlockNote keeps the full width.
    mobileRef.current = true
    const { container } = render(
      <MarkdownEditor filePath="/docs/spec.md" content={CONTENT} isVisible onChange={vi.fn()} />
    )

    expect(container.querySelector('[data-toc-panel]')).toBeNull()
    expect(container.querySelector('[data-testid="blocknote-view"]')).not.toBeNull()
  })

  it('desktop keeps rendering the TOC panel when hydrated + visible (gate is mobile-only)', () => {
    // The react-resizable-panels zero-clientWidth validator rejects jsdom on
    // the multi-panel path, so the desktop assertion runs through the same
    // mock seam CodeEditor.test uses: TOC panel mounted => gate did not fire.
    mobileRef.current = false
    const { container } = render(
      <MarkdownEditor filePath="/docs/spec.md" content={CONTENT} isVisible onChange={vi.fn()} />
    )

    expect(container.querySelector('[data-toc-panel]')).not.toBeNull()
  })
})
