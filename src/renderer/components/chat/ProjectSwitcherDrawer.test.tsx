import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSheetFocusReturnForTests,
  recordSheetOpener,
  sheetCloseAutoFocus
} from '@/lib/sheet-focus-return'
import { ProjectSwitcherDrawer } from './ProjectSwitcherDrawer'

const { mockSwitchTo, toastError, toastSuccess, mockSetDefaultProject } = vi.hoisted(() => ({
  mockSwitchTo: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  mockSetDefaultProject: vi.fn()
}))

// Switching is client-only; the hook's own behavior is covered by
// `use-project-switch.test.tsx`. The sheet only reacts to its status.
vi.mock('@/hooks/use-project-switch', () => ({
  useProjectSwitch: () => ({ switchTo: mockSwitchTo })
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, success: toastSuccess }
}))

// "Set as host default" goes through the project registry facade on every surface.
vi.mock('@/lib/project-registry-api', () => ({
  projectRegistryApi: { setDefault: mockSetDefaultProject }
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
    worktrees: []
  },
  {
    id: 'p2',
    name: 'Beta',
    color: 'gray',
    path: null,
    isArchived: true,
    isActive: false,
    envVars: [],
    worktrees: []
  },
  {
    id: 'p3',
    name: 'Gamma',
    color: 'green',
    path: '/g',
    isArchived: false,
    isActive: false,
    envVars: [],
    worktrees: []
  }
]

// A plain selector function plus the `setState` the success path of "Set as host
// default" calls (it flips the `isDefault` flags locally); the updater is run
// against the shared `state` below.
vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
    setState: (updater: (s: typeof state) => Partial<typeof state>) => {
      Object.assign(state, updater(state))
    },
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
    mockSwitchTo.mockReturnValue('selected')
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

  it('switches the active project client-side and closes the sheet', async () => {
    const onOpenChange = vi.fn()
    render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))

    expect(mockSwitchTo).toHaveBeenCalledWith('p3')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the sheet open when the switch is ignored', async () => {
    mockSwitchTo.mockReturnValue('ignored')
    const onOpenChange = vi.fn()
    render(<ProjectSwitcherDrawer open onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Gamma'))

    expect(mockSwitchTo).toHaveBeenCalledWith('p3')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
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

  describe('Project settings', () => {
    it('shows only on the Current row and closes the sheet before opening settings', async () => {
      const calls: string[] = []
      const onOpenChange = vi.fn((open: boolean) => calls.push(`open:${open}`))
      const onOpenProjectSettings = vi.fn(() => calls.push('settings'))
      render(
        <ProjectSwitcherDrawer
          open
          onOpenChange={onOpenChange}
          onOpenProjectSettings={onOpenProjectSettings}
        />
      )

      const gear = await screen.findByRole('button', { name: '"Alpha" project settings' })
      expect(gear.className).toContain('size-11')
      expect(screen.getAllByRole('button', { name: /project settings/ })).toHaveLength(1)
      // It shares the active project's row.
      expect(gear.closest('li')).toContainElement(screen.getByText('Alpha'))

      fireEvent.click(gear)
      expect(calls).toEqual(['open:false', 'settings'])
    })

    it('is omitted when no settings handler is available', async () => {
      render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

      await screen.findByText('Alpha')
      expect(screen.queryByRole('button', { name: /project settings/ })).not.toBeInTheDocument()
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
      // Mirrors MobileChatShell: the subtitle is recorded as the sheet's opener.
      _resetSheetFocusReturnForTests()
      function Harness(): React.JSX.Element {
        const [open, setOpen] = useState(true)
        const openerRef = useRef<HTMLButtonElement>(null)
        useEffect(() => recordSheetOpener('projects-sheet', openerRef.current), [])
        return (
          <>
            <button type="button" ref={openerRef}>
              subtitle
            </button>
            <ProjectSwitcherDrawer
              open={open}
              onOpenChange={setOpen}
              side="bottom"
              onCloseAutoFocus={sheetCloseAutoFocus('projects-sheet')}
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
      worktrees: []
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

    it('sets the default through the registry once for that project and confirms it', async () => {
      mockSetDefaultProject.mockResolvedValue(undefined)
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
        // The badge moves when the `projects` watch delivers the new default,
        // not by a local flag flip.
        expect(
          (state.projects as unknown as Array<{ id: string; isDefault?: boolean }>)
            .filter((p) => p.isDefault)
            .map((p) => p.id)
        ).toEqual(['p1'])
      } finally {
        state.projects = original
      }
    })

    it('does not switch the session when the control is tapped', async () => {
      mockSetDefaultProject.mockResolvedValue(undefined)
      const original = state.projects
      state.projects = sheetProjects.map((p) => ({ ...p })) as unknown as typeof state.projects
      try {
        renderSheet()
        await screen.findByText('Gamma')

        fireEvent.click(control('Gamma') as HTMLElement)

        await waitFor(() => expect(mockSetDefaultProject).toHaveBeenCalledTimes(1))
        expect(mockSwitchTo).not.toHaveBeenCalled()
      } finally {
        state.projects = original
      }
    })

    it('reports a refused change without flipping the flags', async () => {
      mockSetDefaultProject.mockRejectedValue(new Error('NOT_FOUND'))
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
