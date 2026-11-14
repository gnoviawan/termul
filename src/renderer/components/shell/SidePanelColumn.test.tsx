import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import type { TopRowPlatform, TopRowRoles } from '@/lib/top-row'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import { SidePanelColumn } from './SidePanelColumn'
import { TopRowProvider } from './top-row-context'

vi.mock('@/components/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="file-explorer" />
}))

vi.mock('@/components/github/GithubPanel', () => ({
  GithubPanel: ({ cwd, projectId }: { cwd: string; projectId: string }) => (
    <div data-testid="github-panel" data-cwd={cwd} data-project={projectId} />
  )
}))

vi.mock('./ChangesPanel', () => ({
  ChangesPanel: ({ cwd }: { cwd: string }) => <div data-testid="changes-panel" data-cwd={cwd} />
}))

const updatePanelVisibility = vi.fn(() => Promise.resolve())

const makeProject = (overrides: Partial<Project> = {}): Project =>
  ({
    id: 'p1',
    name: 'One',
    path: '/repo',
    color: 'blue',
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

beforeEach(() => {
  vi.clearAllMocks()
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'ready', sidePanelVisible: true })
  vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
})

describe('SidePanelColumn', () => {
  it('shows Explorer by default, with no tab track and no Workspace switcher', async () => {
    render(<SidePanelColumn activeProject={makeProject()} />)
    expect(await screen.findByTestId('file-explorer')).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
  })

  it('renders the view the strip picked, under its 44px Paper header', async () => {
    useShellLayoutStore.setState({ lastColumnTabByProject: { p1: 'github' } })
    render(<SidePanelColumn activeProject={makeProject()} />)
    const header = screen.getByTestId('side-panel-header')
    expect(header).toHaveClass('h-11', 'border-b-[0.5px]', 'border-border', 'pl-3', 'pr-2')
    expect(within(header).getByRole('heading', { name: 'GitHub' })).toHaveClass(
      'text-2xs',
      'font-medium',
      'text-foreground'
    )
    expect(await screen.findByTestId('github-panel')).toHaveAttribute('data-cwd', '/repo')
  })

  it('renders the Changes panel for the picked working copy', () => {
    useShellLayoutStore.setState({
      lastColumnTabByProject: { p1: 'changes' },
      worktreePickByProject: { p1: '/repo/.termul/worktrees/feature' }
    })
    render(<SidePanelColumn activeProject={makeProject()} />)
    expect(screen.getByRole('heading', { name: 'Changes' })).toBeInTheDocument()
    expect(screen.getByTestId('changes-panel')).toHaveAttribute(
      'data-cwd',
      '/repo/.termul/worktrees/feature'
    )
  })

  it('closes the panel from the header Close button', () => {
    useShellLayoutStore.setState({ lastColumnTabByProject: { p1: 'changes' } })
    render(<SidePanelColumn activeProject={makeProject()} />)
    const close = screen.getByRole('button', { name: 'Close panel' })
    expect(close.getAttribute('title')).toMatch(/^Close panel \(.*B\)$/)
    fireEvent.click(close)
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', false)
  })

  describe('top row', () => {
    const roles: TopRowRoles = {
      topEdgeLeafIds: new Set(),
      rightmostLeafId: null,
      leftmostLeafId: null,
      controlsOwner: 'pane',
      showPanelOwner: 'pane'
    }
    const renderWith = (platform: TopRowPlatform) => {
      useShellLayoutStore.setState({ lastColumnTabByProject: { p1: 'changes' } })
      render(
        <TopRowProvider roles={roles} platform={platform}>
          <SidePanelColumn activeProject={makeProject()} />
        </TopRowProvider>
      )
      return screen.getByTestId('side-panel-header')
    }

    it('marks the header as a drag region on desktop, never the Close button', () => {
      const header = renderWith({ dragRegions: true, windowControls: false, trafficLights: true })
      expect(header).toHaveAttribute('data-tauri-drag-region')
      expect(screen.getByRole('button', { name: 'Close panel' })).not.toHaveAttribute(
        'data-tauri-drag-region'
      )
    })

    it('has no drag region on web', () => {
      const header = renderWith({ dragRegions: false, windowControls: false, trafficLights: false })
      expect(header).not.toHaveAttribute('data-tauri-drag-region')
    })
  })
})
