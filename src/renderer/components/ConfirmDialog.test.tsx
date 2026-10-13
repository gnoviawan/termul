import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { ConfirmDialog } from './ConfirmDialog'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('ConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Confirm Action',
    message: 'Are you sure?',
    onConfirm: vi.fn(),
    onCancel: vi.fn()
  }

  it('should render title and message when open', () => {
    render(<ConfirmDialog {...defaultProps} />)

    expect(screen.getByText('Confirm Action')).toBeInTheDocument()
    expect(screen.getByText('Are you sure?')).toBeInTheDocument()
  })

  it('should not render when closed', () => {
    render(<ConfirmDialog {...defaultProps} isOpen={false} />)

    expect(screen.queryByText('Confirm Action')).not.toBeInTheDocument()
  })

  it('should call onConfirm when confirm button is clicked', () => {
    const onConfirm = vi.fn()
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByText('Confirm'))

    expect(onConfirm).toHaveBeenCalled()
  })

  it('should call onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByText('Cancel'))

    expect(onCancel).toHaveBeenCalled()
  })

  it('should call onCancel on escape key', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalled()
  })

  it('should use custom button labels', () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Delete" cancelLabel="Keep" />)

    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(screen.getByText('Keep')).toBeInTheDocument()
  })

  it('should apply danger styling for danger variant', () => {
    render(<ConfirmDialog {...defaultProps} variant="danger" confirmLabel="Delete" />)

    const deleteButton = screen.getByText('Delete')
    expect(deleteButton).toHaveClass('bg-destructive-fill')
  })

  it('should call onCancel when clicking backdrop', () => {
    const onCancel = vi.fn()
    const { container } = render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />)

    const backdrop = container.querySelector('.fixed.inset-0')
    if (backdrop) {
      fireEvent.click(backdrop)
    }

    expect(onCancel).toHaveBeenCalled()
  })
})

describe('ConfirmDialog overlay back stack', () => {
  let cleanup: () => void

  function Harness({ onCancel }: { onCancel: () => void }): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return (
      <ConfirmDialog
        isOpen={open}
        title="Confirm Action"
        message="Are you sure?"
        onConfirm={() => setOpen(false)}
        onCancel={() => {
          onCancel()
          setOpen(false)
        }}
      />
    )
  }

  const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

  beforeEach(() => {
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('registers while open and system back cancels it and consumes the sentinel', async () => {
      const onCancel = vi.fn()
      render(<Harness onCancel={onCancel} />)

      expect(stackIds()[0]).toMatch(/^confirm-dialog:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      expect(onCancel).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByText('Confirm Action')).not.toBeInTheDocument(), {
        timeout: 3000
      })
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(stackIds()).toEqual([])
    })

    it('a close by Esc cancels exactly once and consumes the sentinel', async () => {
      const onCancel = vi.fn()
      render(<Harness onCancel={onCancel} />)
      await waitForSentinelDepth(1)

      fireEvent.keyDown(window, { key: 'Escape' })
      await waitForSentinelDepth(0)
      await settleOverlayBackStack()

      // ConfirmDialog owns Esc (preventDefault): the fallback must not double it.
      expect(onCancel).toHaveBeenCalledTimes(1)
    })

    it('a close by the scrim consumes the sentinel', async () => {
      const onCancel = vi.fn()
      const { container } = render(<Harness onCancel={onCancel} />)
      await waitForSentinelDepth(1)

      const scrim = container.querySelector('.fixed.inset-0')
      expect(scrim).not.toBeNull()
      if (scrim) fireEvent.click(scrim)

      await waitForSentinelDepth(0)
      expect(onCancel).toHaveBeenCalledTimes(1)
    })
  })

  describe('desktop shell', () => {
    it('is inert: no registration, no history push and no traversal', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const onCancel = vi.fn()
      render(<Harness onCancel={onCancel} />)

      expect(stackIds()).toEqual([])
      fireEvent.keyDown(window, { key: 'Escape' })
      await settleOverlayBackStack()

      expect(onCancel).toHaveBeenCalledTimes(1)
      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})

describe('ConfirmDialog focus (modal)', () => {
  const props = {
    title: 'Delete host',
    message: 'This cannot be undone.',
    confirmLabel: 'Delete',
    onConfirm: vi.fn(),
    onCancel: vi.fn()
  }

  function Harness({ variant }: { variant?: 'default' | 'danger' }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          opener
        </button>
        <ConfirmDialog
          {...props}
          variant={variant}
          isOpen={open}
          onConfirm={() => {
            props.onConfirm()
            setOpen(false)
          }}
          onCancel={() => {
            props.onCancel()
            setOpen(false)
          }}
        />
      </>
    )
  }

  // A Radix menu item raises the confirm; the item unmounts with its menu.
  function MenuHarness() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger asChild>
            <button type="button">more</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setOpen(true)}>Delete…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmDialog
          {...props}
          variant="danger"
          isOpen={open}
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    )
  }

  const rememberCheckbox = (
    <label>
      <input type="checkbox" />
      Don't ask again
    </label>
  )

  beforeEach(() => vi.clearAllMocks())

  it('is a labelled alertdialog', () => {
    render(<ConfirmDialog {...props} isOpen />)
    expect(screen.getByRole('alertdialog', { name: 'Delete host' })).toHaveAccessibleDescription(
      'This cannot be undone.'
    )
  })

  it('focuses Cancel for a danger confirm and the action otherwise', async () => {
    const { unmount } = render(<ConfirmDialog {...props} isOpen variant="danger" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
    unmount()
    render(<ConfirmDialog {...props} isOpen />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus())
  })

  it('keeps Tab inside and lets Enter on Cancel cancel', async () => {
    render(<Harness variant="danger" />)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    fireEvent.click(opener)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())
    const confirm = screen.getByRole('button', { name: 'Delete' })
    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()

    cancel.focus()
    // Not prevented, so the browser activates the focused Cancel (the click).
    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true)
    fireEvent.click(cancel)
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('wraps Tab over focusable children too', async () => {
    render(
      <ConfirmDialog {...props} isOpen variant="danger">
        {rememberCheckbox}
      </ConfirmDialog>
    )
    const checkbox = screen.getByRole('checkbox')
    const confirm = screen.getByRole('button', { name: 'Delete' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(checkbox).toHaveFocus()
    fireEvent.keyDown(checkbox, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
  })

  it('confirms on Enter only from the dialog itself, and not while loading', () => {
    const { rerender } = render(
      <ConfirmDialog {...props} isOpen>
        {rememberCheckbox}
      </ConfirmDialog>
    )
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'Enter' })
    expect(props.onConfirm).not.toHaveBeenCalled()

    const dialog = screen.getByRole('alertdialog')
    rerender(
      <ConfirmDialog {...props} isOpen isLoading>
        {rememberCheckbox}
      </ConfirmDialog>
    )
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(props.onConfirm).not.toHaveBeenCalled()

    rerender(
      <ConfirmDialog {...props} isOpen>
        {rememberCheckbox}
      </ConfirmDialog>
    )
    fireEvent.keyDown(dialog, { key: 'Enter' })
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps focus on the dialog when its initial button is disabled (loading)', async () => {
    render(<ConfirmDialog {...props} isOpen isLoading />)
    await waitFor(() => expect(screen.getByRole('alertdialog')).toHaveFocus())
  })

  it('returns focus to the opener when it closes', async () => {
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'opener' })
    opener.focus()
    fireEvent.click(opener)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('returns focus to the menu trigger when a menu item opened it', async () => {
    render(<MenuHarness />)
    // The open (modal) menu hides the rest of the page from the a11y tree.
    const trigger = screen.getByRole('button', { name: 'more', hidden: true })
    const item = await screen.findByRole('menuitem', { name: 'Delete…' })
    item.focus()
    fireEvent.click(item)
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()

    fireEvent.click(cancel)
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
