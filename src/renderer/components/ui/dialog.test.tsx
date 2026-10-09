import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './dialog'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next)
        setOpen(next)
      }}
    >
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Details</DialogTitle>
        <DialogDescription>Body</DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

function stackIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

describe('ui/dialog overlay back stack', () => {
  let cleanup: () => void

  beforeEach(() => {
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('registers while open, and system back removes the dialog and consumes the sentinel', async () => {
      const onOpenChange = vi.fn()
      render(<Harness onOpenChange={onOpenChange} />)

      fireEvent.click(screen.getByText('Open dialog'))
      expect(screen.getByRole('dialog', { name: 'Details' })).toBeInTheDocument()
      expect(stackIds()).toHaveLength(1)
      expect(stackIds()[0]).toMatch(/^dialog:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(onOpenChange).toHaveBeenLastCalledWith(false)
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by the X button consumes the sentinel so the next back is not dead', async () => {
      render(<Harness />)
      fireEvent.click(screen.getByText('Open dialog'))
      await waitForSentinelDepth(1)
      const backSpy = vi.spyOn(history, 'back')

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitForSentinelDepth(0)
      expect(backSpy).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(location.hash).toBe('#/base')
    })

    it('a close by Esc consumes the sentinel and closes exactly once', async () => {
      const onOpenChange = vi.fn()
      render(<Harness onOpenChange={onOpenChange} />)
      fireEvent.click(screen.getByText('Open dialog'))
      await waitForSentinelDepth(1)

      fireEvent.keyDown(document.body, { key: 'Escape' })

      await waitForSentinelDepth(0)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(onOpenChange.mock.calls.filter(([next]) => next === false)).toHaveLength(1)
    })
  })

  describe('desktop shell', () => {
    it('is inert: no registration, no history push and no traversal', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      render(<Harness />)

      fireEvent.click(screen.getByText('Open dialog'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(stackIds()).toEqual([])
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await settleOverlayBackStack()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })

  it('stays uncontrolled-compatible: a Dialog without `open` is never registered', () => {
    render(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>
    )

    fireEvent.click(screen.getByText('Open'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(stackIds()).toEqual([])
  })
})
