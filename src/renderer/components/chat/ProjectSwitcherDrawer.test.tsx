import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSwitcherDrawer } from './ProjectSwitcherDrawer'

const { mockSwitchProject, queuedRef, failedRef, setFailedProjectSwitch, toastError } = vi.hoisted(
  () => ({
    mockSwitchProject: vi.fn(),
    queuedRef: { current: null as string | null },
    failedRef: { current: null as string | null },
    setFailedProjectSwitch: vi.fn((projectId: string | null) => {
      failedRef.current = projectId
    }),
    toastError: vi.fn()
  })
)

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: unknown) => unknown) =>
    selector({
      switchProject: mockSwitchProject,
      queuedProjectSwitchId: queuedRef.current,
      failedProjectSwitchId: failedRef.current,
      setFailedProjectSwitch
    })
}))

vi.mock('sonner', () => ({
  toast: { error: toastError }
}))

const projects = [
  {
    id: 'p1',
    name: 'Alpha',
    color: 'blue',
    path: '/a',
    isArchived: false,
    isActive: true,
    envVars: [],
    worktrees: [],
    activeWorktreeId: null
  },
  {
    id: 'p2',
    name: 'Beta',
    color: 'gray',
    path: null,
    isArchived: true,
    isActive: false,
    envVars: [],
    worktrees: [],
    activeWorktreeId: null
  },
  {
    id: 'p3',
    name: 'Gamma',
    color: 'green',
    path: '/g',
    isArchived: false,
    isActive: false,
    envVars: [],
    worktrees: [],
    activeWorktreeId: null
  }
]

vi.mock('@/stores/project-store', () => ({
  useProjectStore: (sel: (s: typeof state) => unknown) => sel(state)
}))

const state = {
  projects,
  activeProjectId: 'p1',
  selectProject: vi.fn()
}

describe('ProjectSwitcherDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queuedRef.current = null
    failedRef.current = null
  })

  it('renders the mirrored list, marks the active project, disables archived + active entries', async () => {
    render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

    // Radix Sheet content mounts asynchronously in jsdom.
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.getByText('Gamma')).toBeInTheDocument()

    const alphaBtn = screen.getByText('Alpha').closest('button')
    // Active project is marked + DISABLED (re-clicking would destroy the
    // current session by starting a fresh one at the same cwd — E4 guard).
    expect(alphaBtn).toHaveAttribute('aria-current', 'true')
    expect(alphaBtn).toBeDisabled()

    // Archived project renders greyed (opacity-50) + disabled.
    const betaBtn = screen.getByText('Beta').closest('button')
    expect(betaBtn).toBeDisabled()
    expect(betaBtn?.className).toContain('opacity-50')

    // Non-active, non-archived project is enabled + not marked.
    const gammaBtn = screen.getByText('Gamma').closest('button')
    expect(gammaBtn).not.toBeDisabled()
    expect(gammaBtn).not.toHaveAttribute('aria-current', 'true')
  })

  it('switches the shared session on clicking a non-active project', async () => {
    mockSwitchProject.mockResolvedValue({
      status: 'completed',
      projectId: 'p3',
      sessionId: 's-new',
      cwd: '/g',
      mcpServerCount: 2
    })
    const onOpenChange = vi.fn()
    render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))

    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith('p3'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the drawer open and shows queued state until completion', async () => {
    mockSwitchProject.mockResolvedValue({
      status: 'queued',
      projectId: 'p3',
      currentSessionId: 's-old'
    })
    const onOpenChange = vi.fn()
    const { rerender } = render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))
    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith('p3'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    queuedRef.current = 'p3'
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
    expect(await screen.findByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Gamma').closest('button')).toBeDisabled()
  })

  it('surfaces a rejected switch as an inline "Failed" badge + toast and stays open', async () => {
    mockSwitchProject.mockRejectedValue(
      new Error('switch_project requires a live agent; open a chat first')
    )
    const onOpenChange = vi.fn()
    const { rerender } = render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))

    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith('p3'))
    // The drawer marks the failed project on the store so the inline badge can
    // render (mirrors how `applyFailedProjectSwitch` sets it for the event path).
    await waitFor(() => expect(setFailedProjectSwitch).toHaveBeenCalledWith('p3'))
    expect(toastError).toHaveBeenCalledWith(
      'switch_project requires a live agent; open a chat first'
    )
    // A failed switch does not close the drawer.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    failedRef.current = 'p3'
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
    expect(await screen.findByText('Failed')).toBeInTheDocument()
    // The failed row stays retryable (not disabled) so the user can retry.
    expect(screen.getByText('Gamma').closest('button')).not.toBeDisabled()
  })

  it('replaces the Queued badge with a Failed badge when a queued switch fails', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    // Queued switch in flight: badge shows + row disabled.
    queuedRef.current = 'p3'
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
    expect(await screen.findByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Gamma').closest('button')).toBeDisabled()

    // Server emits `project_switch_failed`: store clears queued + sets failed.
    queuedRef.current = null
    failedRef.current = 'p3'
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
    expect(await screen.findByText('Failed')).toBeInTheDocument()
    // Retryable again now that the turn is idle.
    expect(screen.getByText('Gamma').closest('button')).not.toBeDisabled()
  })

  it('clears a failure that arrives while the drawer is closed (no stale badge on reopen)', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    // Queued switch in flight while the drawer is open.
    queuedRef.current = 'p3'
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
    expect(await screen.findByText('Queued')).toBeInTheDocument()

    // User closes the drawer while the queued switch is still pending server-side.
    rerender(<ProjectSwitcherDrawer open={false} onOpenChange={onOpenChange} />)

    // The queued switch fails AFTER closure: store clears queued + sets failed.
    queuedRef.current = null
    failedRef.current = 'p3'
    setFailedProjectSwitch.mockClear()
    rerender(<ProjectSwitcherDrawer open={false} onOpenChange={onOpenChange} />)

    // The cleanup effect must react to the late failure (its deps include
    // `failedProjectSwitchId`) and clear it so it can't resurface on reopen.
    await waitFor(() => expect(setFailedProjectSwitch).toHaveBeenCalledWith(null))

    // Store honored the clear → reopening shows no stale "Failed"/"Queued" badge.
    await waitFor(() => expect(failedRef.current).toBeNull())
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
  })
})
