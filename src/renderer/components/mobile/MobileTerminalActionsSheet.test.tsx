import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ComponentProps, useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useSheetCloseFocus } from '@/hooks/use-sheet-close-focus'
import { MobileTerminalActionsSheet } from './MobileTerminalActionsSheet'

type SheetProps = ComponentProps<typeof MobileTerminalActionsSheet>

function renderSheet(overrides: Partial<SheetProps> = {}) {
  const props: SheetProps = {
    open: true,
    onOpenChange: vi.fn(),
    terminalId: 'term-1',
    tabId: 'tab-1',
    name: 'zsh — dev server',
    lastExitCode: 0,
    onCloseAutoFocus: vi.fn(),
    onItemChosen: vi.fn(),
    onRenameTerminal: vi.fn(),
    onRestartTerminal: vi.fn(),
    onOpenCommandHistory: vi.fn(),
    onCloseTerminal: vi.fn(),
    ...overrides
  }
  const view = render(<MobileTerminalActionsSheet {...props} />)
  return { ...view, props }
}

function rowLabels(): string[] {
  const sheet = document.getElementById('mobile-terminal-actions-sheet')
  return Array.from(sheet?.querySelectorAll('button') ?? [])
    .map((button) => button.textContent?.trim() ?? '')
    .filter((text) => text.length > 0)
}

async function startRename(): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Rename terminal' }))
  return screen.getByRole('textbox', { name: 'Rename zsh — dev server' }) as HTMLInputElement
}

describe('MobileTerminalActionsSheet', () => {
  it('is a bottom sheet titled with the terminal name', async () => {
    renderSheet()

    const dialog = await screen.findByRole('dialog')
    expect(dialog.id).toBe('mobile-terminal-actions-sheet')
    expect(dialog).toHaveAccessibleName('zsh — dev server')
    const cls = dialog.className
    expect(cls).toContain('rounded-t-xl')
    expect(cls).toContain('max-h-[85dvh]')
    expect(cls).toContain('overflow-y-auto')
    expect(cls).toContain('overscroll-contain')
    expect(cls).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
  })

  it('lists rename, restart, history and a destructive close, each at 44px', async () => {
    renderSheet()
    await screen.findByRole('dialog')

    expect(rowLabels()).toEqual([
      'Rename terminal',
      'Restart terminal',
      'Command history',
      'Close terminal',
      'Close'
    ])
    for (const name of ['Rename terminal', 'Restart terminal', 'Command history']) {
      const row = screen.getByRole('button', { name })
      expect(row.className, name).toContain('min-h-11')
      expect(row.className, name).not.toContain('text-destructive')
    }
    const close = screen.getByRole('button', { name: 'Close terminal' })
    expect(close.className).toContain('min-h-11')
    expect(close.className).toContain('text-destructive')
  })

  describe('last exit code', () => {
    it.each([
      [0, 'Last exit code 0'],
      [127, 'Last exit code 127']
    ])('shows "Last exit code N" for %s', async (code, text) => {
      renderSheet({ lastExitCode: code })

      const dialog = await screen.findByRole('dialog')
      const description = screen.getByText(text)
      expect(description.className).toContain('tabular-nums')
      expect(description.className).toContain('text-muted-foreground')
      expect(dialog).toHaveAccessibleDescription(text)
    })

    it.each([null, undefined])('omits the description for %s', async (code) => {
      renderSheet({ lastExitCode: code })

      const dialog = await screen.findByRole('dialog')
      expect(screen.queryByText(/Last exit code/)).not.toBeInTheDocument()
      // No dangling aria-describedby when there is nothing to describe.
      expect(dialog).not.toHaveAttribute('aria-describedby')
    })
  })

  describe('row actions', () => {
    it('Restart terminal calls onRestartTerminal(terminalId), marks the choice and closes', async () => {
      const calls: string[] = []
      const { props } = renderSheet({
        onItemChosen: vi.fn(() => calls.push('chosen')),
        onOpenChange: vi.fn((open: boolean) => calls.push(`open:${open}`)),
        onRestartTerminal: vi.fn(() => calls.push('run'))
      })

      fireEvent.click(await screen.findByRole('button', { name: 'Restart terminal' }))

      expect(props.onRestartTerminal).toHaveBeenCalledTimes(1)
      expect(props.onRestartTerminal).toHaveBeenCalledWith('term-1')
      expect(calls).toEqual(['chosen', 'open:false', 'run'])
    })

    it('Command history calls onOpenCommandHistory() and closes', async () => {
      const { props } = renderSheet()

      fireEvent.click(await screen.findByRole('button', { name: 'Command history' }))

      expect(props.onOpenCommandHistory).toHaveBeenCalledTimes(1)
      expect(props.onOpenCommandHistory).toHaveBeenCalledWith()
      expect(props.onItemChosen).toHaveBeenCalledTimes(1)
      expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    it('Close terminal calls onCloseTerminal(terminalId, tabId) and closes', async () => {
      const { props } = renderSheet()

      fireEvent.click(await screen.findByRole('button', { name: 'Close terminal' }))

      expect(props.onCloseTerminal).toHaveBeenCalledTimes(1)
      expect(props.onCloseTerminal).toHaveBeenCalledWith('term-1', 'tab-1')
      expect(props.onItemChosen).toHaveBeenCalledTimes(1)
      expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    it('renders each row only when its callback exists', async () => {
      renderSheet({
        onRenameTerminal: undefined,
        onRestartTerminal: undefined,
        onOpenCommandHistory: undefined
      })
      await screen.findByRole('dialog')

      expect(rowLabels()).toEqual(['Close terminal', 'Close'])
    })

    it('omits Close terminal when it cannot be closed', async () => {
      renderSheet({ onCloseTerminal: undefined })
      await screen.findByRole('dialog')

      expect(screen.queryByRole('button', { name: 'Close terminal' })).not.toBeInTheDocument()
    })
  })

  describe('rename', () => {
    it('swaps the row for a labelled, focused, text-base input prefilled with the name', async () => {
      renderSheet()

      const input = await startRename()

      expect(screen.queryByRole('button', { name: 'Rename terminal' })).not.toBeInTheDocument()
      expect(input.value).toBe('zsh — dev server')
      expect(input).toHaveFocus()
      expect(input.className).toContain('min-h-11')
      expect(input.className).toContain('text-base')
      expect(input.className).toContain('md:text-base')
    })

    it('Enter commits the trimmed name and closes without marking an item chosen', async () => {
      const { props } = renderSheet()
      const input = await startRename()

      fireEvent.change(input, { target: { value: '  api  ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(props.onRenameTerminal).toHaveBeenCalledTimes(1)
      expect(props.onRenameTerminal).toHaveBeenCalledWith('term-1', 'api')
      expect(props.onOpenChange).toHaveBeenCalledWith(false)
      // A rename commit is not a "chosen" row: focus returns to ⋯.
      expect(props.onItemChosen).not.toHaveBeenCalled()
    })

    it('ignores the Enter that confirms an IME composition, then commits on a real Enter', async () => {
      const { props } = renderSheet()
      const input = await startRename()

      fireEvent.change(input, { target: { value: 'ap' } })
      fireEvent.keyDown(input, { key: 'Enter', isComposing: true })

      expect(props.onRenameTerminal).not.toHaveBeenCalled()
      expect(props.onOpenChange).not.toHaveBeenCalled()
      // The edit is still live.
      expect(screen.getByRole('textbox', { name: 'Rename zsh — dev server' })).toBe(input)

      fireEvent.keyDown(input, { key: 'Enter' })

      expect(props.onRenameTerminal).toHaveBeenCalledWith('term-1', 'ap')
      expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    it('does not commit twice when a blur follows Enter', async () => {
      const { props } = renderSheet()
      const input = await startRename()

      fireEvent.change(input, { target: { value: 'api' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      fireEvent.blur(input)

      expect(props.onRenameTerminal).toHaveBeenCalledTimes(1)
    })

    it('a blank name makes no call and keeps the sheet open', async () => {
      const { props } = renderSheet()
      const input = await startRename()

      fireEvent.change(input, { target: { value: '   ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(props.onRenameTerminal).not.toHaveBeenCalled()
      expect(props.onOpenChange).not.toHaveBeenCalled()
      // The edit ends and the action row returns.
      expect(screen.getByRole('button', { name: 'Rename terminal' })).toBeInTheDocument()
    })

    it('Escape makes no call, and the blur that follows does not commit', async () => {
      const { props } = renderSheet()
      const input = await startRename()

      fireEvent.change(input, { target: { value: 'api' } })
      fireEvent.keyDown(input, { key: 'Escape' })
      fireEvent.blur(input)

      expect(props.onRenameTerminal).not.toHaveBeenCalled()
    })

    it('blur commits the name and the sheet stays open', async () => {
      const { props } = renderSheet()
      const input = await startRename()

      fireEvent.change(input, { target: { value: ' build ' } })
      fireEvent.blur(input)

      expect(props.onRenameTerminal).toHaveBeenCalledWith('term-1', 'build')
      expect(props.onOpenChange).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Rename terminal' })).toBeInTheDocument()
    })

    it('starts a fresh edit from the current name after a cancel', async () => {
      renderSheet()
      const first = await startRename()
      fireEvent.change(first, { target: { value: 'discarded' } })
      fireEvent.keyDown(first, { key: 'Escape' })

      const second = await startRename()

      expect(second.value).toBe('zsh — dev server')
    })
  })

  describe('focus return', () => {
    function Harness({ onRename }: { onRename: () => void }): React.JSX.Element {
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
          <MobileTerminalActionsSheet
            open={open}
            onOpenChange={setOpen}
            terminalId="term-1"
            tabId="tab-1"
            name="zsh"
            lastExitCode={0}
            onCloseAutoFocus={onCloseAutoFocus}
            onItemChosen={markItemChosen}
            onRenameTerminal={onRename}
            onRestartTerminal={vi.fn()}
          />
        </>
      )
    }

    async function expectOpenerFocused(): Promise<void> {
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'opener' }))
      )
    }

    it('returns focus to ⋯ when dismissed with Escape', async () => {
      render(<Harness onRename={vi.fn()} />)
      await screen.findByRole('dialog')

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await expectOpenerFocused()
    })

    it('returns focus to ⋯ when dismissed with the close button', async () => {
      render(<Harness onRename={vi.fn()} />)
      await screen.findByRole('dialog')

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await expectOpenerFocused()
    })

    it('returns focus to ⋯ after a rename commit', async () => {
      const onRename = vi.fn()
      render(<Harness onRename={onRename} />)
      fireEvent.click(await screen.findByRole('button', { name: 'Rename terminal' }))
      const input = screen.getByRole('textbox', { name: 'Rename zsh' })

      fireEvent.change(input, { target: { value: 'api' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(onRename).toHaveBeenCalledWith('term-1', 'api')
      await expectOpenerFocused()
    })

    it('focuses the title, not ⋯, after a restart', async () => {
      render(<Harness onRename={vi.fn()} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Restart terminal' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'title' }))
      )
    })
  })
})
