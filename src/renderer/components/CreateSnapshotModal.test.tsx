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
import { CreateSnapshotModal } from './CreateSnapshotModal'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function Harness({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <CreateSnapshotModal
      isOpen={open}
      onClose={() => {
        onClose()
        setOpen(false)
      }}
      onCreateSnapshot={vi.fn()}
    />
  )
}

const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

describe('CreateSnapshotModal', () => {
  let cleanup: () => void

  beforeEach(() => {
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the form when open and nothing when closed', async () => {
    const { rerender } = render(
      <CreateSnapshotModal isOpen onClose={vi.fn()} onCreateSnapshot={vi.fn()} />
    )
    expect(screen.getByText('Create Snapshot')).toBeInTheDocument()

    rerender(<CreateSnapshotModal isOpen={false} onClose={vi.fn()} onCreateSnapshot={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Create Snapshot')).not.toBeInTheDocument())
  })

  describe('mobile shell overlay back stack', () => {
    it('registers while open and system back closes it and consumes the sentinel', async () => {
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)

      expect(stackIds()[0]).toMatch(/^create-snapshot-modal:/)
      // The Snapshots page renders this modal inside the shell body, so its id
      // must stay exempt from the body's `inert`.
      expect(isInertExemptOverlay(stackIds()[0])).toBe(true)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      expect(onClose).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByText('Create Snapshot')).not.toBeInTheDocument(), {
        timeout: 3000
      })
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by Esc closes exactly once and consumes the sentinel', async () => {
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)
      await waitForSentinelDepth(1)

      fireEvent.keyDown(window, { key: 'Escape' })
      await waitForSentinelDepth(0)
      await settleOverlayBackStack()

      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('a close by the Cancel button consumes the sentinel', async () => {
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitForSentinelDepth(0)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('desktop shell', () => {
    it('is inert: no registration, no history push and no traversal', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)

      expect(stackIds()).toEqual([])
      fireEvent.keyDown(window, { key: 'Escape' })
      await settleOverlayBackStack()

      expect(onClose).toHaveBeenCalledTimes(1)
      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})
