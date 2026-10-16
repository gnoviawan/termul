import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TopRowPlatform, TopRowRoles } from '@/lib/top-row'
import { useAcpStore } from '@/stores/acp-store'
import { useGitStatusStore } from '@/stores/git-status-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { SidePanelColumn } from './SidePanelColumn'
import { TopRowProvider } from './top-row-context'

vi.mock('@/components/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="file-explorer" />
}))

vi.mock('./WorkspaceSwitcher', () => ({
  WorkspaceSwitcher: ({ project }: { project: { id: string } }) => (
    <button type="button" data-testid="workspace-switcher" data-project={project.id}>
      Workspace
    </button>
  )
}))

vi.mock('./ChangesPanel', () => ({
  ChangesPanel: ({ cwd }: { cwd: string }) => <div data-testid="changes-panel" data-cwd={cwd} />
}))

const mocks = vi.hoisted(() => ({ showAgentLauncher: vi.fn() }))

const makeProject = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    name: 'One',
    path: '/repo',
    color: 'blue',
    gitBranch: 'main',
    isGitRepo: true,
    worktrees: [
      {
        id: 'w1',
        name: 'feature',
        branch: 'feat/x',
        path: '/repo/.termul/worktrees/feature',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    ...overrides
  }) as Project

function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderPanel(project: Project, initialPath = '/') {
  const view = (p: Project) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="*" element={<SidePanelColumn activeProject={p} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  )
  const result = render(view(project))
  return { ...result, rerenderProject: (p: Project) => result.rerender(view(p)) }
}

beforeEach(() => {
  mocks.showAgentLauncher.mockReset()
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'ready' })
  useAcpStore.setState({ sessionIndex: [], sessions: {}, agentConfigs: [] })
  useGitStatusStore.setState({ statuses: {} })
  useWorkspaceStore.setState({
    activePaneId: 'pane-1',
    showAgentLauncher: mocks.showAgentLauncher
  })
})

describe('SidePanelColumn', () => {
  it('renders the header, the three tabs and the Chats list by default', () => {
    renderPanel(makeProject())
    expect(screen.getByTestId('workspace-switcher')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Chats',
      'Explorer',
      'Changes'
    ])
    expect(screen.getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Search chats')).toBeInTheDocument()
  })

  it('mounts the Workspace switcher for the active project in the header', () => {
    renderPanel(makeProject())
    expect(screen.getByTestId('workspace-switcher')).toHaveAttribute('data-project', 'p1')
  })

  it('keeps the same switcher instance across a project prop update', () => {
    const { rerenderProject } = renderPanel(makeProject())
    const before = screen.getByTestId('workspace-switcher')
    rerenderProject(makeProject({ gitBranch: 'dev' }))
    expect(screen.getByTestId('workspace-switcher')).toBe(before)
  })

  it('opens the launcher from New chat', () => {
    renderPanel(makeProject())
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(mocks.showAgentLauncher).toHaveBeenCalledWith('pane-1')
  })

  it('navigates to the workspace route before opening the launcher', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    renderPanel(makeProject(), '/settings')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/')
    expect(mocks.showAgentLauncher).toHaveBeenCalledWith('pane-1')
    vi.restoreAllMocks()
  })

  it('remembers the last tab per project', async () => {
    const p1 = makeProject()
    const p2 = makeProject({ id: 'p2', name: 'Two', path: '/two', worktrees: [] })
    const { rerenderProject } = renderPanel(p1)

    fireEvent.click(screen.getByRole('tab', { name: 'Explorer' }))
    expect(await screen.findByTestId('file-explorer')).toBeInTheDocument()
    expect(useShellLayoutStore.getState().lastColumnTabByProject).toEqual({ p1: 'explorer' })

    rerenderProject(p2)
    expect(screen.getByRole('tab', { name: 'Chats' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('file-explorer')).toBeNull()

    rerenderProject(p1)
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('aria-selected', 'true')
  })

  it('renders the Changes panel for the picked working copy', () => {
    useShellLayoutStore.setState({
      worktreePickByProject: { p1: '/repo/.termul/worktrees/feature' }
    })
    useGitStatusStore.setState({
      statuses: {
        '/repo/.termul/worktrees/feature': [
          { path: 'a.ts' },
          { path: 'b.ts' },
          { path: 'a.ts' }
        ] as never
      }
    })
    renderPanel(makeProject())
    expect(screen.getByTestId('column-tab-changes-badge')).toHaveTextContent('2')

    fireEvent.click(screen.getByRole('tab', { name: /Changes/ }))
    expect(screen.getByTestId('changes-panel')).toHaveAttribute(
      'data-cwd',
      '/repo/.termul/worktrees/feature'
    )
  })

  it('uses the project path for Changes when nothing is picked', () => {
    renderPanel(makeProject())
    fireEvent.click(screen.getByRole('tab', { name: /Changes/ }))
    expect(screen.getByTestId('changes-panel')).toHaveAttribute('data-cwd', '/repo')
  })

  it('sizes the column from the store and exposes a resize separator', () => {
    useShellLayoutStore.setState({ sidePanelWidth: 300 })
    const { container } = renderPanel(makeProject())
    // 300px panel + the 8px gutter the column owns before the main container.
    expect((container.firstElementChild as HTMLElement).style.width).toBe('308px')
    expect(container.firstElementChild).toHaveClass('pr-2')
    const separator = screen.getByRole('separator', { name: 'Resize side panel' })
    expect(separator).toHaveAttribute('aria-valuenow', '300')
    // The handle covers the gutter, ending on the main container's border.
    expect(separator).toHaveClass('right-0', 'w-2')
    expect(separator.parentElement).toBe(container.firstElementChild)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(316)
  })

  describe('top row', () => {
    const roles: TopRowRoles = {
      topEdgeLeafIds: new Set(),
      rightmostLeafId: null,
      leftmostLeafId: null,
      controlsOwner: 'pane',
      showPanelOwner: 'pane'
    }
    const web: TopRowPlatform = { dragRegions: false, windowControls: false, trafficLights: false }
    const desktop: TopRowPlatform = {
      dragRegions: true,
      windowControls: true,
      trafficLights: false
    }
    const mac: TopRowPlatform = { dragRegions: true, windowControls: false, trafficLights: true }

    const renderOn = (platform: TopRowPlatform | null) => {
      const panel = (
        <MemoryRouter>
          <SidePanelColumn activeProject={makeProject()} />
        </MemoryRouter>
      )
      return render(
        platform ? (
          <TopRowProvider roles={roles} platform={platform}>
            {panel}
          </TopRowProvider>
        ) : (
          panel
        )
      )
    }
    const header = (): HTMLElement =>
      screen.getByTestId('workspace-switcher').parentElement as HTMLElement

    it('is not a drag region on web or without a provider', () => {
      const { unmount } = renderOn(web)
      expect(document.querySelector('[data-tauri-drag-region]')).toBeNull()
      unmount()

      renderOn(null)
      expect(document.querySelector('[data-tauri-drag-region]')).toBeNull()
    })

    it('marks the header root on desktop, never the switcher or the New chat button', () => {
      renderOn(desktop)
      const switcher = screen.getByTestId('workspace-switcher')
      expect(header()).toHaveAttribute('data-tauri-drag-region')
      expect(switcher).not.toHaveAttribute('data-tauri-drag-region')
      expect(screen.getByRole('button', { name: 'New chat' })).not.toHaveAttribute(
        'data-tauri-drag-region'
      )
      expect(document.querySelectorAll('[data-tauri-drag-region]')).toHaveLength(1)
    })

    it('stays a drag region in both Rail states', () => {
      useShellLayoutStore.setState({ railExpanded: false })
      renderOn(desktop)
      expect(header()).toHaveAttribute('data-tauri-drag-region')
    })

    it('adds the traffic-light inset only with the Rail collapsed on macOS', () => {
      useShellLayoutStore.setState({ railExpanded: false })
      const collapsedMac = renderOn(mac)
      expect(header().style.paddingLeft).toBe('24px')
      collapsedMac.unmount()

      renderOn(desktop)
      expect(header().style.paddingLeft).toBe('')
    })

    it('adds no inset with the Rail expanded, even on macOS', () => {
      renderOn(mac)
      expect(header().style.paddingLeft).toBe('')
    })

    it('hides the Column tabs while the Rail is collapsed and labels the tabpanel by name', () => {
      useShellLayoutStore.setState({ railExpanded: false })
      renderOn(null)
      expect(screen.queryByRole('tablist')).toBeNull()
      const panel = screen.getByRole('tabpanel')
      expect(panel).toHaveAttribute('aria-label', 'Chats')
      expect(panel).not.toHaveAttribute('aria-labelledby')

      act(() => useShellLayoutStore.getState().setLastColumnTab('p1', 'changes'))
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-label', 'Changes')
    })

    it('keeps aria-labelledby on the tabpanel while the Rail is expanded', () => {
      renderOn(null)
      const panel = screen.getByRole('tabpanel')
      expect(panel).toHaveAttribute('aria-labelledby', 'side-panel-tab-chats')
      expect(panel).not.toHaveAttribute('aria-label')
    })
  })
})
