import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from '@/stores/editor-store'
import { EditorToolbar } from './EditorToolbar'

// Story 9 (QA repro): EditorToolbar leaked the desktop h-6 (24px) controls
// into the mobile pane. On the mobile web shell the controls must meet the
// 44px floor (the `touch` idiom) and keep functioning; desktop keeps the
// compact h-10 toolbar with a Preview | Source track and an outline toggle.

const { mobileRef, mocks } = vi.hoisted(() => ({
  // Mutable so the desktop/mobile rows can flip the shell without re-mocking.
  mobileRef: { current: false as boolean },
  mocks: { toggleVisibility: vi.fn(), isTocVisible: true }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

vi.mock('@/stores/toc-settings-store', () => ({
  useTocIsVisible: () => mocks.isTocVisible,
  useTocSettingsStore: (selector: (state: { toggleVisibility: () => void }) => unknown) =>
    selector({ toggleVisibility: mocks.toggleVisibility })
}))

const FILE_PATH = '/docs/spec.md'

const renderToolbar = (
  viewMode: 'code' | 'markdown',
  onToggleViewMode = vi.fn()
): { container: HTMLElement; onToggleViewMode: ReturnType<typeof vi.fn> } => {
  const { container } = render(
    <EditorToolbar viewMode={viewMode} onToggleViewMode={onToggleViewMode} filePath={FILE_PATH} />
  )
  return { container, onToggleViewMode }
}
const findOutlineButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Outline' }) as HTMLButtonElement

describe('EditorToolbar mobile control sizing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTocVisible = true
    mobileRef.current = true
  })

  afterEach(() => {
    mobileRef.current = false
  })

  it('meets the 44px floor on mobile: outline and view-mode controls use the touch size', () => {
    renderToolbar('markdown')

    const outlineButton = findOutlineButton()
    const sourceButton = screen.getByRole('radio', { name: 'Source' })
    expect(outlineButton.className).toContain('min-h-11')
    expect(sourceButton.className).toContain('min-h-11')
    // Hit-slop overlay is part of the touch size idiom.
    expect(outlineButton.className).toContain('after:-inset-1.5')
    // Desktop h-6 / size-7 leak is gone on mobile.
    expect(sourceButton.className).not.toMatch(/\bh-6\b/)
    expect(outlineButton.className).not.toMatch(/\bsize-7\b/)
  })

  it('outline and view-mode controls still function on mobile', () => {
    const { onToggleViewMode } = renderToolbar('markdown')

    fireEvent.click(findOutlineButton())
    expect(mocks.toggleVisibility).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('radio', { name: 'Source' }))
    expect(onToggleViewMode).toHaveBeenCalledTimes(1)
  })
})

describe('EditorToolbar desktop chrome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTocVisible = true
    mobileRef.current = false
    useEditorStore.setState({ openFiles: new Map() })
  })

  it('keeps the compact h-10 toolbar on the document surface', () => {
    const { container } = renderToolbar('markdown')

    const toolbarRow = container.firstElementChild as HTMLElement
    expect(toolbarRow).toHaveClass('h-10', 'pl-4', 'pr-1.5', 'bg-background', 'border-b')
    expect(toolbarRow).not.toHaveClass('bg-card')

    const sourceButton = screen.getByRole('radio', { name: 'Source' })
    expect(sourceButton).toHaveClass('h-6')
    expect(sourceButton.className).not.toMatch(/\bmin-h-11\b/)
    expect(findOutlineButton()).toHaveClass('size-7')
  })

  it('shows a breadcrumb of the parent folder and the file name', () => {
    renderToolbar('markdown')

    expect(screen.getByText('docs')).toBeInTheDocument()
    expect(screen.getByText('spec.md')).toHaveClass('font-medium', 'text-muted-foreground')
  })

  it('raises the current mode in the Preview | Source track', () => {
    const { onToggleViewMode } = renderToolbar('markdown')

    const preview = screen.getByRole('radio', { name: 'Preview' })
    const source = screen.getByRole('radio', { name: 'Source' })
    expect(preview).toHaveAttribute('aria-checked', 'true')
    expect(preview).toHaveClass('keycap', 'text-foreground')
    expect(source).toHaveAttribute('aria-checked', 'false')
    expect(source).not.toHaveClass('keycap')

    // Clicking the current mode is a no-op; the other mode toggles.
    fireEvent.click(preview)
    expect(onToggleViewMode).not.toHaveBeenCalled()
    fireEvent.click(source)
    expect(onToggleViewMode).toHaveBeenCalledTimes(1)
  })

  it('marks the outline toggle pressed without an accent fill', () => {
    renderToolbar('markdown')

    const outlineButton = findOutlineButton()
    expect(outlineButton).toHaveAttribute('aria-pressed', 'true')
    expect(outlineButton).toHaveClass('bg-foreground/[0.06]', 'text-foreground')
    expect(outlineButton.className).not.toMatch(/bg-accent|bg-secondary/)
  })

  it('shows the word count and read time for markdown files', () => {
    const words = Array.from({ length: 450 }, () => 'word').join(' ')
    useEditorStore.setState({
      openFiles: new Map([
        [FILE_PATH, { content: `# Title\n\n${words}`, language: 'markdown' } as never]
      ])
    })
    renderToolbar('markdown')

    expect(screen.getByText('451 words · 3 min read')).toHaveClass('tabular-nums')
  })
})
