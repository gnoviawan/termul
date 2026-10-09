import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { LeafNode, SplitNode } from '@/types/workspace.types'

// Prop-wiring coverage: renders the REAL WorkspaceTabBar inside the real
// PaneContent so a dropped `onCloseTabs` hop can't ship silently — the bulk
// menu item is clicked in the actual component tree and the target list must
// arrive at the PaneContent-level callback.
//
// The store/context-menu mocks mirror WorkspaceTabBar.test.tsx; PaneContent's
// lazy pane bodies are stubbed out (they are not under test here).

const mockSetActiveTab = vi.fn()
const mockSetActivePane = vi.fn()
const mockRemoveTab = vi.fn()
const mockCloseTab = vi.fn()
const mockTogglePaneFullscreen = vi.fn()

const mockWorkspaceStoreState = {
  root: { type: 'leaf', id: 'pane-1', tabs: [] as WorkspaceTab[], activeTabId: null },
  activePaneId: 'pane-1',
  fullscreenPaneId: null as string | null,
  agentLauncherPaneId: null as string | null,
  setActiveTab: mockSetActiveTab,
  setActivePane: mockSetActivePane,
  togglePaneFullscreen: mockTogglePaneFullscreen,
  closeTab: mockCloseTab,
  removeTab: mockRemoveTab,
  hideAgentLauncher: vi.fn(),
  updatePaneSizes: vi.fn()
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
  useLeafCount: () => 1,
  editorTabId: (filePath: string) => `edit-${filePath}`,
  getAllLeafPanes: () => [{ type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }]
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: vi.fn((selector: (s: { activeProjectId: string }) => unknown) =>
    selector({ activeProjectId: 'proj-1' })
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(
    vi.fn((selector: (s: { terminals: never[] }) => unknown) => selector({ terminals: [] })),
    { getState: () => ({ terminals: [] }) }
  ),
  useTerminalActions: vi.fn(() => ({ setTerminalPtyId: vi.fn() }))
}))

const mockEditorOpenFiles = new Map<string, { isDirty: boolean; operationStatus?: string }>()

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(
    vi.fn((selector: (state: { openFiles: typeof mockEditorOpenFiles }) => unknown) =>
      selector({ openFiles: mockEditorOpenFiles })
    ),
    {
      getState: () => ({ openFiles: mockEditorOpenFiles, closeFileIfIdle: vi.fn(() => true) })
    }
  )
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: Object.assign(
    vi.fn((selector: (state: { getTab: (id: string) => null }) => unknown) =>
      selector({ getTab: () => null })
    ),
    { getState: () => ({ removeTab: vi.fn() }) }
  )
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      sessions: {},
      agentStatus: {},
      launchingSessionIds: {},
      pendingPermissions: {},
      pendingQuestions: {},
      pendingElicitations: {}
    })
  ),
  isEphemeralAcpSession: () => false,
  useAgentIdentity: () => ({ name: 'Claude' }),
  useAgentTemplateId: () => null,
  useAgentIcon: () => null,
  useSessionIndexTitle: () => 'Chat 1'
}))

vi.mock('@/stores/agent-chat-lifetime-store', () => ({
  useAgentChatLifetimeStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ closingSessionIds: {} })
  )
}))

vi.mock('@/stores/git-status-store', async (importOriginal) => ({
  selectChangedFileCount: (await importOriginal<typeof import('@/stores/git-status-store')>())
    .selectChangedFileCount,
  useGitStatusStore: vi.fn((selector: (state: unknown) => unknown) => selector({ statuses: {} }))
}))

vi.mock('@/hooks/use-agent-idle-shutdown', () => ({
  requestCloseAgentChat: vi.fn((_sessionId: string, closeTab: () => void) => closeTab())
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    shellApi: {
      getAvailableShells: vi.fn().mockResolvedValue({
        success: true,
        data: { default: null, available: [] }
      })
    },
    clipboardApi: {
      writeText: vi.fn()
    }
  }
})

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({
    isDragging: false,
    previewTarget: null,
    startTabDrag: vi.fn(),
    dragPayload: null,
    reorderPreview: null,
    setReorderPreview: vi.fn(),
    clearReorderPreview: vi.fn(),
    handleTabReorder: vi.fn()
  })
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => false
}))

// PaneContent's lazy panels + overlays — not under test here.
vi.mock('@/components/terminal/ConnectedTerminal', () => ({
  ConnectedTerminal: () => null
}))
vi.mock('@/components/editor/EditorPanel', () => ({
  EditorPanel: () => null
}))
vi.mock('@/components/browser/BrowserPanel', () => ({
  BrowserPanel: () => null
}))
vi.mock('@/components/git/GitPanel', () => ({
  GitPanel: () => null
}))
vi.mock('@/components/git/GitHistoryPanel', () => ({
  GitHistoryPanel: () => null
}))
vi.mock('@/components/chat/AgentChatPanel', () => ({
  AgentChatPanel: () => null
}))
vi.mock('@/components/agents/AgentLauncher', () => ({
  AgentLauncher: () => null
}))
vi.mock('@/components/agents/AgentIcon', () => ({
  AgentIcon: () => <span data-testid="agent-icon-stub" />
}))
vi.mock('@/components/workspace/DropZoneOverlay', () => ({
  DropZoneOverlay: () => null
}))

// Same stateful stub as WorkspaceTabBar.test.tsx: opens the menu on
// `contextmenu`, renders items as clickable divs (onSelect → click).
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  const ContextMenu = ({ children }: { children: React.ReactNode }) => {
    const [open, setOpen] = React.useState(false)
    React.useEffect(() => {
      if (!open) return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [open])
    return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
  }
  const ContextMenuTrigger = ({
    children,
    asChild
  }: {
    children: React.ReactNode
    asChild?: boolean
  }) => {
    const { setOpen } = React.useContext(MenuCtx)
    const merged = (e: React.MouseEvent) => {
      if (e.defaultPrevented) return
      e.preventDefault()
      setOpen(true)
    }
    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{
        onContextMenu?: (e: React.MouseEvent) => void
      }>
      return React.cloneElement(child, {
        onContextMenu: (e: React.MouseEvent) => {
          child.props.onContextMenu?.(e)
          merged(e)
        }
      })
    }
    return <div onContextMenu={merged}>{children}</div>
  }
  const ContextMenuContent = ({
    children,
    className
  }: {
    children: React.ReactNode
    className?: string
  }) => {
    const { open } = React.useContext(MenuCtx)
    if (!open) return null
    return (
      <div role="menu" className={className}>
        {children}
      </div>
    )
  }
  const ContextMenuItem = ({
    children,
    disabled,
    onSelect,
    variant
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: () => void
    variant?: 'default' | 'destructive'
  }) => (
    <div
      role="menuitem"
      data-disabled={disabled ? '' : undefined}
      data-variant={variant}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
    >
      {children}
    </div>
  )
  const ContextMenuSeparator = () => <hr />
  return {
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator
  }
})

import { PaneContent } from './PaneContent'
import { PaneRenderer } from './PaneRenderer'

describe('PaneContent → WorkspaceTabBar onCloseTabs wiring', () => {
  const gitTab1: WorkspaceTab = { type: 'git', id: 'git-1', cwd: '/repo' }
  const gitTab2: WorkspaceTab = { type: 'git', id: 'git-2', cwd: '/repo' }
  const gitPane: LeafNode = {
    type: 'leaf',
    id: 'pane-1',
    activeTabId: 'git-1',
    tabs: [gitTab1, gitTab2]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockEditorOpenFiles.clear()
    mockWorkspaceStoreState.fullscreenPaneId = null
  })

  it('delivers the exact bulk target list to the PaneContent onCloseTabs prop', async () => {
    const onCloseTabs = vi.fn()
    render(<PaneContent pane={gitPane} onCloseTabs={onCloseTabs} />)

    const tabEl = screen.getAllByText('Git Changes')[0].closest('[role="tab"]') as HTMLElement
    expect(tabEl).toBeTruthy()
    fireEvent.contextMenu(tabEl)

    fireEvent.click(await screen.findByText('Close All Git Tabs'))

    expect(onCloseTabs).toHaveBeenCalledTimes(1)
    expect(onCloseTabs).toHaveBeenCalledWith([gitTab1, gitTab2])
  })

  it('delivers pane-scoped other-tabs targets through the same prop', async () => {
    const onCloseTabs = vi.fn()
    render(<PaneContent pane={gitPane} onCloseTabs={onCloseTabs} />)

    const tabEl = screen.getAllByText('Git Changes')[0].closest('[role="tab"]') as HTMLElement
    fireEvent.contextMenu(tabEl)

    fireEvent.click(await screen.findByText('Close Other Tabs'))

    expect(onCloseTabs).toHaveBeenCalledTimes(1)
    expect(onCloseTabs).toHaveBeenCalledWith([gitTab2])
  })

  // Regression for the split-root prop drop: when the workspace root is a
  // split, PaneRenderer → PaneSplitRenderer must still forward onCloseTabs,
  // or every multi-pane layout degrades to the single-slot per-tab fallback.
  it('forwards onCloseTabs through a split root via PaneRenderer', async () => {
    const otherLeaf: LeafNode = {
      type: 'leaf',
      id: 'pane-2',
      activeTabId: null,
      tabs: []
    }
    const splitRoot: SplitNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [gitPane, otherLeaf],
      sizes: [50, 50]
    }
    const onCloseTabs = vi.fn()
    render(<PaneRenderer node={splitRoot} onCloseTabs={onCloseTabs} />)

    const tabEl = screen.getAllByText('Git Changes')[0].closest('[role="tab"]') as HTMLElement
    expect(tabEl).toBeTruthy()
    fireEvent.contextMenu(tabEl)

    fireEvent.click(await screen.findByText('Close All Git Tabs'))

    expect(onCloseTabs).toHaveBeenCalledTimes(1)
    expect(onCloseTabs).toHaveBeenCalledWith([gitTab1, gitTab2])
  })
})
