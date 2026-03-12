import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorkspaceLayout from './WorkspaceLayout'

const {
  activeProject,
  mockProjectActions,
  mockTerminalActions,
  mockEditorStoreState,
  mockTerminalStoreState,
  mockWorkspaceStoreState,
  mockFileExplorerStoreState,
  mockCloseRequested,
  mockRespondToClose,
  mockFlushPendingWrites,
  mockWatchDirectory,
  mockUnwatchDirectory,
  mockKeyboardOnShortcut,
  mockUpdatePanelVisibility,
  mockWaitForPendingAppSettingsPersistence,
  mockToastError
} = vi.hoisted(() => ({
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
    openFiles: new Map(),
    getDirtyFileCount: vi.fn(() => 0),
    saveAllDirty: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => true),
    closeFile: vi.fn(),
    setActiveFilePath: vi.fn()
  },
  mockTerminalStoreState: {
    activeTerminalId: '',
    selectTerminal: vi.fn(),
    setTerminalPtyId: vi.fn()
  },
  mockWorkspaceStoreState: {
    activePaneId: 'pane-root',
    root: { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null },
    syncTerminalTabs: vi.fn(),
    getNextTabId: vi.fn(() => null),
    addTabToPane: vi.fn(),
    closeTab: vi.fn(),
    removeTab: vi.fn()
  },
  mockFileExplorerStoreState: {
    setRootPath: vi.fn(),
    setRootLoadError: vi.fn(),
    toggleVisibility: vi.fn()
  },
  mockCloseRequested: vi.fn(() => vi.fn()),
  mockRespondToClose: vi.fn(),
  mockFlushPendingWrites: vi.fn(async () => ({ success: true, data: undefined })),
  mockWatchDirectory: vi.fn(async () => ({ success: true })),
  mockUnwatchDirectory: vi.fn(async () => ({ success: true })),
  mockKeyboardOnShortcut: vi.fn(() => vi.fn()),
  mockUpdatePanelVisibility: vi.fn(async () => undefined),
  mockWaitForPendingAppSettingsPersistence: vi.fn(async () => undefined),
  mockToastError: vi.fn()
}))

vi.mock('@/stores/project-store', () => ({
  useProjectsLoaded: () => true,
  useProjects: () => [activeProject],
  useActiveProject: () => activeProject,
  useActiveProjectId: () => activeProject.id,
  useProjectActions: () => mockProjectActions
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

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => mockWorkspaceStoreState,
    subscribe: () => vi.fn()
  },
  useActiveTab: () => undefined,
  usePaneRoot: () => ({ type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null }),
  editorTabId: (filePath: string) => `editor:${filePath}`,
  getActiveTerminalIdFromTree: () => null,
  getActiveFilePathFromTree: () => null,
  findPaneContainingTab: () => null
}))

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
      zoomReset: { customKey: 'Ctrl+0', defaultKey: 'Ctrl+0' }
    }
  }),
  matchesShortcut: () => false
}))

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontSize: () => 14,
  useDefaultShell: () => 'bash',
  useMaxTerminalsPerProject: () => 10
}))

vi.mock('@/hooks/use-snapshots', () => ({
  useCreateSnapshot: () => vi.fn(),
  useSnapshotLoader: () => undefined
}))

vi.mock('@/hooks/use-recent-commands', () => ({
  useRecentCommandsLoader: () => undefined
}))

vi.mock('@/hooks/use-command-history', () => ({
  useCommandHistoryLoader: () => undefined,
  useAddCommand: () => vi.fn(),
  useCommandHistory: () => [],
  useAllCommandHistory: () => []
}))

vi.mock('@/hooks/use-app-settings', () => ({
  useUpdateAppSetting: () => vi.fn(),
  useUpdatePanelVisibility: () => mockUpdatePanelVisibility,
  waitForPendingAppSettingsPersistence: mockWaitForPendingAppSettingsPersistence
}))

vi.mock('@/hooks/use-file-watcher', () => ({
  useFileWatcher: () => undefined
}))

vi.mock('@/hooks/use-editor-persistence', () => ({
  useEditorPersistence: () => undefined
}))

vi.mock('@/components/ProjectSidebar', () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />
}))

vi.mock('@/components/workspace/PaneRenderer', () => ({
  PaneRenderer: () => <div data-testid="pane-renderer" />
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

vi.mock('@/components/NewProjectModal', () => ({
  NewProjectModal: () => null
}))

vi.mock('@/components/CreateSnapshotModal', () => ({
  CreateSnapshotModal: () => null
}))

vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: () => null
}))

vi.mock('@/components/CommandHistoryModal', () => ({
  CommandHistoryModal: () => null
}))

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    secondaryAction,
    onConfirm,
    onCancel
  }: {
    isOpen: boolean
    title: string
    confirmLabel?: string
    cancelLabel?: string
    secondaryAction?: { label: string; onClick: () => void }
    onConfirm: () => void
    onCancel: () => void
  }) =>
    isOpen ? (
      <div>
        <div>{title}</div>
        <button onClick={onCancel}>{cancelLabel}</button>
        {secondaryAction ? (
          <button onClick={secondaryAction.onClick}>{secondaryAction.label}</button>
        ) : null}
        <button onClick={onConfirm}>{confirmLabel}</button>
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
    kill: vi.fn()
  },
  persistenceApi: {
    flushPendingWrites: mockFlushPendingWrites
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError
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

describe('WorkspaceLayout close persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEditorStoreState.activeFilePath = null
    mockEditorStoreState.openFiles = new Map()
    mockEditorStoreState.getDirtyFileCount.mockReturnValue(0)
    mockEditorStoreState.saveAllDirty.mockResolvedValue(undefined)
    mockFlushPendingWrites.mockResolvedValue({ success: true, data: undefined })
    mockUpdatePanelVisibility.mockResolvedValue(undefined)
    mockWaitForPendingAppSettingsPersistence.mockResolvedValue(undefined)
    mockCloseRequested.mockImplementation(() => vi.fn())
  })

  it('flushes pending persistence writes before closing when there are no dirty files', async () => {
    renderLayout()

    const closeHandler = (mockCloseRequested.mock.calls as unknown as Array<[() => void]>)[0]?.[0]

    await act(async () => {
      closeHandler?.()
    })

    await waitFor(() => {
      expect(mockFlushPendingWrites).toHaveBeenCalledTimes(1)
      expect(mockRespondToClose).toHaveBeenCalledWith('close')
    })
  })

  it('flushes pending persistence writes after saving all dirty files', async () => {
    mockEditorStoreState.getDirtyFileCount.mockReset()
    mockEditorStoreState.getDirtyFileCount
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(0)

    renderLayout()

    const closeHandler = (mockCloseRequested.mock.calls as unknown as Array<[() => void]>)[0]?.[0]

    await act(async () => {
      closeHandler?.()
    })

    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save All' }))
    })

    await waitFor(() => {
      expect(mockEditorStoreState.saveAllDirty).toHaveBeenCalledTimes(1)
      expect(mockFlushPendingWrites).toHaveBeenCalledTimes(1)
      expect(mockRespondToClose).toHaveBeenCalledWith('close')
    })
  })

  it('flushes pending persistence writes when the user discards dirty files', async () => {
    mockEditorStoreState.getDirtyFileCount.mockReset()
    mockEditorStoreState.getDirtyFileCount.mockReturnValue(2)

    renderLayout()

    const closeHandler = (mockCloseRequested.mock.calls as unknown as Array<[() => void]>)[0]?.[0]

    await act(async () => {
      closeHandler?.()
    })

    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Don't Save" }))
    })

    await waitFor(() => {
      expect(mockFlushPendingWrites).toHaveBeenCalledTimes(1)
      expect(mockRespondToClose).toHaveBeenCalledWith('close')
    })
  })

  it('still closes the app when flushing pending persistence writes fails', async () => {
    mockFlushPendingWrites.mockResolvedValue({ success: false, data: undefined })

    renderLayout()

    const closeHandler = (mockCloseRequested.mock.calls as unknown as Array<[() => void]>)[0]?.[0]

    await act(async () => {
      closeHandler?.()
    })

    await waitFor(() => {
      expect(mockFlushPendingWrites).toHaveBeenCalledTimes(1)
      expect(mockRespondToClose).toHaveBeenCalledWith('close')
    })
  })
})
