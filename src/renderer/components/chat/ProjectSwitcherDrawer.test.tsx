import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSwitcherDrawer } from './ProjectSwitcherDrawer'

const { mockSwitchProject, queuedRef } = vi.hoisted(() => ({
  mockSwitchProject: vi.fn(),
  queuedRef: { current: null as string | null }
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: unknown) => unknown) =>
    selector({ switchProject: mockSwitchProject, queuedProjectSwitchId: queuedRef.current })
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
})
