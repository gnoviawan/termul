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
import type { Snapshot } from '@/types/project'
import { RestoreSnapshotModal } from './RestoreSnapshotModal'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const snapshot: Snapshot = {
  id: 'snap-1',
  projectId: 'proj-1',
  name: 'Before refactor',
  description: 'A snapshot',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  paneCount: 2,
  processCount: 1,
  tag: 'base'
}

interface HarnessProps {
  onClose: () => void
  initialOpen?: boolean
  snapshotProp?: Snapshot | null
}

/** Owner with real state: the owner's close flips `isOpen`, like the page's guarded close. */
function Harness({
  onClose,
  initialOpen = true,
  snapshotProp = snapshot
}: HarnessProps): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  return (
    <RestoreSnapshotModal
      isOpen={open}
      snapshot={snapshotProp}
      hasRunningProcesses={false}
      isRestoring={false}
      onRestore={vi.fn()}
      onClose={() => {
        onClose()
        setOpen(false)
      }}
    />
  )
}

const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

describe('RestoreSnapshotModal overlay back stack', () => {
  let cleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('registers while open and system back calls the owner close once and consumes the sentinel', async () => {
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)

      expect(stackIds()).toHaveLength(1)
      expect(stackIds()[0]).toMatch(/^restore-snapshot-modal:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      expect(onClose).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByText('Restore Snapshot')).not.toBeInTheDocument(), {
        timeout: 3000
      })
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by the Cancel button consumes the sentinel', async () => {
      const onClose = vi.fn()
      render(<Harness onClose={onClose} />)
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitForSentinelDepth(0)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('does not register while closed', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      render(<Harness onClose={vi.fn()} initialOpen={false} />)
      await settleOverlayBackStack()

      expect(stackIds()).toEqual([])
      expect(pushSpy).not.toHaveBeenCalled()
    })

    it('does not register while the snapshot is null', async () => {
      const pushSpy = vi.spyOn(history, 'pushState')
      render(<Harness onClose={vi.fn()} snapshotProp={null} />)
      await settleOverlayBackStack()

      expect(stackIds()).toEqual([])
      expect(screen.queryByText('Restore Snapshot')).not.toBeInTheDocument()
      expect(pushSpy).not.toHaveBeenCalled()
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
