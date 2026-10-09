import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import type { Snapshot } from '@/types/project'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

// L-31: the REAL Restore and Delete modals mounted by the Snapshots page, on the
// mobile shell. The page's guarded closes (`handleCloseRestoreModal` and
// `handleCloseDeleteModal`) veto while a restore or delete is in flight; system
// back must go through them, never around them.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    restoreSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    snapshots: [] as Snapshot[]
  }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => true,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

vi.mock('@/hooks/use-snapshots', () => ({
  useSnapshotLoader: () => {},
  useCreateSnapshot: () => vi.fn(),
  useRenameSnapshot: () => vi.fn(),
  useRestoreSnapshot: () => mocks.restoreSnapshot,
  useSnapshotActions: () => ({
    loadSnapshots: vi.fn(),
    createSnapshot: vi.fn(),
    deleteSnapshot: mocks.deleteSnapshot,
    getSnapshot: vi.fn(),
    clearSnapshots: vi.fn(),
    renameSnapshot: vi.fn()
  }),
  useSnapshotLoading: () => false,
  useSnapshots: () => mocks.snapshots
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => ({ id: 'proj-1', name: 'My Project', color: 'blue' as const }),
  useActiveProjectId: () => 'proj-1',
  useProjectsLoaded: () => true,
  useProjectActions: () => ({ addProject: vi.fn() })
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: (selector: (state: { terminals: unknown[] }) => unknown) =>
    selector({ terminals: [] })
}))

vi.mock('@/components/CreateSnapshotModal', () => ({ CreateSnapshotModal: () => null }))
vi.mock('@/components/NewProjectModal', () => ({ NewProjectModal: () => null }))

import WorkspaceSnapshots from './WorkspaceSnapshots'

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

const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

function renderPage(): void {
  render(
    <MemoryRouter>
      <WorkspaceSnapshots />
    </MemoryRouter>
  )
}

/** A promise the test settles by hand, to hold a restore or delete in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('WorkspaceSnapshots modals and the overlay back stack (mobile shell)', () => {
  let cleanup: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.snapshots = [snapshot]
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    mocks.snapshots = []
    vi.restoreAllMocks()
  })

  describe('Restore modal', () => {
    it('system back closes an idle modal, leaves the route and consumes the sentinel', async () => {
      renderPage()
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
      expect(screen.getByText('Restore Snapshot')).toBeInTheDocument()
      expect(stackIds()[0]).toMatch(/^restore-snapshot-modal:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByText('Restore Snapshot')).not.toBeInTheDocument(), {
        timeout: 3000
      })
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(mocks.restoreSnapshot).not.toHaveBeenCalled()
    })

    it('an in-flight restore vetoes system back: the modal stays and a fresh sentinel is armed', async () => {
      const inFlight = deferred()
      mocks.restoreSnapshot.mockReturnValue(inFlight.promise)
      renderPage()
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
      await waitForSentinelDepth(1)
      // The modal's own Restore button (rendered after the card's).
      fireEvent.click(screen.getAllByRole('button', { name: 'Restore' }).at(-1) as HTMLElement)
      expect(await screen.findByText('Restoring...')).toBeInTheDocument()
      const pushSpy = vi.spyOn(history, 'pushState')

      await pressSystemBack()

      // The page's guard refused: still open, still registered, one new sentinel.
      expect(screen.getByText('Restore Snapshot')).toBeInTheDocument()
      expect(stackIds()).toHaveLength(1)
      await waitForSentinelDepth(1)
      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(location.hash).toBe('#/base')

      // Once the restore settles the modal closes and the sentinel is consumed.
      await act(async () => {
        inFlight.resolve()
        await inFlight.promise
      })
      await waitFor(() => expect(screen.queryByText('Restore Snapshot')).not.toBeInTheDocument(), {
        timeout: 3000
      })
      await waitForSentinelDepth(0)
      expect(stackIds()).toEqual([])
    })
  })

  describe('Delete modal', () => {
    it('system back closes an idle modal, leaves the route and consumes the sentinel', async () => {
      renderPage()
      fireEvent.click(screen.getByRole('button', { name: 'Delete snapshot' }))
      expect(screen.getByText('Delete Snapshot')).toBeInTheDocument()
      expect(stackIds()[0]).toMatch(/^delete-snapshot-modal:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByText('Delete Snapshot')).not.toBeInTheDocument(), {
        timeout: 3000
      })
      expect(stackIds()).toEqual([])
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
      expect(mocks.deleteSnapshot).not.toHaveBeenCalled()
    })

    it('an in-flight delete vetoes system back: the modal stays and a fresh sentinel is armed', async () => {
      const inFlight = deferred()
      mocks.deleteSnapshot.mockReturnValue(inFlight.promise)
      renderPage()
      fireEvent.click(screen.getByRole('button', { name: 'Delete snapshot' }))
      await waitForSentinelDepth(1)
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      expect(await screen.findByText('Deleting...')).toBeInTheDocument()
      const pushSpy = vi.spyOn(history, 'pushState')

      await pressSystemBack()

      expect(screen.getByText('Delete Snapshot')).toBeInTheDocument()
      expect(stackIds()).toHaveLength(1)
      await waitForSentinelDepth(1)
      expect(pushSpy).toHaveBeenCalledTimes(1)
      expect(location.hash).toBe('#/base')

      await act(async () => {
        inFlight.resolve()
        await inFlight.promise
      })
      await waitFor(() => expect(screen.queryByText('Delete Snapshot')).not.toBeInTheDocument(), {
        timeout: 3000
      })
      await waitForSentinelDepth(0)
      expect(stackIds()).toEqual([])
    })
  })
})
