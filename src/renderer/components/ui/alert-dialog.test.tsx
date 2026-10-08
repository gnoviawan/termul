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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger
} from './alert-dialog'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next)
        setOpen(next)
      }}
    >
      <AlertDialogTrigger>Ask</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Delete file</AlertDialogTitle>
        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction>Delete</AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function stackIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

describe('ui/alert-dialog overlay back stack', () => {
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
    it('system back removes the confirm, leaves the hash alone and consumes the sentinel', async () => {
      const onOpenChange = vi.fn()
      render(<Harness onOpenChange={onOpenChange} />)

      fireEvent.click(screen.getByText('Ask'))
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      expect(stackIds()[0]).toMatch(/^alert-dialog:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(onOpenChange).toHaveBeenLastCalledWith(false)
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by the Cancel button consumes the sentinel', async () => {
      render(<Harness />)
      fireEvent.click(screen.getByText('Ask'))
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitForSentinelDepth(0)
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    it('a close by Esc consumes the sentinel and closes exactly once', async () => {
      const onOpenChange = vi.fn()
      render(<Harness onOpenChange={onOpenChange} />)
      fireEvent.click(screen.getByText('Ask'))
      await waitForSentinelDepth(1)

      fireEvent.keyDown(document.body, { key: 'Escape' })

      await waitForSentinelDepth(0)
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

      fireEvent.click(screen.getByText('Ask'))
      expect(screen.getByRole('alertdialog')).toBeInTheDocument()
      expect(stackIds()).toEqual([])
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      await settleOverlayBackStack()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})
