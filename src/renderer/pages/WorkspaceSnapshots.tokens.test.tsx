import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Story 12 (QA F7 color sweep, matrix row 3): the mobile snapshot card and
// thumbnail render only token colors (success/destructive), never raw
// green-*/red-500.

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }
}))

const { snapMobileRef, snapMocks } = vi.hoisted(() => ({
  snapMobileRef: { current: true as boolean },
  snapMocks: {
    loadSnapshots: vi.fn(),
    createSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    renameSnapshot: vi.fn(),
    restoreSnapshot: vi.fn(),
    snapshots: [] as unknown[]
  }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => snapMobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

vi.mock('@/hooks/use-snapshots', () => ({
  useSnapshotLoader: () => {},
  useCreateSnapshot: () => snapMocks.createSnapshot,
  useRenameSnapshot: () => snapMocks.renameSnapshot,
  useRestoreSnapshot: () => snapMocks.restoreSnapshot,
  useSnapshotActions: () => ({
    loadSnapshots: snapMocks.loadSnapshots,
    createSnapshot: snapMocks.createSnapshot,
    deleteSnapshot: snapMocks.deleteSnapshot,
    getSnapshot: vi.fn(),
    clearSnapshots: vi.fn(),
    renameSnapshot: snapMocks.renameSnapshot
  }),
  useSnapshotLoading: () => false,
  useSnapshots: () => snapMocks.snapshots
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => ({ id: 'proj-1', name: 'My Project', color: 'blue' as const }),
  useActiveProjectId: () => 'proj-1',
  useProjectsLoaded: () => true,
  useProjectActions: () => ({ addProject: vi.fn() })
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: (selector: (s: unknown) => unknown) => selector({ terminals: [] })
}))

vi.mock('@/components/CreateSnapshotModal', () => ({
  CreateSnapshotModal: () => <div data-testid="create-snapshot-modal" />
}))
vi.mock('@/components/RestoreSnapshotModal', () => ({
  RestoreSnapshotModal: () => <div data-testid="restore-snapshot-modal" />
}))
vi.mock('@/components/DeleteSnapshotModal', () => ({
  DeleteSnapshotModal: () => <div data-testid="delete-snapshot-modal" />
}))
vi.mock('@/components/NewProjectModal', () => ({ NewProjectModal: () => null }))

import WorkspaceSnapshots from '@/pages/WorkspaceSnapshots'

describe('WorkspaceSnapshots mobile token sweep (story 12)', () => {
  beforeEach(() => {
    snapMobileRef.current = true
    snapMocks.snapshots = [
      {
        id: 'snap-1',
        projectId: 'proj-1',
        name: 'Tagged',
        description: 'desc',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        paneCount: 2,
        processCount: 1,
        tag: 'stable'
      },
      {
        id: 'snap-2',
        projectId: 'proj-1',
        name: 'Busy',
        description: 'desc',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        paneCount: 2,
        processCount: 3
      }
    ]
  })

  it('mobile card tag badge uses success tokens (no raw green-*)', () => {
    const { container } = render(
      <MemoryRouter>
        <WorkspaceSnapshots />
      </MemoryRouter>
    )

    expect(screen.getAllByText('stable')).not.toBeNull()
    const stableBadge = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'stable'
    )
    expect(stableBadge).toBeTruthy()
    expect(stableBadge?.className).toContain('text-success')
    expect(stableBadge?.className).toContain('bg-success')
    expect(stableBadge?.className).not.toMatch(/green-\d/)
  })

  it('mobile thumbnails use success/destructive tokens (no raw green/red)', () => {
    const { container } = render(
      <MemoryRouter>
        <WorkspaceSnapshots />
      </MemoryRouter>
    )

    // The thumbnail line divs carry the line color classes.
    const lineEls = container.querySelectorAll('.snapshot-line')
    expect(lineEls.length).toBeGreaterThan(0)
    for (const el of lineEls) {
      const cls = el.className
      expect(cls).not.toMatch(/green-\d/)
      expect(cls).not.toMatch(/red-\d/)
      expect(cls).toMatch(/bg-success|bg-destructive|bg-muted|bg-primary/)
    }
  })
})
