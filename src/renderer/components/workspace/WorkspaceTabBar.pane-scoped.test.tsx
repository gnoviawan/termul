import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore } from '@/stores/terminal-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import { WorkspaceTabBar } from './WorkspaceTabBar'

const mockWorkspaceStoreState = {
  fullscreenPaneId: null as string | null,
  setActiveTab: vi.fn(),
  setActivePane: vi.fn(),
  togglePaneFullscreen: vi.fn(),
  reorderTabsInPane: vi.fn(),
  closeTab: vi.fn()
}

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((selector: (state: typeof mockWorkspaceStoreState) => unknown) =>
      selector(mockWorkspaceStoreState)
    ),
    {
      getState: () => mockWorkspaceStoreState
    }
  ),
  useFullscreenPaneId: () => mockWorkspaceStoreState.fullscreenPaneId,
  useLeafCount: () => 3,
  editorTabId: (filePath: string) => `edit-${filePath}`
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(vi.fn(), {
    getState: () => ({})
  })
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: Object.assign(vi.fn(), {
    getState: () => ({})
  })
}))

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({
    startTabDrag: vi.fn(),
    dragPayload: null,
    reorderPreview: null,
    setReorderPreview: vi.fn(),
    clearReorderPreview: vi.fn(),
    handleTabReorder: vi.fn()
  })
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    shellApi: {
      getAvailableShells: vi.fn().mockResolvedValue({
        success: true,
        data: {
          default: { name: 'bash', displayName: 'Bash', path: '/bin/bash' },
          available: [{ name: 'bash', displayName: 'Bash', path: '/bin/bash' }]
        }
      })
    },
    clipboardApi: {
      writeText: vi.fn()
    }
  }
})

// Minimal stub of the Radix context-menu primitives the tab wrappers use.
vi.mock('@/components/ui/context-menu', () => {
  const ContextMenu = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const ContextMenuTrigger = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const ContextMenuContent = () => null
  const ContextMenuItem = () => null
  const ContextMenuSeparator = () => null
  return {
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator
  }
})

const tabs: WorkspaceTab[] = [
  { type: 'terminal', id: 'tab-1', terminalId: 'term-1' },
  { type: 'terminal', id: 'tab-2', terminalId: 'term-2' }
]

function seedTerminal(id: string, name: string): void {
  useTerminalStore.setState((s) => ({
    terminals: [
      ...s.terminals,
      {
        id,
        name,
        projectId: 'p-test',
        ptyId: `pty-${id}`,
        shell: 'bash',
        kind: 'standard',
        status: 'connected',
        rendererAttachmentCount: 0,
        output: [],
        createdAt: 1
      }
    ]
  }))
}

describe('WorkspaceTabBar pane-scoped terminal subscription (multi-project perf)', () => {
  beforeEach(() => {
    mockWorkspaceStoreState.fullscreenPaneId = null
    mockWorkspaceStoreState.setActiveTab.mockReset()
    mockWorkspaceStoreState.setActivePane.mockReset()
    useTerminalStore.setState({ terminals: [] })
    seedTerminal('term-1', 'Terminal 1')
    seedTerminal('term-2', 'Terminal 2')
    seedTerminal('term-other', 'Other Project Terminal')
  })

  it('renders the pane own terminal tabs', async () => {
    render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
    expect(screen.getByText('Terminal 2')).toBeInTheDocument()
    expect(screen.queryByText('Other Project Terminal')).not.toBeInTheDocument()
  })

  it('shows git-status churn from a pane terminal without stale rows (subscription stays live)', async () => {
    render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />)
    await act(async () => {
      await Promise.resolve()
    })

    // Background git-status churn touches the pane's own terminal record —
    // the pane-scoped subscription must still deliver it (mutation of a
    // pane-owned terminal → new record → shallow compare differs → render).
    act(() => {
      useTerminalStore.getState().renameTerminal('term-2', 'Renamed 2')
    })

    expect(screen.getByText('Renamed 2')).toBeInTheDocument()
    expect(screen.queryByText('Terminal 2')).not.toBeInTheDocument()
  })

  it('fires onSelect through setActiveTab when a pane terminal tab is clicked', async () => {
    render(<WorkspaceTabBar paneId="pane-a" tabs={tabs} activeTabId="tab-1" />)
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(screen.getByText('Terminal 2'))
    expect(mockWorkspaceStoreState.setActiveTab).toHaveBeenCalledWith('pane-a', 'tab-2')
  })

  it('renders a terminal tab that gains its record after the bar mounted', async () => {
    // Terminal not yet in the store when the bar first renders (e.g. PTY
    // attach lands late). The pane-scoped subscription must pick it up.
    const lateTabs: WorkspaceTab[] = [
      { type: 'terminal', id: 'tab-3', terminalId: 'term-late' },
      ...tabs
    ]
    const { rerender } = render(
      <WorkspaceTabBar paneId="pane-a" tabs={lateTabs} activeTabId="tab-1" />
    )
    await act(async () => {
      await Promise.resolve()
    })
    // Late arrival: create the terminal record now.
    act(() => {
      seedTerminal('term-late', 'Late Terminal')
      rerender(<WorkspaceTabBar paneId="pane-a" tabs={lateTabs} activeTabId="tab-1" />)
    })
    expect(screen.getByText('Late Terminal')).toBeInTheDocument()
  })
})
