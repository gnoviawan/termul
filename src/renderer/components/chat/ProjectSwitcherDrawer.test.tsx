import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSheetCloseFocus } from '@/hooks/use-sheet-close-focus'
import { useAcpStore } from '@/stores/acp-store'
import { ProjectSwitcherDrawer } from './ProjectSwitcherDrawer'

const { mockSwitchProject, setFailedProjectSwitch, toastError, mockLogFrontendError } = vi.hoisted(
  () => ({
    mockSwitchProject: vi.fn(),
    setFailedProjectSwitch: vi.fn(),
    toastError: vi.fn(),
    mockLogFrontendError: vi.fn()
  })
)

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

// A real zustand store, so the sheet re-renders when a marker changes and the
// shared switch hook can read it through `getState()`. `switchProject` mirrors
// the real action's contract: it publishes `switchingProjectId` before it
// yields and clears it on every exit.
vi.mock('@/stores/acp-store', async () => {
  const { create } = await import('zustand')
  interface SwitchState {
    queuedProjectSwitchId: string | null
    failedProjectSwitchId: string | null
    switchingProjectId: string | null
    switchProject: (projectId: string) => Promise<unknown>
    setFailedProjectSwitch: (projectId: string | null) => void
  }
  const useAcpStore = create<SwitchState>()((set) => ({
    queuedProjectSwitchId: null,
    failedProjectSwitchId: null,
    switchingProjectId: null,
    switchProject: async (projectId) => {
      set({ switchingProjectId: projectId })
      try {
        return await mockSwitchProject(projectId)
      } finally {
        set({ switchingProjectId: null })
      }
    },
    setFailedProjectSwitch: (projectId) => {
      setFailedProjectSwitch(projectId)
      set({ failedProjectSwitchId: projectId })
    }
  }))
  return { useAcpStore }
})

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
  useProjectStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
    getState: () => state
  })
}))

const state = {
  projects,
  activeProjectId: 'p1',
  selectProject: vi.fn()
}

describe('ProjectSwitcherDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAcpStore.setState({
      queuedProjectSwitchId: null,
      failedProjectSwitchId: null,
      switchingProjectId: null
    })
  })

  function setSwitchMarkers(markers: {
    queuedProjectSwitchId?: string | null
    failedProjectSwitchId?: string | null
    switchingProjectId?: string | null
  }): void {
    act(() => {
      useAcpStore.setState(markers)
    })
  }

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

    // Archived project uses the disabled text token and is not clickable.
    const betaBtn = screen.getByText('Beta').closest('button')
    expect(betaBtn).toBeDisabled()
    expect(betaBtn?.className).toContain('text-disabled-foreground')
    expect(screen.getByText('Current')).toBeInTheDocument()

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
    render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))
    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith('p3'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    // The store records the queued target once the server accepts the switch.
    setSwitchMarkers({ queuedProjectSwitchId: 'p3' })
    expect(await screen.findByText('Queued')).toBeInTheDocument()
    // Busy rows stay in the tab order (aria-disabled, not disabled).
    const gammaBtn = screen.getByText('Gamma').closest('button')
    expect(gammaBtn).toHaveAttribute('aria-disabled', 'true')
    expect(gammaBtn).not.toBeDisabled()
  })

  it('surfaces a rejected switch as an inline "Failed" badge + toast and stays open', async () => {
    mockSwitchProject.mockRejectedValue(
      new Error('switch_project requires a live agent; open a chat first')
    )
    const onOpenChange = vi.fn()
    render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))

    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith('p3'))
    // The shared switch hook marks the failed project on the store so the inline
    // badge can render (mirrors how `applyFailedProjectSwitch` sets it for the
    // event path).
    await waitFor(() => expect(setFailedProjectSwitch).toHaveBeenCalledWith('p3'))
    expect(toastError).toHaveBeenCalledWith(
      'switch_project requires a live agent; open a chat first'
    )
    expect(mockLogFrontendError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'ProjectSwitcherDrawer',
      message:
        'Project switch failed for p3: switch_project requires a live agent; open a chat first'
    })
    // A failed switch does not close the drawer.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    expect(await screen.findByText('Failed')).toBeInTheDocument()
    // The failed row stays retryable (not disabled) so the user can retry.
    expect(screen.getByText('Gamma').closest('button')).not.toBeDisabled()
  })

  it('replaces the Queued badge with a Failed badge when a queued switch fails', async () => {
    render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

    // Queued switch in flight: badge shows + row disabled.
    setSwitchMarkers({ queuedProjectSwitchId: 'p3' })
    expect(await screen.findByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Gamma').closest('button')).toHaveAttribute('aria-disabled', 'true')

    // Server emits `project_switch_failed`: store clears queued + sets failed.
    setSwitchMarkers({ queuedProjectSwitchId: null, failedProjectSwitchId: 'p3' })
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
    expect(await screen.findByText('Failed')).toBeInTheDocument()
    // Retryable again now that the turn is idle.
    expect(screen.getByText('Gamma').closest('button')).not.toBeDisabled()
  })

  it('clears a failure that arrives while the drawer is closed (no stale badge on reopen)', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    // Queued switch in flight while the drawer is open.
    setSwitchMarkers({ queuedProjectSwitchId: 'p3' })
    expect(await screen.findByText('Queued')).toBeInTheDocument()

    // User closes the drawer while the queued switch is still pending server-side.
    rerender(<ProjectSwitcherDrawer open={false} onOpenChange={onOpenChange} />)

    // The queued switch fails AFTER closure: store clears queued + sets failed.
    setFailedProjectSwitch.mockClear()
    setSwitchMarkers({ queuedProjectSwitchId: null, failedProjectSwitchId: 'p3' })

    // The cleanup effect must react to the late failure (its deps include
    // `failedProjectSwitchId`) and clear it so it can't resurface on reopen.
    await waitFor(() => expect(setFailedProjectSwitch).toHaveBeenCalledWith(null))

    // Store honored the clear → reopening shows no stale "Failed"/"Queued" badge.
    await waitFor(() => expect(useAcpStore.getState().failedProjectSwitchId).toBeNull())
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    expect(screen.queryByText('Failed')).not.toBeInTheDocument()
    expect(screen.queryByText('Queued')).not.toBeInTheDocument()
  })

  describe('busy rows keep focus (aria-disabled guard)', () => {
    it('marks non-active, non-archived rows aria-disabled while a switch is in flight and ignores taps', async () => {
      let resolveSwitch: (value: unknown) => void = () => {}
      mockSwitchProject.mockReturnValue(
        new Promise((resolve) => {
          resolveSwitch = resolve
        })
      )
      render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

      const gammaBtn = (await screen.findByText('Gamma')).closest('button') as HTMLButtonElement
      gammaBtn.focus()
      fireEvent.click(gammaBtn)
      await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledTimes(1))

      // The tapped row stays enabled and focused; only aria-disabled flips.
      expect(gammaBtn).toHaveAttribute('aria-disabled', 'true')
      expect(gammaBtn).not.toBeDisabled()
      expect(document.activeElement).toBe(gammaBtn)

      // A second tap while busy is ignored.
      fireEvent.click(gammaBtn)
      expect(mockSwitchProject).toHaveBeenCalledTimes(1)

      // Active and archived rows keep the hard `disabled`, never aria-disabled.
      const alphaBtn = screen.getByText('Alpha').closest('button')
      const betaBtn = screen.getByText('Beta').closest('button')
      expect(alphaBtn).toBeDisabled()
      expect(alphaBtn).not.toHaveAttribute('aria-disabled')
      expect(betaBtn).toBeDisabled()
      expect(betaBtn).not.toHaveAttribute('aria-disabled')

      resolveSwitch({ status: 'selected', projectId: 'p3' })
      await waitFor(() => expect(gammaBtn).not.toHaveAttribute('aria-disabled'))
    })

    it('ignores taps on a non-active row while another switch is queued', async () => {
      setSwitchMarkers({ queuedProjectSwitchId: 'p2' })
      render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

      const gammaBtn = (await screen.findByText('Gamma')).closest('button') as HTMLButtonElement
      expect(gammaBtn).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(gammaBtn)

      expect(mockSwitchProject).not.toHaveBeenCalled()
    })

    it('shows a switch another caller started (the palette) and ignores taps meanwhile', async () => {
      setSwitchMarkers({ switchingProjectId: 'p3' })
      render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

      const gammaBtn = (await screen.findByText('Gamma')).closest('button') as HTMLButtonElement
      expect(gammaBtn).toHaveAttribute('aria-disabled', 'true')
      expect(gammaBtn).not.toBeDisabled()
      // The in-progress spinner follows the store marker, not the drawer's own tap.
      expect(gammaBtn.querySelector('.tm-comet')).not.toBeNull()
      const alphaBtn = screen.getByText('Alpha').closest('button') as HTMLButtonElement
      expect(alphaBtn.querySelector('.tm-comet')).toBeNull()
      fireEvent.click(gammaBtn)

      expect(mockSwitchProject).not.toHaveBeenCalled()
    })

    it('keeps focus on the failed row so the user can retry', async () => {
      mockSwitchProject.mockRejectedValue(new Error('boom'))
      render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

      const gammaBtn = (await screen.findByText('Gamma')).closest('button') as HTMLButtonElement
      gammaBtn.focus()
      fireEvent.click(gammaBtn)

      await waitFor(() => expect(setFailedProjectSwitch).toHaveBeenCalledWith('p3'))
      await waitFor(() => expect(gammaBtn).not.toHaveAttribute('aria-disabled'))
      expect(document.activeElement).toBe(gammaBtn)
    })
  })

  describe('Add project row', () => {
    it('is always visible after the list and closes the sheet before calling onAddProject', async () => {
      const calls: string[] = []
      const onOpenChange = vi.fn((open: boolean) => calls.push(`open:${open}`))
      const onAddProject = vi.fn(() => calls.push('add'))
      render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} onAddProject={onAddProject} />)

      const addRow = await screen.findByRole('button', { name: 'Add project' })
      expect(addRow.className).toContain('min-h-11')
      // It follows the project list.
      const gamma = screen.getByText('Gamma')
      expect(gamma.compareDocumentPosition(addRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // It is pinned below the scrolling list, so a long list cannot scroll it away.
      expect(addRow.closest('.overflow-auto')).toBeNull()
      expect(gamma.closest('.overflow-auto')).not.toBeNull()

      fireEvent.click(addRow)
      expect(calls).toEqual(['open:false', 'add'])
    })

    it('shows after the empty text when there are no projects', async () => {
      const original = state.projects
      state.projects = []
      try {
        const onAddProject = vi.fn()
        render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} onAddProject={onAddProject} />)

        const empty = await screen.findByText('No projects available. Add one to get started.')
        const addRow = screen.getByRole('button', { name: 'Add project' })
        expect(
          empty.compareDocumentPosition(addRow) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()
        expect(addRow.closest('.overflow-auto')).toBeNull()
        fireEvent.click(addRow)
        expect(onAddProject).toHaveBeenCalledTimes(1)
      } finally {
        state.projects = original
      }
    })

    it('is omitted when no add handler is available', async () => {
      render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

      await screen.findByText('Alpha')
      expect(screen.queryByRole('button', { name: 'Add project' })).not.toBeInTheDocument()
    })
  })

  describe('bottom sheet', () => {
    it('opens from the bottom with the sheet id, height cap and safe-area padding', async () => {
      render(
        <ProjectSwitcherDrawer
          open
          onOpenChange={vi.fn()}
          side="bottom"
          id="mobile-project-sheet"
        />
      )

      const sheet = (await screen.findByText('Alpha')).closest('[data-sheet]')
      expect(sheet).not.toBeNull()
      expect(sheet?.id).toBe('mobile-project-sheet')
      const cls = sheet?.className ?? ''
      expect(cls).toContain('rounded-t-xl')
      expect(cls).toContain('max-h-[85dvh]')
      expect(cls).toContain('overflow-y-auto')
      expect(cls).toContain('overscroll-contain')
      expect(cls).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
      expect(cls).not.toContain('w-[72vw]')
      expect(screen.getByText('Projects')).toBeInTheDocument()
    })

    it('forwards onCloseAutoFocus so the owner can return focus', async () => {
      const onCloseAutoFocus = vi.fn((event: Event) => event.preventDefault())
      const { rerender } = render(
        <ProjectSwitcherDrawer open onOpenChange={vi.fn()} onCloseAutoFocus={onCloseAutoFocus} />
      )
      await screen.findByText('Alpha')

      rerender(
        <ProjectSwitcherDrawer
          open={false}
          onOpenChange={vi.fn()}
          onCloseAutoFocus={onCloseAutoFocus}
        />
      )

      await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledTimes(1))
    })

    it('returns focus to the opener after a successful switch closes the sheet', async () => {
      mockSwitchProject.mockResolvedValue({ status: 'completed', projectId: 'p3' })

      function Harness(): React.JSX.Element {
        const [open, setOpen] = useState(true)
        const openerRef = useRef<HTMLButtonElement>(null)
        const { onCloseAutoFocus } = useSheetCloseFocus(openerRef)
        return (
          <>
            <button type="button" ref={openerRef}>
              subtitle
            </button>
            <ProjectSwitcherDrawer
              open={open}
              onOpenChange={setOpen}
              side="bottom"
              onCloseAutoFocus={onCloseAutoFocus}
            />
          </>
        )
      }
      render(<Harness />)

      fireEvent.click(await screen.findByText('Gamma'))

      await waitFor(() => expect(screen.queryByText('Gamma')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'subtitle' }))
      )
    })
  })
})
