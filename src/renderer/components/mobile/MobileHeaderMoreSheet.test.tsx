import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ComponentProps, useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useSheetCloseFocus } from '@/hooks/use-sheet-close-focus'
import { MobileHeaderMoreSheet } from './MobileHeaderMoreSheet'

type SheetProps = ComponentProps<typeof MobileHeaderMoreSheet>

function allCallbacks() {
  return {
    onOpenGitChanges: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onNewTerminal: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onCloseChat: vi.fn()
  }
}

function renderSheet(overrides: Partial<SheetProps> = {}) {
  const props: SheetProps = {
    open: true,
    onOpenChange: vi.fn(),
    title: 'Fix auth redirect loop',
    subtitle: 'termul · chat/ab12 · Worktree',
    onCloseAutoFocus: vi.fn(),
    onItemChosen: vi.fn(),
    ...allCallbacks(),
    ...overrides
  }
  render(<MobileHeaderMoreSheet {...props} />)
  return props
}

function rowLabels(): string[] {
  const sheet = document.getElementById('mobile-header-more-sheet')
  return Array.from(sheet?.querySelectorAll('button') ?? [])
    .map((button) => button.textContent?.trim() ?? '')
    .filter((text) => text.length > 0)
}

describe('MobileHeaderMoreSheet', () => {
  it('is a bottom sheet titled with the header title and described by the subtitle', async () => {
    renderSheet()

    const dialog = await screen.findByRole('dialog')
    expect(dialog.id).toBe('mobile-header-more-sheet')
    expect(dialog).toHaveAccessibleName('Fix auth redirect loop')
    expect(dialog).toHaveAccessibleDescription('termul · chat/ab12 · Worktree')
    const cls = dialog.className
    expect(cls).toContain('rounded-t-xl')
    expect(cls).toContain('max-h-[85dvh]')
    expect(cls).toContain('overflow-y-auto')
    expect(cls).toContain('overscroll-contain')
    expect(cls).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
    const description = screen.getByText('termul · chat/ab12 · Worktree')
    expect(description.className).toContain('text-xs')
    expect(description.className).toContain('text-muted-foreground')
  })

  it('lists the actions in order with Close chat last', async () => {
    renderSheet()
    await screen.findByRole('dialog')

    expect(rowLabels()).toEqual([
      'Git changes',
      'Files',
      'Command palette',
      'New terminal',
      'Project settings',
      'Close chat',
      'Close'
    ])
  })

  it('sets Close chat apart as a destructive row and keeps every row at 44px', async () => {
    renderSheet()
    await screen.findByRole('dialog')

    const closeChat = screen.getByRole('button', { name: 'Close chat' })
    expect(closeChat.className).toContain('text-destructive')
    expect(closeChat.parentElement?.className).toContain('border-t')
    expect(closeChat.parentElement?.className).toContain('border-border/60')
    expect(closeChat.parentElement?.className).toContain('mt-1')
    expect(closeChat.parentElement?.className).toContain('pt-1')
    for (const name of [
      'Git changes',
      'Files',
      'Command palette',
      'New terminal',
      'Project settings',
      'Close chat'
    ]) {
      expect(screen.getByRole('button', { name }).className, name).toContain('min-h-11')
    }
    expect(screen.getByRole('button', { name: 'Git changes' }).className).not.toContain(
      'text-destructive'
    )
  })

  it.each([
    ['Git changes', 'onOpenGitChanges'],
    ['Files', 'onOpenFiles'],
    ['Command palette', 'onOpenCommandPalette'],
    ['New terminal', 'onNewTerminal'],
    ['Project settings', 'onOpenProjectSettings'],
    ['Close chat', 'onCloseChat']
  ] as const)('choosing "%s" runs only its callback once, marks the choice and closes', async (label, key) => {
    const calls: string[] = []
    const props = renderSheet({
      onItemChosen: vi.fn(() => calls.push('chosen')),
      onOpenChange: vi.fn((open: boolean) => calls.push(`open:${open}`))
    })
    const callback = props[key] as ReturnType<typeof vi.fn>
    callback.mockImplementation(() => calls.push('run'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: label }))

    expect(callback).toHaveBeenCalledTimes(1)
    for (const other of Object.keys(allCallbacks())) {
      if (other !== key) expect(props[other as keyof SheetProps], other).not.toHaveBeenCalled()
    }
    expect(calls).toEqual(['chosen', 'open:false', 'run'])
  })

  it('omits every row whose callback is missing', async () => {
    renderSheet({
      onOpenGitChanges: undefined,
      onOpenCommandPalette: undefined,
      onOpenProjectSettings: undefined,
      onCloseChat: undefined
    })
    await screen.findByRole('dialog')

    expect(rowLabels()).toEqual(['Files', 'New terminal', 'Close'])
  })

  it('omits Close chat for a non-chat tab but keeps the rest', async () => {
    renderSheet({ onCloseChat: undefined })
    await screen.findByRole('dialog')

    expect(screen.queryByRole('button', { name: 'Close chat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Project settings' })).toBeInTheDocument()
  })

  it('shows only Close chat, without a separator, when nothing else applies', async () => {
    renderSheet({
      onOpenGitChanges: undefined,
      onOpenFiles: undefined,
      onOpenCommandPalette: undefined,
      onNewTerminal: undefined,
      onOpenProjectSettings: undefined
    })
    await screen.findByRole('dialog')

    expect(rowLabels()).toEqual(['Close chat', 'Close'])
    expect(
      screen.getByRole('button', { name: 'Close chat' }).parentElement?.className
    ).not.toContain('border-t')
  })

  it('dismisses through the built-in close button', async () => {
    const props = renderSheet()
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  describe('focus return', () => {
    function Harness({ onFiles }: { onFiles?: () => void }): React.JSX.Element {
      const [open, setOpen] = useState(true)
      const openerRef = useRef<HTMLButtonElement>(null)
      const titleRef = useRef<HTMLHeadingElement>(null)
      const { markItemChosen, onCloseAutoFocus } = useSheetCloseFocus(openerRef, titleRef)
      return (
        <>
          <h1 ref={titleRef} tabIndex={-1}>
            title
          </h1>
          <button type="button" ref={openerRef}>
            opener
          </button>
          <MobileHeaderMoreSheet
            open={open}
            onOpenChange={setOpen}
            title="Chat"
            subtitle="termul"
            onCloseAutoFocus={onCloseAutoFocus}
            onItemChosen={markItemChosen}
            onOpenFiles={onFiles}
          />
        </>
      )
    }

    it('returns focus to the opener when dismissed with Escape', async () => {
      render(<Harness onFiles={vi.fn()} />)
      await screen.findByRole('dialog')

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'opener' }))
      )
    })

    it('returns focus to the opener when dismissed with the close button', async () => {
      render(<Harness onFiles={vi.fn()} />)
      await screen.findByRole('dialog')

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'opener' }))
      )
    })

    it('focuses the title, not the opener, after a row was chosen', async () => {
      render(<Harness onFiles={vi.fn()} />)
      await screen.findByRole('dialog')

      fireEvent.click(screen.getByRole('button', { name: 'Files' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'title' }))
      )
      expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'opener' }))
    })
  })
})
