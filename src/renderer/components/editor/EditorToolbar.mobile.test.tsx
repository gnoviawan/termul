import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorToolbar } from './EditorToolbar'

// Story 9 (QA repro): EditorToolbar leaked the desktop h-6 (24px) tabs into
// the mobile pane. On the mobile web shell the controls must meet the 44px
// floor (the `touch` button size) and keep functioning; desktop density is
// unchanged.

const { mobileRef, mocks } = vi.hoisted(() => ({
  // Mutable so the desktop/mobile rows can flip the shell without re-mocking.
  mobileRef: { current: false as boolean },
  mocks: { toggleVisibility: vi.fn() }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

vi.mock('@/stores/toc-settings-store', () => ({
  useTocIsVisible: () => true,
  useTocSettingsStore: (selector: (state: { toggleVisibility: () => void }) => unknown) =>
    selector({ toggleVisibility: mocks.toggleVisibility })
}))

const renderToolbar = (viewMode: 'code' | 'markdown'): HTMLElement => {
  const { container } = render(
    <EditorToolbar viewMode={viewMode} onToggleViewMode={vi.fn()} filePath="/docs/spec.md" />
  )
  return container
}
const findTocButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'TOC' }) as HTMLButtonElement

describe('EditorToolbar mobile control sizing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = true
  })

  afterEach(() => {
    mobileRef.current = false
  })

  it('meets the 44px floor on mobile: TOC and view-mode controls use the touch size', () => {
    renderToolbar('markdown')

    const tocButton = findTocButton()
    const sourceButton = screen.getByRole('button', { name: 'Source' })
    expect(tocButton.className).toContain('h-11')
    expect(sourceButton.className).toContain('h-11')
    // Hit-slop overlay is part of the touch size idiom.
    expect(tocButton.className).toContain('after:-inset-1.5')
    // Desktop h-6 leak is gone on mobile.
    expect(tocButton.className).not.toMatch(/\bh-6\b/)
  })

  it('TOC and view-mode controls still function on mobile', () => {
    renderToolbar('markdown')

    fireEvent.click(findTocButton())
    expect(mocks.toggleVisibility).toHaveBeenCalledTimes(1)

    const sourceButton = screen.getByRole('button', { name: 'Source' })
    expect(sourceButton).toBeInTheDocument()
  })
})

describe('EditorToolbar desktop density (parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = false
  })

  it('keeps the compact desktop h-6 controls and toolbar spacing', () => {
    const container = renderToolbar('markdown')

    const tocButton = findTocButton()
    const sourceButton = screen.getByRole('button', { name: 'Source' })
    expect(tocButton.className).toMatch(/\bh-6\b/)
    expect(sourceButton.className).toMatch(/\bh-6\b/)
    expect(tocButton.className).not.toMatch(/\bh-11\b/)

    // Toolbar container keeps the desktop rhythm.
    const toolbarRow = container.firstElementChild as HTMLElement
    expect(toolbarRow.className).toContain('h-8')
    expect(toolbarRow.className).toContain('px-3')
  })
})
