import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSheetCloseFocus } from '@/hooks/use-sheet-close-focus'
import { ProjectSwitcherDrawer } from './ProjectSwitcherDrawer'

const {
  mockSwitchProject,
  queuedRef,
  failedRef,
  setFailedProjectSwitch,
  toastError,
  toastSuccess,
  mockSetDefaultProject,
  mockLogFrontendError
} = vi.hoisted(() => ({
  mockSwitchProject: vi.fn(),
  queuedRef: { current: null as string | null },
  failedRef: { current: null as string | null },
  setFailedProjectSwitch: vi.fn((projectId: string | null) => {
    failedRef.current = projectId
  }),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  mockSetDefaultProject: vi.fn(),
  mockLogFrontendError: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

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
  toast: { error: toastError, success: toastSuccess }
}))

// "Set as host default" goes through the web route on a browser client.
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => false
}))

vi.mock('@/lib/web-server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/web-server-api')>()),
  webServerProjects: { setDefaultProject: mockSetDefaultProject }
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

// A plain selector function plus the `setState` the success path of "Set as host
// default" calls (it flips the `isDefault` flags locally); the updater is run
// against the shared `state` below.
vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
    setState: (updater: (s: typeof state) => Partial<typeof state>) => {
      Object.assign(state, updater(state))
    }
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
    const { rerender } = render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))
    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith('p3'))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    queuedRef.current = 'p3'
    rerender(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)
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
    const { rerender } = render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))

    await waitFor(() => expect(mockSwitchProject).toHaveBeenCalledWith('p3'))
    // The drawer marks the failed project on the store so the inline badge can
    // render (mirrors how `applyFailedProjectSwitch` sets it for the event path).
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
    expect(screen.getByText('Gamma').closest('button')).toHaveAttribute('aria-disabled', 'true')

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
      queuedRef.current = 'p2'
      render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

      const gammaBtn = (await screen.findByText('Gamma')).closest('button') as HTMLButtonElement
      expect(gammaBtn).toHaveAttribute('aria-disabled', 'true')
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

  describe('Set as host default (bottom project sheet)', () => {
    const base = {
      color: 'blue',
      isArchived: false,
      isActive: false,
      envVars: [],
      worktrees: [],
      activeWorktreeId: null
    }
    const sheetProjects = [
      { ...base, id: 'p1', name: 'Alpha', path: '/a', isActive: true, isDefault: true },
      { ...base, id: 'p2', name: 'Beta', path: null, isArchived: true },
      { ...base, id: 'p3', name: 'Gamma', path: '/g' },
      { ...base, id: 'p4', name: 'Delta', path: '' },
      { ...base, id: 'p5', name: 'Epsilon', path: undefined }
    ]
    const control = (name: string): HTMLElement | null =>
      screen.queryByRole('button', { name: `Set "${name}" as host default` })

    function renderSheet(): ReturnType<typeof render> {
      return render(
        <ProjectSwitcherDrawer
          open
          onOpenChange={vi.fn()}
          side="bottom"
          id="mobile-project-sheet"
        />
      )
    }

    it('renders the 44px control for a non-default project with a path, and not for the others', async () => {
      const original = state.projects
      state.projects = sheetProjects as unknown as typeof state.projects
      try {
        renderSheet()
        await screen.findByText('Gamma')

        expect(control('Gamma')).toBeInTheDocument()
        expect(control('Gamma')).toHaveClass('size-11')
        expect(control('Gamma')).toHaveAttribute('title', 'Set as host default')
        // The host default, an archived project and the two pathless ones get none.
        for (const name of ['Alpha', 'Beta', 'Delta', 'Epsilon']) {
          expect(control(name), name).not.toBeInTheDocument()
        }
      } finally {
        state.projects = original
      }
    })

    it('calls the default-project route once for that project and confirms it', async () => {
      mockSetDefaultProject.mockResolvedValue({ success: true })
      const original = state.projects
      state.projects = sheetProjects.map((p) => ({ ...p })) as unknown as typeof state.projects
      try {
        renderSheet()
        await screen.findByText('Gamma')

        fireEvent.click(control('Gamma') as HTMLElement)

        await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
        expect(mockSetDefaultProject).toHaveBeenCalledTimes(1)
        expect(mockSetDefaultProject).toHaveBeenCalledWith('p3')
        expect(toastSuccess).toHaveBeenCalledWith('"Gamma" is now the host default')
        expect(toastError).not.toHaveBeenCalled()
        // The flags flip locally so the badge refreshes at once.
        expect(
          (state.projects as unknown as Array<{ id: string; isDefault?: boolean }>)
            .filter((p) => p.isDefault)
            .map((p) => p.id)
        ).toEqual(['p3'])
      } finally {
        state.projects = original
      }
    })

    it('does not switch the session when the control is tapped', async () => {
      mockSetDefaultProject.mockResolvedValue({ success: true })
      const original = state.projects
      state.projects = sheetProjects.map((p) => ({ ...p })) as unknown as typeof state.projects
      try {
        renderSheet()
        await screen.findByText('Gamma')

        fireEvent.click(control('Gamma') as HTMLElement)

        await waitFor(() => expect(mockSetDefaultProject).toHaveBeenCalledTimes(1))
        expect(mockSwitchProject).not.toHaveBeenCalled()
      } finally {
        state.projects = original
      }
    })

    it('reports a refused change without flipping the flags', async () => {
      mockSetDefaultProject.mockResolvedValue({ success: false, error: 'NOT_FOUND' })
      const original = state.projects
      state.projects = sheetProjects.map((p) => ({ ...p })) as unknown as typeof state.projects
      try {
        renderSheet()
        await screen.findByText('Gamma')

        fireEvent.click(control('Gamma') as HTMLElement)

        await waitFor(() =>
          expect(toastError).toHaveBeenCalledWith('Failed to set host default: NOT_FOUND')
        )
        expect(toastSuccess).not.toHaveBeenCalled()
        expect(
          (state.projects as unknown as Array<{ id: string; isDefault?: boolean }>)
            .filter((p) => p.isDefault)
            .map((p) => p.id)
        ).toEqual(['p1'])
      } finally {
        state.projects = original
      }
    })
  })
})
