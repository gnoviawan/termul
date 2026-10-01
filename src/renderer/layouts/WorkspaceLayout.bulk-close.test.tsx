import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as connectionStatusStoreModule from '@/stores/connection-status-store'
import type { WorkspaceTab } from '@/stores/workspace-store'
import WorkspaceLayout from './WorkspaceLayout'

// Aggregate bulk-close suite: PaneRenderer is stubbed so the test can invoke
// the `onCloseTabs` prop WorkspaceLayout hands to WorkspaceTabBar, then assert
// the single aggregate ConfirmDialog + per-primitive dispatch.
const {
  activeProject,
  mockProjectActions,
  mockTerminalActions,
  mockEditorStoreState,
  mockTerminalStoreState,
  mockWorkspaceStoreState,
  mockFileExplorerStoreState,
  mockBrowserSessionState,
  mockCloseRequested,
  mockRespondToClose,
  mockFlushPendingWrites,
  mockWatchDirectory,
  mockUnwatchDirectory,
  mockKeyboardOnShortcut,
  mockUpdatePanelVisibility,
  mockWaitForPendingAppSettingsPersistence,
  mockWaitForPendingSessionIndexWrite,
  mockFlushSessionHistory,
  mockToastError,
  mockListen,
  mockRequestCloseAgentChat,
  mockLogFrontendError,
  mockTerminalKill,
  confirmTerminalCloseRef,
  paneRendererPropsRef,
  mockWireConnectionStatusTracking
} = vi.hoisted(() => ({
  mockWireConnectionStatusTracking: vi.fn(),
  activeProject: {
    id: 'project-1',
    name: 'Project 1',
    color: 'blue',
    path: '/test/project',
    gitBranch: 'main',
    isActive: true
  },
  mockProjectActions: {
    selectProject: vi.fn(),
    addProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    reorderProjects: vi.fn()
  },
  mockTerminalActions: {
    addTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    renameTerminal: vi.fn()
  },
  mockEditorStoreState: {
    activeFilePath: null,
    openFiles: new Map<string, { isDirty: boolean; operationStatus?: string }>(),
    getDirtyFileCount: vi.fn(() => 0),
    saveAllDirty: vi.fn(async () => undefined),
    saveFile: vi.fn(async (_filePath: string) => true),
    closeFileIfIdle: vi.fn((_filePath: string) => true),
    closeFile: vi.fn(),
    setActiveFilePath: vi.fn()
  },
  mockTerminalStoreState: {
    activeTerminalId: '',
    terminals: [] as Array<{ id: string; ptyId?: string; projectId?: string; name?: string }>,
    selectTerminal: vi.fn(),
    setTerminalPtyId: vi.fn()
  },
  mockWorkspaceStoreState: {
    activePaneId: 'pane-root',
    agentLauncherPaneId: null as string | null,
    root: {
      type: 'leaf' as const,
      id: 'pane-root',
      tabs: [] as WorkspaceTab[],
      activeTabId: null as string | null
    },
    syncTerminalTabs: vi.fn(),
    getNextTabId: vi.fn(() => null),
    addTabToPane: vi.fn(),
    setActiveTab: vi.fn(),
    setActivePane: vi.fn(),
    closeTab: vi.fn(),
    removeTab: vi.fn()
  },
  mockFileExplorerStoreState: {
    setRootPath: vi.fn(),
    setRootLoadError: vi.fn(),
    toggleVisibility: vi.fn()
  },
  mockBrowserSessionState: {
    removeTab: vi.fn(),
    getTab: vi.fn(() => null)
  },
  mockCloseRequested: vi.fn(() => vi.fn()),
  mockRespondToClose: vi.fn(),
  mockFlushPendingWrites: vi.fn(async () => ({ success: true, data: undefined })),
  mockWatchDirectory: vi.fn(async () => ({ success: true })),
  mockUnwatchDirectory: vi.fn(async () => ({ success: true })),
  mockKeyboardOnShortcut: vi.fn(() => vi.fn()),
  mockUpdatePanelVisibility: vi.fn(async () => undefined),
  mockWaitForPendingAppSettingsPersistence: vi.fn(async () => undefined),
  mockWaitForPendingSessionIndexWrite: vi.fn(async () => undefined),
  mockFlushSessionHistory: vi.fn(async () => undefined),
  mockToastError: vi.fn(),
  mockListen: vi.fn(async () => vi.fn()),
  mockRequestCloseAgentChat: vi.fn((_sessionId: string, closeTab: () => void) => closeTab()),
  mockLogFrontendError: vi.fn(async () => undefined),
  mockTerminalKill: vi.fn(async () => ({ success: true })),
  confirmTerminalCloseRef: { current: true },
  paneRendererPropsRef: {
    current: null as null | {
      onCloseTabs?: (tabs: WorkspaceTab[]) => void
      onCloseTerminal?: (id: string, tabId: string) => void
    }
  }
}))

vi.mock('@/stores/connection-status-store', async (importOriginal) => {
  const actual = await importOriginal<typeof connectionStatusStoreModule>()
  return { ...actual, wireConnectionStatusTracking: mockWireConnectionStatusTracking }
})

vi.mock('@/stores/project-store', () => ({
  useProjectsLoaded: () => true,
  useProjects: () => [activeProject],
  useActiveProject: () => activeProject,
  useActiveProjectId: () => activeProject.id,
  useProjectActions: () => mockProjectActions,
  useProjectStore: Object.assign(
    (selector?: (s: unknown) => unknown) =>
      selector
        ? selector({
            projects: [activeProject],
            activeProjectId: activeProject.id,
            isLoaded: true,
            isWorktreeOperationLocked: false
          })
        : {
            projects: [activeProject],
            activeProjectId: activeProject.id,
            isLoaded: true,
            isWorktreeOperationLocked: false
          },
    {
      getState: () => ({
        projects: [activeProject],
        activeProjectId: activeProject.id,
        isLoaded: true,
        isWorktreeOperationLocked: false
      })
    }
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => mockTerminalStoreState
  },
  useTerminals: () => [],
  useActiveTerminal: () => null,
  useActiveTerminalId: () => '',
  useTerminalActions: () => mockTerminalActions
}))

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorerVisible: () => false,
  useFileExplorerStore: {
    getState: () => mockFileExplorerStoreState
  }
}))

vi.mock('@/stores/sidebar-store', () => ({
  useSidebarVisible: () => false
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: () => mockEditorStoreState
  }
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: Object.assign(
    (selector?: (s: unknown) => unknown) => (selector ? selector(mockBrowserSessionState) : {}),
    {
      getState: () => mockBrowserSessionState
    }
  )
}))

vi.mock('@/stores/workspace-store', () => {
  const useWorkspaceStore = (selector?: (s: typeof mockWorkspaceStoreState) => unknown) =>
    selector ? selector(mockWorkspaceStoreState) : mockWorkspaceStoreState
  useWorkspaceStore.getState = () => mockWorkspaceStoreState
  useWorkspaceStore.subscribe = () => vi.fn()
  return {
    useWorkspaceStore,
    useActiveTab: () => undefined,
    useFullscreenPaneId: () => null,
    useLeafCount: () => 1,
    usePaneRoot: () => mockWorkspaceStoreState.root,
    editorTabId: (filePath: string) => `edit-${filePath}`,
    getActiveTerminalIdFromTree: () => null,
    getActiveFilePathFromTree: () => null,
    findPaneById: (root: { id: string }, paneId: string) => (root?.id === paneId ? root : null),
    findPaneContainingTab: (_root: unknown, tabId: string) => {
      const tabs = mockWorkspaceStoreState.root.tabs
      return tabs.some((t) => t.id === tabId)
        ? { type: 'leaf', id: 'pane-root', tabs, activeTabId: null }
        : null
    }
  }
})

vi.mock('@/stores/keyboard-shortcuts-store', () => ({
  useKeyboardShortcutsStore: () => ({
    shortcuts: {
      commandPalette: { customKey: 'Ctrl+K', defaultKey: 'Ctrl+K' },
      commandPaletteAlt: { customKey: 'Ctrl+Shift+P', defaultKey: 'Ctrl+Shift+P' },
      terminalSearch: { customKey: 'Ctrl+F', defaultKey: 'Ctrl+F' },
      commandHistory: { customKey: 'Ctrl+R', defaultKey: 'Ctrl+R' },
      newProject: { customKey: 'Ctrl+N', defaultKey: 'Ctrl+N' },
      newTerminal: { customKey: 'Ctrl+T', defaultKey: 'Ctrl+T' },
      nextTerminal: { customKey: 'Ctrl+PageDown', defaultKey: 'Ctrl+PageDown' },
      prevTerminal: { customKey: 'Ctrl+PageUp', defaultKey: 'Ctrl+PageUp' },
      zoomIn: { customKey: 'Ctrl+=', defaultKey: 'Ctrl+=' },
      zoomOut: { customKey: 'Ctrl+-', defaultKey: 'Ctrl+-' },
      zoomReset: { customKey: 'Ctrl+0', defaultKey: 'Ctrl+0' },
      colorThemePicker: { customKey: 'Ctrl+Alt+T', defaultKey: 'Ctrl+Alt+T' }
    }
  }),
  matchesShortcut: () => false
}))

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontSize: () => 14,
  useUiZoomLevel: () => 1,
  useDefaultShell: () => 'bash',
  useMaxTerminalsPerProject: () => 10,
  useConfirmTerminalClose: () => confirmTerminalCloseRef.current,
  useColorTheme: () => 'termul',
  useAppearanceMode: () => 'dark'
}))

vi.mock('@/hooks/use-snapshots', () => ({
  useCreateSnapshot: () => vi.fn(),
  useSnapshotLoader: () => undefined
}))

vi.mock('@/hooks/use-recent-commands', () => ({
  useRecentCommandsLoader: () => undefined
}))

vi.mock('@/hooks/use-pinned-commands', () => ({
  usePinnedCommandsLoader: () => undefined
}))

vi.mock('@/hooks/use-command-history', () => ({
  useCommandHistoryLoader: () => undefined,
  useAddCommand: () => vi.fn(),
  useCommandHistory: () => [],
  useAllCommandHistory: () => []
}))

vi.mock('@/hooks/use-app-settings', () => ({
  useUpdateAppSetting: () => vi.fn(),
  useUpdateAppSettings: () => vi.fn(),
  useUpdatePanelVisibility: () => mockUpdatePanelVisibility,
  waitForPendingAppSettingsPersistence: mockWaitForPendingAppSettingsPersistence
}))

vi.mock('@/lib/acp-history-persistence', () => ({
  flushSessionHistory: mockFlushSessionHistory,
  waitForPendingSessionIndexWrite: mockWaitForPendingSessionIndexWrite
}))

vi.mock('@/lib/tauri-event', () => ({
  listen: mockListen
}))

vi.mock('@/hooks/use-file-watcher', () => ({
  useFileWatcher: () => undefined
}))

vi.mock('@/hooks/use-editor-persistence', () => ({
  useEditorPersistence: () => undefined
}))

// P17: shared canonical mock shape — identical across the WorkspaceLayout suites.
vi.mock('@/hooks/use-workspace-manifest-sync', () => ({
  useWorkspaceManifestSync: vi.fn(),
  loadWorkspaceManifest: vi.fn().mockResolvedValue(false),
  resolveManifestConflict: vi.fn().mockResolvedValue(undefined),
  performManifestWrite: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/components/workspace/WorkspaceConflictBanner', () => ({
  WorkspaceConflictBanner: () => <div data-testid="workspace-conflict-banner" />
}))

vi.mock('@/components/ProjectSidebar', () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />
}))

vi.mock('@/components/workspace/PaneRenderer', () => ({
  PaneRenderer: (props: {
    onCloseTabs?: (tabs: WorkspaceTab[]) => void
    onCloseTerminal?: (id: string, tabId: string) => void
  }) => {
    paneRendererPropsRef.current = props
    return <div data-testid="pane-renderer" />
  }
}))

vi.mock('@/components/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="file-explorer" />
}))

vi.mock('@/components/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar" />
}))

vi.mock('@/components/TitleBar', () => ({
  TitleBar: () => <div data-testid="title-bar" />
}))

vi.mock('@/components/ActivityRail', () => ({
  ActivityRail: () => <div data-testid="activity-rail" />
}))

vi.mock('@/components/NewProjectModal', () => ({
  NewProjectModal: () => null
}))

vi.mock('@/components/CreateSnapshotModal', () => ({
  CreateSnapshotModal: () => null
}))

vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: () => null
}))

vi.mock('@/lib/agents/custom-agents', () => ({
  loadCustomAgents: vi.fn(async () => [])
}))

vi.mock('@/components/CommandHistoryModal', () => ({
  CommandHistoryModal: () => null
}))

vi.mock('@/hooks/use-agent-idle-shutdown', () => ({
  useAgentIdleShutdown: vi.fn(),
  requestCloseAgentChat: mockRequestCloseAgentChat
}))

vi.mock('@/lib/browser-api', () => ({
  browserTabHide: vi.fn(async () => ({ success: true })),
  browserTabShow: vi.fn(async () => ({ success: true }))
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

// Dialog stub renders title + message + all three action buttons when open so
// tests can assert the aggregate summary text and drive each path.
vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    secondaryAction,
    onConfirm,
    onCancel
  }: {
    isOpen: boolean
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
    secondaryAction?: { label: string; onClick: () => void }
    onConfirm: () => void
    onCancel: () => void
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <div>{title}</div>
        <div>{message}</div>
        <button type="button" onClick={onCancel}>
          {cancelLabel}
        </button>
        {secondaryAction ? (
          <button type="button" onClick={secondaryAction.onClick}>
            {secondaryAction.label}
          </button>
        ) : null}
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    watchDirectory: mockWatchDirectory,
    unwatchDirectory: mockUnwatchDirectory
  },
  windowApi: {
    onCloseRequested: mockCloseRequested,
    respondToClose: mockRespondToClose
  },
  keyboardApi: {
    onShortcut: mockKeyboardOnShortcut
  },
  terminalApi: {
    spawn: vi.fn(),
    kill: mockTerminalKill,
    onData: vi.fn(() => vi.fn())
  },
  persistenceApi: {
    flushPendingWrites: mockFlushPendingWrites
  },
  sessionApi: {
    hasSession: vi.fn(async () => ({ success: true, data: false })),
    restore: vi.fn(async () => ({
      success: false,
      error: 'No session',
      code: 'SESSION_NOT_FOUND'
    })),
    save: vi.fn(),
    clear: vi.fn(),
    flush: vi.fn()
  },
  sshApi: {
    onConnectionStatusChanged: vi.fn(() => vi.fn())
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError,
    success: vi.fn()
  }
}))

function renderLayout() {
  return render(
    <TooltipProvider>
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    </TooltipProvider>
  )
}

const terminalTab = (id: string, terminalId: string): WorkspaceTab => ({
  type: 'terminal',
  id,
  terminalId
})
const editorTab = (filePath: string): WorkspaceTab => ({
  type: 'editor',
  id: `edit-${filePath}`,
  filePath
})
const gitTab = (id: string): WorkspaceTab => ({ type: 'git', id, cwd: '/test/project' })
const browserTabWs = (id: string, browserTabId: string): WorkspaceTab => ({
  type: 'browser',
  id,
  browserTabId
})
const agentChatTab = (id: string, sessionId: string): WorkspaceTab => ({
  type: 'agent-chat',
  id,
  sessionId
})

function seedTerminals(...records: Array<{ id: string; ptyId: string }>) {
  mockTerminalStoreState.terminals = records.map((r) => ({
    id: r.id,
    ptyId: r.ptyId,
    projectId: 'project-1',
    name: r.id
  }))
}

function seedTabs(...tabs: WorkspaceTab[]) {
  mockWorkspaceStoreState.root = {
    type: 'leaf',
    id: 'pane-root',
    tabs,
    activeTabId: tabs[0]?.id ?? null
  }
}

function closeTabsNow(tabs: WorkspaceTab[]) {
  const onCloseTabs = paneRendererPropsRef.current?.onCloseTabs
  expect(onCloseTabs).toBeTypeOf('function')
  act(() => {
    onCloseTabs?.(tabs)
  })
}

describe('WorkspaceLayout aggregate bulk close', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    confirmTerminalCloseRef.current = true
    paneRendererPropsRef.current = null
    mockWorkspaceStoreState.root = {
      type: 'leaf',
      id: 'pane-root',
      tabs: [],
      activeTabId: null
    }
    mockTerminalStoreState.terminals = []
    mockEditorStoreState.openFiles = new Map()
    mockEditorStoreState.getDirtyFileCount.mockReturnValue(0)
    mockEditorStoreState.saveAllDirty.mockResolvedValue(undefined)
    mockEditorStoreState.saveFile.mockResolvedValue(true)
    mockEditorStoreState.closeFileIfIdle.mockReturnValue(true)
    mockRequestCloseAgentChat.mockImplementation((_s: string, closeTab: () => void) => closeTab())
    mockTerminalKill.mockResolvedValue({ success: true })
    mockFlushPendingWrites.mockResolvedValue({ success: true, data: undefined })
    mockUpdatePanelVisibility.mockResolvedValue(undefined)
    mockWaitForPendingAppSettingsPersistence.mockResolvedValue(undefined)
    mockWaitForPendingSessionIndexWrite.mockResolvedValue(undefined)
    mockFlushSessionHistory.mockResolvedValue(undefined)
    mockCloseRequested.mockImplementation(() => vi.fn())
    mockListen.mockResolvedValue(vi.fn())
  })

  it('shows exactly ONE aggregate dialog for multiple terminals and confirm closes all', async () => {
    seedTerminals({ id: 't1', ptyId: 'pty-1' }, { id: 't2', ptyId: 'pty-2' })
    const tabs = [terminalTab('term-tab-1', 't1'), terminalTab('term-tab-2', 't2'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()

    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    // One aggregate dialog — the per-item "Close Terminal" dialog must not open.
    expect(await screen.findByRole('dialog', { name: 'Close Tabs' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Close Terminal' })).not.toBeInTheDocument()
    expect(
      screen.getByText('Close 3 tabs? 2 terminals have running processes.')
    ).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    })

    await waitFor(() => {
      expect(mockTerminalKill).toHaveBeenCalledWith('pty-1')
      expect(mockTerminalKill).toHaveBeenCalledWith('pty-2')
    })
    expect(mockTerminalActions.closeTerminal).toHaveBeenCalledWith('t1', 'project-1')
    expect(mockTerminalActions.closeTerminal).toHaveBeenCalledWith('t2', 'project-1')
    expect(mockWorkspaceStoreState.closeTab).toHaveBeenCalledWith('pane-root', 'term-tab-1')
    expect(mockWorkspaceStoreState.closeTab).toHaveBeenCalledWith('pane-root', 'term-tab-2')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('git-1')
  })

  it('cancel aborts the whole bulk action — nothing closes', async () => {
    seedTerminals({ id: 't1', ptyId: 'pty-1' }, { id: 't2', ptyId: 'pty-2' })
    const tabs = [terminalTab('term-tab-1', 't1'), terminalTab('term-tab-2', 't2')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(await screen.findByRole('dialog', { name: 'Close Tabs' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })

    expect(mockTerminalKill).not.toHaveBeenCalled()
    expect(mockTerminalActions.closeTerminal).not.toHaveBeenCalled()
    expect(mockWorkspaceStoreState.closeTab).not.toHaveBeenCalled()
    expect(mockWorkspaceStoreState.removeTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
  })

  it('closes targets directly without a dialog when nothing needs confirmation', async () => {
    confirmTerminalCloseRef.current = false
    seedTerminals({ id: 't1', ptyId: 'pty-1' })
    mockEditorStoreState.openFiles = new Map([
      ['/a.ts', { isDirty: false, operationStatus: 'idle' }]
    ])
    const tabs = [terminalTab('term-tab-1', 't1'), gitTab('git-1'), editorTab('/a.ts')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
    await waitFor(() => expect(mockTerminalKill).toHaveBeenCalledWith('pty-1'))
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('git-1')
    expect(mockEditorStoreState.closeFileIfIdle).toHaveBeenCalledWith('/a.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('edit-/a.ts')
  })

  it('routes browser and agent-chat tabs through their normal close paths', async () => {
    confirmTerminalCloseRef.current = false
    const tabs = [browserTabWs('browser-1', 'btab-1'), agentChatTab('ac-1', 'session-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(mockBrowserSessionState.removeTab).toHaveBeenCalledWith('btab-1')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('browser-1')
    expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('session-1', expect.any(Function))
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('ac-1')
  })

  it('summarizes terminals and dirty files in one aggregate dialog', async () => {
    seedTerminals({ id: 't1', ptyId: 'pty-1' }, { id: 't2', ptyId: 'pty-2' })
    mockEditorStoreState.openFiles = new Map([
      ['/a.ts', { isDirty: true, operationStatus: 'idle' }],
      ['/b.ts', { isDirty: false, operationStatus: 'idle' }]
    ])
    const tabs = [
      terminalTab('term-tab-1', 't1'),
      terminalTab('term-tab-2', 't2'),
      editorTab('/a.ts'),
      editorTab('/b.ts'),
      gitTab('git-1')
    ]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(
      await screen.findByText(
        'Close 5 tabs? 2 terminals have running processes; 1 file has unsaved changes.'
      )
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & Close' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "Don't Save" })).toBeInTheDocument()
  })

  it('Save & Close saves every targeted dirty file then closes all tabs', async () => {
    mockEditorStoreState.openFiles = new Map([
      ['/a.ts', { isDirty: true, operationStatus: 'idle' }],
      ['/b.ts', { isDirty: true, operationStatus: 'idle' }],
      ['/c.ts', { isDirty: false, operationStatus: 'idle' }]
    ])
    const tabs = [editorTab('/a.ts'), editorTab('/b.ts'), editorTab('/c.ts'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(await screen.findByRole('dialog', { name: 'Close Tabs' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save & Close' }))
    })

    await waitFor(() => {
      expect(mockEditorStoreState.saveFile).toHaveBeenCalledWith('/a.ts')
      expect(mockEditorStoreState.saveFile).toHaveBeenCalledWith('/b.ts')
    })
    // Non-dirty files are not saved, but every target closes.
    expect(mockEditorStoreState.saveFile).toHaveBeenCalledTimes(2)
    expect(mockEditorStoreState.closeFileIfIdle).toHaveBeenCalledWith('/a.ts')
    expect(mockEditorStoreState.closeFileIfIdle).toHaveBeenCalledWith('/b.ts')
    expect(mockEditorStoreState.closeFileIfIdle).toHaveBeenCalledWith('/c.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('edit-/a.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('edit-/b.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('edit-/c.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('git-1')
    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
  })

  it("Don't Save discards the dirty files and closes all targets without saving", async () => {
    mockEditorStoreState.openFiles = new Map([
      ['/a.ts', { isDirty: true, operationStatus: 'idle' }]
    ])
    const tabs = [editorTab('/a.ts'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(await screen.findByRole('dialog', { name: 'Close Tabs' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Don't Save" }))
    })

    expect(mockEditorStoreState.saveFile).not.toHaveBeenCalled()
    expect(mockEditorStoreState.closeFileIfIdle).toHaveBeenCalledWith('/a.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('edit-/a.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('git-1')
  })

  it('aborts closing and toasts when a targeted save fails', async () => {
    mockEditorStoreState.openFiles = new Map([
      ['/a.ts', { isDirty: true, operationStatus: 'idle' }]
    ])
    mockEditorStoreState.saveFile.mockResolvedValue(false)
    const tabs = [editorTab('/a.ts'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(await screen.findByRole('dialog', { name: 'Close Tabs' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save & Close' }))
    })

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled()
    })
    // Abort semantics: nothing closes — not even the non-dirty targets.
    expect(mockEditorStoreState.closeFileIfIdle).not.toHaveBeenCalled()
    expect(mockWorkspaceStoreState.removeTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
  })

  it('skips busy editors and terminal tabs already closing', async () => {
    confirmTerminalCloseRef.current = false
    mockEditorStoreState.openFiles = new Map([
      ['/busy.ts', { isDirty: true, operationStatus: 'saving' }],
      ['/idle.ts', { isDirty: false, operationStatus: 'idle' }]
    ])
    const tabs = [editorTab('/busy.ts'), editorTab('/idle.ts'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    // The saving editor is skipped at dispatch — same guard as single close.
    expect(mockEditorStoreState.closeFileIfIdle).not.toHaveBeenCalledWith('/busy.ts')
    expect(mockEditorStoreState.closeFileIfIdle).toHaveBeenCalledWith('/idle.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('git-1')
  })

  it('removes a ghost editor workspace tab whose file is absent from openFiles', async () => {
    // No '/ghost.ts' entry in openFiles: closeFileIfIdle would return false
    // forever, so the orphaned workspace tab must still be removed.
    const tabs = [editorTab('/ghost.ts'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
    // Ghost path: no openFiles record → closeFileIfIdle is bypassed entirely.
    expect(mockEditorStoreState.closeFileIfIdle).not.toHaveBeenCalledWith('/ghost.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('edit-/ghost.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('git-1')
  })

  it('no-ops with a boundary log when every target is filtered out', async () => {
    mockEditorStoreState.openFiles = new Map([
      ['/busy.ts', { isDirty: true, operationStatus: 'saving' }]
    ])
    seedTabs(editorTab('/busy.ts'))

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow([editorTab('/busy.ts')])

    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
    expect(mockEditorStoreState.closeFileIfIdle).not.toHaveBeenCalled()
    expect(mockWorkspaceStoreState.removeTab).not.toHaveBeenCalled()
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'WorkspaceLayout.bulkClose',
        message: expect.stringContaining('filtered out')
      })
    )
  })

  it('aborts closing and toasts when a targeted save rejects', async () => {
    mockEditorStoreState.openFiles = new Map([
      ['/a.ts', { isDirty: true, operationStatus: 'idle' }]
    ])
    mockEditorStoreState.saveFile.mockRejectedValue(new Error('disk full'))
    const tabs = [editorTab('/a.ts'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(await screen.findByRole('dialog', { name: 'Close Tabs' })).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save & Close' }))
    })

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Bulk close aborted')
    })
    expect(mockEditorStoreState.closeFileIfIdle).not.toHaveBeenCalled()
    expect(mockWorkspaceStoreState.removeTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
  })

  it('skips a dirty file that left openFiles while the dialog was open', async () => {
    mockEditorStoreState.openFiles = new Map([
      ['/gone.ts', { isDirty: true, operationStatus: 'idle' }]
    ])
    const tabs = [editorTab('/gone.ts'), gitTab('git-1')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    expect(await screen.findByRole('dialog', { name: 'Close Tabs' })).toBeInTheDocument()

    // The file is closed externally while the aggregate dialog is open:
    // it must be skipped from the save pass instead of aborting on a
    // spurious saveFile(false) — and its ghost tab still removed.
    mockEditorStoreState.openFiles.delete('/gone.ts')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save & Close' }))
    })

    expect(mockEditorStoreState.saveFile).not.toHaveBeenCalledWith('/gone.ts')
    expect(mockToastError).not.toHaveBeenCalled()
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('edit-/gone.ts')
    expect(mockWorkspaceStoreState.removeTab).toHaveBeenCalledWith('git-1')
    expect(screen.queryByRole('dialog', { name: 'Close Tabs' })).not.toBeInTheDocument()
  })

  it('skips an editor that became dirty while a terminal-only dialog was open', async () => {
    seedTerminals({ id: 't1', ptyId: 'pty-1' })
    mockEditorStoreState.openFiles = new Map([
      ['/a.ts', { isDirty: false, operationStatus: 'idle' }]
    ])
    const tabs = [terminalTab('term-tab-1', 't1'), editorTab('/a.ts')]
    seedTabs(...tabs)

    renderLayout()
    await waitFor(() => expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function'))
    closeTabsNow(tabs)

    // Dialog raised for the terminal only: no dirty files at dispatch, so
    // the confirm is a plain "Close" with no Don't Save action.
    const dialog = await screen.findByRole('dialog', { name: 'Close Tabs' })
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: "Don't Save" })).toBeNull()

    // '/a.ts' becomes dirty while the dialog is open — the empty approved
    // set means it must be skipped + warned, not silently discarded.
    mockEditorStoreState.openFiles.set('/a.ts', { isDirty: true, operationStatus: 'idle' })

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    })

    await waitFor(() => expect(mockTerminalKill).toHaveBeenCalledWith('pty-1'))
    expect(mockEditorStoreState.closeFileIfIdle).not.toHaveBeenCalledWith('/a.ts')
    expect(mockWorkspaceStoreState.removeTab).not.toHaveBeenCalledWith('edit-/a.ts')
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'WorkspaceLayout.bulkClose',
        message: expect.stringContaining('became dirty')
      })
    )
  })

  it('excludes a terminal already closing from the aggregate counts', async () => {
    seedTerminals({ id: 't1', ptyId: 'pty-1' }, { id: 't2', ptyId: 'pty-2' })
    const tabs = [terminalTab('term-tab-1', 't1'), terminalTab('term-tab-2', 't2')]
    seedTabs(...tabs)
    // Keep t1's kill pending so it stays in closingTerminalIds.
    mockTerminalKill.mockImplementation((ptyId: string) =>
      ptyId === 'pty-1' ? new Promise(() => {}) : Promise.resolve({ success: true })
    )

    renderLayout()
    await waitFor(() => {
      expect(paneRendererPropsRef.current?.onCloseTabs).toBeTypeOf('function')
      expect(paneRendererPropsRef.current?.onCloseTerminal).toBeTypeOf('function')
    })

    // Start t1's normal single close through its own confirm dialog; the
    // pending kill keeps it in closingTerminalIds.
    act(() => {
      paneRendererPropsRef.current?.onCloseTerminal?.('t1', 'term-tab-1')
    })
    const singleDialog = await screen.findByRole('dialog', { name: 'Close Terminal' })
    await act(async () => {
      fireEvent.click(within(singleDialog).getByRole('button', { name: 'Close' }))
    })
    await waitFor(() => expect(mockTerminalKill).toHaveBeenCalledWith('pty-1'))

    // Bulk-dispatch both terminal tabs while t1's close is in flight: only
    // t2 is actionable and the aggregate counts reflect that.
    closeTabsNow(tabs)

    const bulkDialog = await screen.findByRole('dialog', { name: 'Close Tabs' })
    expect(bulkDialog).toHaveTextContent('Close 1 tab? 1 terminal has running processes.')

    await act(async () => {
      fireEvent.click(within(bulkDialog).getByRole('button', { name: 'Close' }))
    })

    await waitFor(() => expect(mockTerminalKill).toHaveBeenCalledWith('pty-2'))
    // t1's close is not re-triggered by the bulk action.
    expect(mockTerminalKill.mock.calls.filter((call) => call[0] === 'pty-1')).toHaveLength(1)
    expect(mockTerminalActions.closeTerminal).toHaveBeenCalledWith('t2', 'project-1')
    expect(mockTerminalActions.closeTerminal).not.toHaveBeenCalledWith('t1', 'project-1')
  })
})
