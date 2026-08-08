import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoist the spy so the vi.mock factory (also hoisted) can reference it.
const { resolveManifestMock } = vi.hoisted(() => ({
  resolveManifestMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/hooks/use-workspace-manifest-sync', () => ({
  resolveManifestConflict: (...args: unknown[]) => resolveManifestMock(...args)
}))

import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceManifestSyncStore } from '@/stores/workspace-manifest-sync-store'
// Import the component AFTER the mock is registered so it picks up the mock.
import { WorkspaceConflictBanner } from './WorkspaceConflictBanner'

const CONFLICT = {
  projectId: 'proj-1',
  currentRevision: 5,
  currentUpdatedAt: 1234567890,
  currentUpdateIdentity: 'other-client'
}

beforeEach(() => {
  resolveManifestMock.mockClear()
  useWorkspaceManifestSyncStore.setState({
    pendingConflict: null,
    basedRevisionByProject: {},
    manifestRestoreInProgressByProject: {}
  })
  // Default: the active project matches the conflict's project so the banner
  // is visible. P1 tests override this to a different project.
  useProjectStore.setState({ activeProjectId: 'proj-1' })
})

afterEach(() => {
  cleanup()
})

describe('WorkspaceConflictBanner', () => {
  it('renders nothing when there is no pending conflict', () => {
    const { container } = render(<WorkspaceConflictBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the banner with three actions when a conflict is pending for the active project', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    render(<WorkspaceConflictBanner />)

    expect(screen.getByText('Workspace changed elsewhere')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload from host' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Overwrite with local' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.getByText(/revision 5/)).toBeInTheDocument()
  })

  it('P1: renders nothing when the conflict is for a different (non-active) project', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    useProjectStore.setState({ activeProjectId: 'proj-B' })

    const { container } = render(<WorkspaceConflictBanner />)
    expect(container.firstChild).toBeNull()
  })

  it('P1: renders the banner when the active project switches back to the conflicted project', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    useProjectStore.setState({ activeProjectId: 'proj-B' })

    const { container, rerender } = render(<WorkspaceConflictBanner />)
    expect(container.firstChild).toBeNull()

    act(() => {
      useProjectStore.setState({ activeProjectId: 'proj-1' })
    })
    rerender(<WorkspaceConflictBanner />)
    expect(container.firstChild).not.toBeNull()
  })

  it('P14: displays currentUpdatedAt and currentUpdateIdentity when present', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    render(<WorkspaceConflictBanner />)

    // currentUpdateIdentity is rendered with a "by" prefix.
    expect(screen.getByText(/by other-client/)).toBeInTheDocument()
    // currentUpdatedAt is rendered as a formatted timestamp.
    expect(screen.getByText(/revision 5 \(/)).toBeInTheDocument()
  })

  it('calls resolveManifestConflict with "reload" when Reload is clicked', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    render(<WorkspaceConflictBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Reload from host' }))

    expect(resolveManifestMock).toHaveBeenCalledWith('proj-1', 'reload')
  })

  it('calls resolveManifestConflict with "overwrite" when Overwrite is clicked', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    render(<WorkspaceConflictBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with local' }))

    expect(resolveManifestMock).toHaveBeenCalledWith('proj-1', 'overwrite')
  })

  it('calls resolveManifestConflict with "dismiss" when Dismiss is clicked', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    render(<WorkspaceConflictBanner />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(resolveManifestMock).toHaveBeenCalledWith('proj-1', 'dismiss')
  })

  it('auto-dismisses (renders nothing) once the conflict is cleared', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    const { rerender, container } = render(<WorkspaceConflictBanner />)
    expect(container.firstChild).not.toBeNull()

    act(() => {
      useWorkspaceManifestSyncStore.setState({ pendingConflict: null })
    })
    rerender(<WorkspaceConflictBanner />)

    expect(container.firstChild).toBeNull()
  })

  it('renders an accessible alert region (role=alert)', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    render(<WorkspaceConflictBanner />)

    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('uses type="button" on all action buttons (useButtonType compliance)', () => {
    useWorkspaceManifestSyncStore.setState({ pendingConflict: CONFLICT })
    render(<WorkspaceConflictBanner />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(3)
    for (const button of buttons) {
      expect(button.getAttribute('type')).toBe('button')
    }
  })
})
