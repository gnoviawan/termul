import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isInertExemptOverlay } from '@/hooks/use-inert-behind-overlays'
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
      // The Git tab renders this dialog inside the shell body, so its id must
      // stay exempt from the body's `inert`.
      expect(isInertExemptOverlay(stackIds()[0])).toBe(true)
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
