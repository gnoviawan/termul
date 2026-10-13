import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TopRowProvider } from '@/components/shell/top-row-context'
import type { TopRowMode, TopRowPlatform } from '@/lib/top-row'
import { selectTopRowRoles } from '@/lib/top-row'
import type { PaneNode } from '@/types/workspace.types'
import { WorkspaceMain } from './WorkspaceMain'

vi.mock('@/components/ssh/SSHWorkspace', () => ({
  SSHWorkspace: ({ topRow }: { topRow?: { dragRegion: boolean; windowControls: boolean } }) => (
    <div
      data-testid="ssh-workspace"
      data-top-row={topRow ? `${topRow.dragRegion}/${topRow.windowControls}` : 'none'}
    />
  )
}))
vi.mock('@/components/ChatRoute', () => ({ ChatRoute: () => null }))
vi.mock('@/components/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@/components/workspace/PaneRenderer', () => ({
  PaneRenderer: () => <div data-testid="pane-renderer" />
}))
vi.mock('@/hooks/use-mobile-active-leaf', () => ({ useMobileActiveLeaf: () => null }))
vi.mock('@/stores/app-settings-store', () => ({ useDefaultShell: () => 'bash' }))
vi.mock('@/stores/terminal-store', () => ({
  useTerminalActions: () => ({ renameTerminal: vi.fn() })
}))

const root: PaneNode = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
const desktop: TopRowPlatform = { dragRegions: true, windowControls: true, trafficLights: false }

function renderMain(mode: TopRowMode | null, platform: TopRowPlatform = desktop) {
  const main = (
    <WorkspaceMain
      isMobileWebShell={false}
      isWorkspaceRoute
      projects={[{ id: 'p1', name: 'One' } as never]}
      activeProject={undefined}
      ssh={
        {
          workspaceOpen: true
        } as never
      }
      setIsNewProjectModalOpen={vi.fn()}
      handleAddTerminal={vi.fn()}
      handleNewBrowserTab={vi.fn()}
      handleCloseTerminal={vi.fn()}
      handleCloseEditorTab={vi.fn()}
      handleCloseTabs={vi.fn()}
      closingTerminalIds={[]}
    />
  )
  if (!mode) return render(main)
  return render(
    <TopRowProvider
      roles={selectTopRowRoles({ root, fullscreenPaneId: null, mode })}
      platform={platform}
    >
      {main}
    </TopRowProvider>
  )
}

describe('WorkspaceMain SSH header role', () => {
  it('passes no topRow without a provider (classic and mobile shells)', async () => {
    renderMain(null)
    expect(await screen.findByTestId('ssh-workspace')).toHaveAttribute('data-top-row', 'none')
  })

  it('hands the SSH header the drag region and controls when it owns the top row', async () => {
    renderMain('ssh')
    expect(await screen.findByTestId('ssh-workspace')).toHaveAttribute('data-top-row', 'true/true')
  })

  it('hands it no controls on macOS and nothing on web', async () => {
    const { unmount } = renderMain('ssh', {
      dragRegions: true,
      windowControls: false,
      trafficLights: true
    })
    expect(await screen.findByTestId('ssh-workspace')).toHaveAttribute('data-top-row', 'true/false')
    unmount()

    renderMain('ssh', { dragRegions: false, windowControls: false, trafficLights: false })
    expect(await screen.findByTestId('ssh-workspace')).toHaveAttribute(
      'data-top-row',
      'false/false'
    )
  })

  it('passes no topRow when another surface owns the controls', async () => {
    renderMain('panes')
    expect(await screen.findByTestId('ssh-workspace')).toHaveAttribute('data-top-row', 'none')
  })
})
