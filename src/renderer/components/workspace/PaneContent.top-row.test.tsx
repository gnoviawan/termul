import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TopRowProvider } from '@/components/shell/top-row-context'
import type { TopRowPlatform, TopRowRoles } from '@/lib/top-row'
import type { LeafNode } from '@/types/workspace.types'

// Flagged shell: the Launcher overlay on a top-edge pane starts below the top
// row (tabs, drag space, window controls stay uncovered); a lower pane and the
// classic shell keep the full-pane overlay.

const { storeState } = vi.hoisted(() => ({
  storeState: {
    root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
    activePaneId: 'pane-1',
    fullscreenPaneId: null as string | null,
    agentLauncherPaneId: 'pane-1' as string | null,
    setActivePane: vi.fn(),
    hideAgentLauncher: vi.fn()
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (s: typeof storeState) => unknown) => selector(storeState)),
    { getState: () => storeState }
  ),
  getAllLeafPanes: () => [{ id: 'pane-1' }]
}))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: vi.fn((selector: (s: { activeProjectId: string }) => unknown) =>
    selector({ activeProjectId: 'proj-1' })
  )
}))
vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector: (s: { terminals: never[] }) => unknown) =>
    selector({ terminals: [] })
  ),
  useTerminalActions: vi.fn(() => ({ setTerminalPtyId: vi.fn() }))
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => false }))
vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({ isDragging: false, previewTarget: null })
}))
vi.mock('@/components/workspace/WorkspaceTabBar', () => ({
  WorkspaceTabBar: ({
    topRow,
    leading
  }: {
    topRow?: { dragRegion: boolean; windowControls: boolean }
    leading?: React.ReactNode
  }) => (
    <div
      data-testid="tabbar-stub"
      data-top-row={topRow ? `${topRow.dragRegion}/${topRow.windowControls}` : 'none'}
      data-leading={leading ? 'show-side-panel-slot' : 'none'}
    />
  )
}))
vi.mock('@/components/workspace/DropZoneOverlay', () => ({ DropZoneOverlay: () => null }))
vi.mock('@/components/agents/AgentIcon', () => ({ AgentIcon: () => null }))
vi.mock('@/components/agents/AgentLauncher', () => ({
  AgentLauncher: () => <div data-testid="launcher-root" />
}))

import { PaneContent } from './PaneContent'

const pane: LeafNode = {
  type: 'leaf',
  id: 'pane-1',
  activeTabId: 'git-1',
  tabs: [{ type: 'git', id: 'git-1', cwd: '/repo' }]
}

const desktop: TopRowPlatform = { dragRegions: true, windowControls: true, trafficLights: false }

function roles(
  topEdge: string[],
  rightmost: string | null,
  leftmost: string | null = topEdge[0] ?? null
): TopRowRoles {
  return {
    topEdgeLeafIds: new Set(topEdge),
    rightmostLeafId: rightmost,
    leftmostLeafId: leftmost,
    controlsOwner: 'pane',
    showPanelOwner: 'pane'
  }
}

const overlay = (): HTMLElement => screen.getByRole('dialog', { name: 'Agent launcher' })

beforeEach(() => {
  vi.clearAllMocks()
  storeState.agentLauncherPaneId = 'pane-1'
})

describe('PaneContent top row', () => {
  it('starts the overlay below the 40px top row on a top-edge pane', () => {
    render(
      <TopRowProvider roles={roles(['pane-1'], 'pane-1')} platform={desktop}>
        <PaneContent pane={pane} />
      </TopRowProvider>
    )
    expect(overlay()).toHaveClass('inset-x-0', 'bottom-0', 'top-10')
    expect(overlay()).not.toHaveClass('inset-0')
  })

  it('covers a lower pane, including its tab bar, as today', () => {
    render(
      <TopRowProvider roles={roles(['other'], 'other')} platform={desktop}>
        <PaneContent pane={pane} />
      </TopRowProvider>
    )
    expect(overlay()).toHaveClass('inset-0')
    expect(overlay()).not.toHaveClass('top-10')
  })

  it('keeps the full-pane overlay in the classic shell (no provider)', () => {
    render(<PaneContent pane={pane} />)
    expect(overlay()).toHaveClass('inset-0')
    expect(overlay()).not.toHaveClass('top-10')
  })

  it('hands the tab bar its role, and nothing without a provider', () => {
    const { unmount } = render(
      <TopRowProvider roles={roles(['pane-1'], 'pane-1')} platform={desktop}>
        <PaneContent pane={pane} />
      </TopRowProvider>
    )
    expect(screen.getByTestId('tabbar-stub')).toHaveAttribute('data-top-row', 'true/true')
    unmount()

    render(
      <TopRowProvider roles={roles(['pane-1', 'pane-2'], 'pane-2')} platform={desktop}>
        <PaneContent pane={pane} />
      </TopRowProvider>
    )
    expect(screen.getByTestId('tabbar-stub')).toHaveAttribute('data-top-row', 'true/false')
  })

  it('passes no topRow to the tab bar in the classic shell', () => {
    render(<PaneContent pane={pane} />)
    expect(screen.getByTestId('tabbar-stub')).toHaveAttribute('data-top-row', 'none')
  })

  it('gives only the leftmost top-edge pane the Show side panel slot', () => {
    const { unmount } = render(
      <TopRowProvider roles={roles(['pane-1', 'pane-2'], 'pane-2')} platform={desktop}>
        <PaneContent pane={pane} />
      </TopRowProvider>
    )
    expect(screen.getByTestId('tabbar-stub')).toHaveAttribute(
      'data-leading',
      'show-side-panel-slot'
    )
    unmount()

    const { unmount: unmount2 } = render(
      <TopRowProvider roles={roles(['pane-0', 'pane-1'], 'pane-1')} platform={desktop}>
        <PaneContent pane={pane} />
      </TopRowProvider>
    )
    expect(screen.getByTestId('tabbar-stub')).toHaveAttribute('data-leading', 'none')
    unmount2()

    render(<PaneContent pane={pane} />)
    expect(screen.getByTestId('tabbar-stub')).toHaveAttribute('data-leading', 'none')
  })
})
