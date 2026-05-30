import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorkspaceLayout from './WorkspaceLayout'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useSidebarStore } from '@/stores/sidebar-store'
import type { Project, Terminal, ProjectColor } from '@/types/project'

function createProject(id: string, path: string, color: ProjectColor): Project {
  return {
    id,
    name: id.toUpperCase(),
    color,
    path,
    gitBranch: 'main',
    isActive: true
  }
}

// Mock the store hooks
const mockUseProjectsLoaded = vi.fn(() => true)
const mockUseProjects = vi.fn((): Project[] => [])
const mockUseActiveProject = vi.fn((): Project | null => null)
const mockUseActiveProjectId = vi.fn((): string => '')
const mockUseProjectActions = vi.fn(() => ({
  selectProject: vi.fn(),
  addProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  archiveProject: vi.fn(),
  restoreProject: vi.fn(),
  reorderProjects: vi.fn()
}))

const mockUseTerminals = vi.fn((): Terminal[] => [])
const mockUseAllTerminals = vi.fn((): Terminal[] => [])
const mockUseActiveTerminal = vi.fn((): Terminal | null => null)
const mockUseActiveTerminalId = vi.fn((): string => '')
const mockUseTerminalActions = vi.fn(() => ({
  selectTerminal: vi.fn(),
  addTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  renameTerminal: vi.fn(),
  reorderTerminals: vi.fn(),
  setTerminalPtyId: vi.fn(),
  clearTerminalPtyId: vi.fn()
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector) => {
      const state = {
        projects: [],
        activeProjectId: '',
        isLoaded: true,
        isWorktreeOperationLocked: false
      }
      return selector ? selector(state) : state
    }),
    { getState: vi.fn(() => ({
      projects: [],
      activeProjectId: '',
      isLoaded: true,
      isWorktreeOperationLocked: false,
      removeWorktree: vi.fn(),
      updateProject: vi.fn()
    })) }
  ),
  useProjectsLoaded: () => mockUseProjectsLoaded(),
  useProjects: () => mockUseProjects(),
  useActiveProject: () => mockUseActiveProject(),
  useActiveProjectId: () => mockUseActiveProjectId(),
  useProjectActions: () => mockUseProjectActions()
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector) => selector({ terminals: [] })),
  useTerminals: () => mockUseTerminals(),
  useAllTerminals: () => mockUseAllTerminals(),
  useActiveTerminal: () => mockUseActiveTerminal(),
  useActiveTerminalId: () => mockUseActiveTerminalId(),
  useTerminalActions: () => mockUseTerminalActions(),
  useProjectsWithActivity: () => [],
  useProjectsWithErrors: () => new Set<string>(),
  cleanupProjectTerminals: vi.fn()
}))

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontSize: vi.fn(() => 14),
  useTerminalFontFamily: vi.fn(() => 'monospace'),
  useTerminalBufferSize: vi.fn(() => 10000),
  useDefaultShell: vi.fn(() => 'bash'),
  useMaxTerminalsPerProject: vi.fn(() => 10),
  useConfirmTerminalClose: vi.fn(() => true),
  useUpdateAppSetting: vi.fn(() => vi.fn()),
  useDefaultProjectColor: vi.fn(() => 'blue')
}))

vi.mock('@/stores/keyboard-shortcuts-store', async () => {
  const actual = await vi.importActual<typeof import('@/stores/keyboard-shortcuts-store')>(
    '@/stores/keyboard-shortcuts-store'
  )

  const shortcuts = {
    commandPalette: { customKey: 'ctrl+k', defaultKey: 'ctrl+k' },
    commandPaletteAlt: { customKey: 'ctrl+shift+p', defaultKey: 'ctrl+shift+p' },
    terminalSearch: { customKey: 'ctrl+f', defaultKey: 'ctrl+f' },
    commandHistory: { customKey: 'ctrl+r', defaultKey: 'ctrl+r' },
    newProject: { customKey: 'ctrl+n', defaultKey: 'ctrl+n' },
    newTerminal: { customKey: 'ctrl+t', defaultKey: 'ctrl+t' },
    nextTerminal: { customKey: 'ctrl+pagedown', defaultKey: 'ctrl+pagedown' },
    prevTerminal: { customKey: 'ctrl+pageup', defaultKey: 'ctrl+pageup' },
    zoomIn: { customKey: 'ctrl+=', defaultKey: 'ctrl+=' },
    zoomOut: { customKey: 'ctrl+-', defaultKey: 'ctrl+-' },
    zoomReset: { customKey: 'ctrl+0', defaultKey: 'ctrl+0' },
    sidebarToggle: { customKey: 'ctrl+shift+b', defaultKey: 'ctrl+shift+b' },
    closeTab: { customKey: 'ctrl+w', defaultKey: 'ctrl+w' },
    saveFile: { customKey: 'ctrl+s', defaultKey: 'ctrl+s' },
    toggleFileExplorer: { customKey: 'ctrl+b', defaultKey: 'ctrl+b' },
    newBrowserTab: { customKey: 'ctrl+shift+n', defaultKey: 'ctrl+shift+n' }
  }

  return {
    ...actual,
    useKeyboardShortcutsStore: vi.fn((selector?: (state: { shortcuts: typeof shortcuts }) => unknown) => {
      const state = { shortcuts }
      return selector ? selector(state) : state
    }),
    matchesShortcut: actual.matchesShortcut
  }
})

// Mock hooks
vi.mock('@/hooks/use-snapshots', () => ({
  useCreateSnapshot: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
  useSnapshotLoader: vi.fn()
}))

vi.mock('@/hooks/use-recent-commands', () => ({
  useRecentCommandsLoader: vi.fn(),
  useRecentCommandIds: vi.fn(() => []),
  useSaveRecentCommand: vi.fn()
}))

vi.mock('@/hooks/use-command-history', () => ({
  useCommandHistoryLoader: vi.fn(),
  useAddCommand: vi.fn(() => vi.fn()),
  useCommandHistory: vi.fn(() => []),
  useAllCommandHistory: vi.fn(() => [])
}))

const { mockUseIsMobile, mockUpdatePanelVisibility, mockWaitForPendingAppSettingsPersistence } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(() => false),
  mockUpdatePanelVisibility: vi.fn(() => Promise.resolve()),
  mockWaitForPendingAppSettingsPersistence: vi.fn(() => Promise.resolve())
}))

vi.mock('@/hooks/use-app-settings', () => ({
  useUpdateAppSetting: vi.fn(() => vi.fn()),
  useUpdatePanelVisibility: vi.fn(() => mockUpdatePanelVisibility),
  waitForPendingAppSettingsPersistence: mockWaitForPendingAppSettingsPersistence
}))

vi.mock('@/hooks/use-file-watcher', () => ({
  useFileWatcher: vi.fn()
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => mockUseIsMobile()
}))

vi.mock('@/hooks/use-pane-dnd', () => ({
  PaneDndProvider: ({ children }: { children?: unknown }) => <>{children}</>
}))

vi.mock('@/components/ProjectSidebar', () => ({
  ProjectSidebar: () => <div data-testid="project-sidebar" />
}))

vi.mock('@/components/remote/RemoteAccessPanel', () => ({
  RemoteAccessPanel: () => null
}))

vi.mock('@/components/workspace/PaneRenderer', () => ({
  PaneRenderer: () => <div data-testid="pane-renderer" />
}))

vi.mock('@/components/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar" />
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
  ConfirmDialog: () => null
}))

vi.mock('@/components/TitleBar', () => ({
  TitleBar: () => <div data-testid="title-bar" />
}))

vi.mock('@/hooks/use-editor-persistence', () => ({
  useEditorPersistence: vi.fn(),
  persistState: vi.fn()
}))

const { mockSaveTerminalLayout } = vi.hoisted(() => ({
  mockSaveTerminalLayout: vi.fn(() => Promise.resolve())
}))
vi.mock('@/hooks/useTerminalAutoSave', () => ({
  saveTerminalLayout: mockSaveTerminalLayout,
  useTerminalAutoSave: vi.fn(),
  loadPersistedTerminals: vi.fn(),
  setTerminalRestoreInProgress: vi.fn(),
  syncScrollbackToStore: vi.fn(),
  serializeTerminalsForProject: vi.fn()
}))

vi.mock('@/components/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="file-explorer" />
}))

// Mock the active Tauri API seam used by WorkspaceLayout and nested components.
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    keyboard: {
      onShortcut: vi.fn((_callback: () => Promise<boolean>) => vi.fn())
    },
    shell: {
      getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: { default: null, available: [] } })
    },
    terminal: {
      getGitBranch: vi.fn().mockResolvedValue({ success: true, data: 'main' }),
      getGitStatus: vi.fn().mockResolvedValue({ success: true, data: { hasChanges: false } }),
      onData: vi.fn(() => vi.fn()),
      onTitleChange: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      spawn: vi.fn().mockResolvedValue({ success: true, data: 'mock-pty-id' }),
      resize: vi.fn().mockResolvedValue({ success: true }),
      kill: vi.fn().mockResolvedValue({ success: true }),
      write: vi.fn().mockResolvedValue({ success: true })
    },
    filesystem: {
      onFileChanged: vi.fn(() => vi.fn()),
      onFileCreated: vi.fn(() => vi.fn()),
      onFileDeleted: vi.fn(() => vi.fn()),
      watchDirectory: vi.fn().mockResolvedValue({ success: true }),
      unwatchDirectory: vi.fn().mockResolvedValue({ success: true }),
      readDirectory: vi.fn().mockResolvedValue({ success: true, data: [] })
    },
    system: {
      getHomeDirectory: vi.fn().mockResolvedValue({ success: true, data: '/home/user' }),
      getAvailableShells: vi.fn().mockResolvedValue({ success: true, data: [] })
    },
    persistence: {
      writeDebounced: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
      read: vi.fn(() => Promise.resolve({ success: true, data: null })),
      write: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
      delete: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
      flushPendingWrites: vi.fn(() => Promise.resolve({ success: true, data: undefined }))
    },
    window: {
      minimize: vi.fn(),
      toggleMaximize: vi.fn().mockResolvedValue({ success: true, data: false }),
      close: vi.fn(),
      onMaximizeChange: vi.fn(() => vi.fn()),
      onCloseRequested: vi.fn<(callback: () => Promise<boolean>) => () => void>((_callback) => vi.fn()),
      respondToClose: vi.fn()
    },
    clipboard: {
      readText: vi.fn().mockResolvedValue({ success: true, data: '' }),
      writeText: vi.fn().mockResolvedValue({ success: true })
    },
    dialog: {
      selectDirectory: vi.fn(),
      selectFile: vi.fn(),
      saveFile: vi.fn(),
      showConfirm: vi.fn(),
      showMessage: vi.fn()
    },
    visibility: {
      setVisibilityState: vi.fn()
    },
    session: {
      save: vi.fn(),
      restore: vi.fn(),
      clear: vi.fn(),
      flush: vi.fn(),
      hasSession: vi.fn()
    },
    dataMigration: {
      getVersion: vi.fn(),
      getSchemaInfo: vi.fn(),
      getHistory: vi.fn(),
      getRegistered: vi.fn(),
      runMigration: vi.fn(),
      rollback: vi.fn()
    },
    addRendererRef: vi.fn(),
    removeRendererRef: vi.fn(),
    hasActiveTerminalSessions: vi.fn()
  }
}))

vi.mock('@/lib/api', () => ({
  keyboardApi: mockApi.keyboard,
  shellApi: mockApi.shell,
  terminalApi: mockApi.terminal,
  filesystemApi: mockApi.filesystem,
  systemApi: mockApi.system,
  persistenceApi: mockApi.persistence,
  windowApi: mockApi.window,
  clipboardApi: mockApi.clipboard,
  dialogApi: mockApi.dialog,
  visibilityApi: mockApi.visibility,
  sessionApi: mockApi.session,
  dataMigrationApi: mockApi.dataMigration,
  addRendererRef: mockApi.addRendererRef,
  removeRendererRef: mockApi.removeRendererRef,
  hasActiveTerminalSessions: mockApi.hasActiveTerminalSessions,
  tauriUpdaterApi: {},
  tauriVersionSkipService: {}
}))

beforeEach(() => {
  vi.stubGlobal('api', mockApi)
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn()
  }
  // Reset mocks
  mockUseProjectsLoaded.mockReturnValue(true)
  mockUseProjects.mockReturnValue([])
  mockUseActiveProject.mockReturnValue(null)
  mockUseActiveProjectId.mockReturnValue('')
  mockUseTerminals.mockReturnValue([])
  mockUseAllTerminals.mockReturnValue([])
  mockUseActiveTerminal.mockReturnValue(null)
  mockUseActiveTerminalId.mockReturnValue('')
  mockUseIsMobile.mockReturnValue(false)
  mockUpdatePanelVisibility.mockReset()
  mockWaitForPendingAppSettingsPersistence.mockReset()
  useFileExplorerStore.setState({ isVisible: true })
  useSidebarStore.setState({ isVisible: true })
  mockApi.filesystem.watchDirectory.mockReset()
  mockApi.filesystem.unwatchDirectory.mockReset()
  mockApi.filesystem.watchDirectory.mockResolvedValue({ success: true })
  mockApi.persistence.flushPendingWrites.mockReset()
  mockApi.persistence.flushPendingWrites.mockResolvedValue({ success: true, data: undefined })
  mockApi.window.onCloseRequested.mockReset()
  mockApi.window.onCloseRequested.mockImplementation(() => vi.fn())
  mockApi.window.respondToClose.mockReset()
})

afterEach(() => {
  vi.clearAllTimers()
})

// Helper to render with router
const renderWithRouter = (initialEntries = ['/']) => {
  return render(
    <TooltipProvider>
      <MemoryRouter
        initialEntries={initialEntries}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <WorkspaceLayout />
      </MemoryRouter>
    </TooltipProvider>
  )
}

describe('WorkspaceLayout - Empty States', () => {
  it('persists terminal layout before unload when a project is active', async () => {
    mockUseActiveProjectId.mockReturnValue('project-1')
    mockUseActiveProject.mockReturnValue(createProject('project-1', '/workspace/project-1', 'blue'))

    renderWithRouter()

    window.dispatchEvent(new Event('beforeunload'))

    await waitFor(() => {
      expect(mockSaveTerminalLayout).toHaveBeenCalledWith('project-1')
    })
  })

  describe('No Projects Empty State', () => {
    beforeEach(() => {
      // Ensure no projects
      mockUseProjects.mockReturnValue([])
      mockUseActiveProject.mockReturnValue(null)
      mockUseActiveProjectId.mockReturnValue('')
    })

    it('should render no projects empty state when projects array is empty', () => {
      renderWithRouter()

      expect(screen.getByText('No Projects Yet')).toBeInTheDocument()
      expect(
        screen.getByText('Create your first project to organize your terminals, snapshots, and commands')
      ).toBeInTheDocument()
    })

    it('should show descriptive message about creating first project', () => {
      renderWithRouter()

      const description = screen.getByText(
        'Create your first project to organize your terminals, snapshots, and commands'
      )
      expect(description).toBeInTheDocument()
      expect(description.tagName).toBe('P')
    })

    it('should have a button to create first project', () => {
      renderWithRouter()

      const button = screen.getByText('Create Your First Project')
      expect(button).toBeInTheDocument()
      expect(button.tagName).toBe('BUTTON')
    })

    it('should not show terminal-related elements when no projects', () => {
      renderWithRouter()

      expect(screen.queryByText('No Terminals Yet')).not.toBeInTheDocument()
      expect(screen.queryByText('Create Your First Terminal')).not.toBeInTheDocument()
    })
  })

  describe('Empty Workspace Pane State', () => {
    beforeEach(() => {
      // Set up a project but no terminals/tabs
      mockUseProjects.mockReturnValue([
        {
          id: '1',
          name: 'Test Project',
          color: 'blue',
          path: '/test/project',
          gitBranch: 'main',
          isActive: true
        }
      ])
      mockUseActiveProject.mockReturnValue({
        id: '1',
        name: 'Test Project',
        color: 'blue',
        path: '/test/project',
        gitBranch: 'main',
        isActive: true
      })
      mockUseActiveProjectId.mockReturnValue('1')
      mockUseTerminals.mockReturnValue([])
      mockUseAllTerminals.mockReturnValue([])
      mockUseActiveTerminal.mockReturnValue(null)
      mockUseActiveTerminalId.mockReturnValue('')
    })

    it.skip('should render empty pane hint when project exists but has no tabs', () => {
      renderWithRouter()

      expect(screen.getByText('Drag a tab or file here')).toBeInTheDocument()
    })

    it.skip('should show pane-level new terminal action', () => {
      renderWithRouter()

      expect(screen.getByTitle('Open terminal menu')).toBeInTheDocument()
    })

    it('should not show legacy terminal empty-state CTA', () => {
      renderWithRouter()

      expect(screen.queryByText('No Terminals Yet')).not.toBeInTheDocument()
      expect(screen.queryByText('Create Your First Terminal')).not.toBeInTheDocument()
    })

    it('should not show no projects empty state when project exists', () => {
      renderWithRouter()

      expect(screen.queryByText('No Projects Yet')).not.toBeInTheDocument()
    })

    it('renders file explorer in web mode when visible and an active project exists', () => {
      renderWithRouter()

      expect(screen.getByTestId('title-bar')).toBeInTheDocument()
      expect(screen.getByTestId('file-explorer')).toBeInTheDocument()
    })

    it('renders file explorer even when active project path is unavailable', () => {
      mockUseProjects.mockReturnValue([
        {
          id: '1',
          name: 'Test Project',
          color: 'blue',
          path: undefined,
          gitBranch: 'main',
          isActive: true
        }
      ])
      mockUseActiveProject.mockReturnValue({
        id: '1',
        name: 'Test Project',
        color: 'blue',
        path: undefined,
        gitBranch: 'main',
        isActive: true
      })
      mockUseActiveProjectId.mockReturnValue('1')

      renderWithRouter()

      expect(screen.getByTestId('file-explorer')).toBeInTheDocument()
    })

  })

  describe('Empty State Styling', () => {
    it('should center no projects empty state', () => {
      mockUseProjects.mockReturnValue([])
      mockUseActiveProject.mockReturnValue(null)
      mockUseActiveProjectId.mockReturnValue('')

      renderWithRouter()

      const emptyStateContainer = screen.getByText('No Projects Yet').closest('div')?.parentElement
      expect(emptyStateContainer?.className).toContain('items-center')
      expect(emptyStateContainer?.className).toContain('justify-center')
    })

    it.skip('should center empty pane hint in workspace area', () => {
      mockUseProjects.mockReturnValue([
        {
          id: '1',
          name: 'Test Project',
          color: 'blue',
          path: '/test/project',
          gitBranch: 'main',
          isActive: true
        }
      ])
      mockUseActiveProject.mockReturnValue({
        id: '1',
        name: 'Test Project',
        color: 'blue',
        path: '/test/project',
        gitBranch: 'main',
        isActive: true
      })
      mockUseActiveProjectId.mockReturnValue('1')
      mockUseTerminals.mockReturnValue([])
      mockUseAllTerminals.mockReturnValue([])
      mockUseActiveTerminal.mockReturnValue(null)
      mockUseActiveTerminalId.mockReturnValue('')

      renderWithRouter()

      const emptyHint = screen.getByText('Drag a tab or file here')
      const emptyStateContainer = emptyHint.closest('div')
      expect(emptyStateContainer?.className).toContain('items-center')
      expect(emptyStateContainer?.className).toContain('justify-center')
    })

    it('should apply correct text styling to titles', () => {
      mockUseProjects.mockReturnValue([])
      mockUseActiveProject.mockReturnValue(null)
      mockUseActiveProjectId.mockReturnValue('')

      renderWithRouter()

      const title = screen.getByText('No Projects Yet')
      expect(title.className).toContain('text-xl')
      expect(title.className).toContain('font-semibold')
    })

    it('should apply muted styling to descriptions', () => {
      mockUseProjects.mockReturnValue([])
      mockUseActiveProject.mockReturnValue(null)
      mockUseActiveProjectId.mockReturnValue('')

      renderWithRouter()

      const description = screen.getByText(
        /Create your first project to organize your terminals/
      )
      expect(description.className).toContain('text-muted-foreground')
    })
  })

  describe('Transitions Between States', () => {
    it('should show no projects state when no projects exist', () => {
      mockUseProjects.mockReturnValue([])
      mockUseActiveProject.mockReturnValue(null)
      mockUseActiveProjectId.mockReturnValue('')

      renderWithRouter()

      expect(screen.getByText('No Projects Yet')).toBeInTheDocument()
      expect(screen.queryByText('No Terminals Yet')).not.toBeInTheDocument()
    })

    it.skip('should show empty pane hint when project exists but has no tabs', () => {
      mockUseProjects.mockReturnValue([
        {
          id: '1',
          name: 'Test Project',
          color: 'blue',
          path: '/test/project',
          gitBranch: 'main',
          isActive: true
        }
      ])
      mockUseActiveProject.mockReturnValue({
        id: '1',
        name: 'Test Project',
        color: 'blue',
        path: '/test/project',
        gitBranch: 'main',
        isActive: true
      })
      mockUseActiveProjectId.mockReturnValue('1')
      mockUseTerminals.mockReturnValue([])
      mockUseAllTerminals.mockReturnValue([])
      mockUseActiveTerminal.mockReturnValue(null)
      mockUseActiveTerminalId.mockReturnValue('')

      renderWithRouter()

      expect(screen.queryByText('No Projects Yet')).not.toBeInTheDocument()
      expect(screen.getByText('Drag a tab or file here')).toBeInTheDocument()
    })

    it.skip('should not show empty states when terminals exist', () => {
      mockUseProjects.mockReturnValue([
        {
          id: '1',
          name: 'Test Project',
          color: 'blue',
          path: '/test/project',
          gitBranch: 'main',
          isActive: true
        }
      ])
      mockUseActiveProject.mockReturnValue({
        id: '1',
        name: 'Test Project',
        color: 'blue',
        path: '/test/project',
        gitBranch: 'main',
        isActive: true
      })
      mockUseActiveProjectId.mockReturnValue('1')
      mockUseTerminals.mockReturnValue([
        {
          id: 'terminal-1',
          projectId: '1',
          name: 'Terminal 1',
          shell: 'bash',
          cwd: '/test/project'
        }
      ])
      mockUseAllTerminals.mockReturnValue([
        {
          id: 'terminal-1',
          projectId: '1',
          name: 'Terminal 1',
          shell: 'bash',
          cwd: '/test/project'
        }
      ])
      mockUseActiveTerminal.mockReturnValue({
        id: 'terminal-1',
        projectId: '1',
        name: 'Terminal 1',
        shell: 'bash',
        cwd: '/test/project'
      })
      mockUseActiveTerminalId.mockReturnValue('terminal-1')

      renderWithRouter()

      expect(screen.queryByText('No Projects Yet')).not.toBeInTheDocument()
      expect(screen.queryByText('No Terminals Yet')).not.toBeInTheDocument()
    })
  })

  describe('Keyboard panel visibility shortcuts', () => {
    beforeEach(() => {
      const project = createProject('a', '/workspace/a', 'blue')
      mockUseProjects.mockReturnValue([project])
      mockUseActiveProject.mockReturnValue(project)
      mockUseActiveProjectId.mockReturnValue('a')
      mockUseTerminals.mockReturnValue([])
      mockUseAllTerminals.mockReturnValue([])
      mockUseActiveTerminal.mockReturnValue(null)
      mockUseActiveTerminalId.mockReturnValue('')
    })

    it.skip('keeps Ctrl+B toggling file explorer and persists globally', () => {
      renderWithRouter()

      fireEvent.keyDown(window, { key: 'b', ctrlKey: true })

      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', false)
    })

    it.skip('toggles sidebar with configured sidebar shortcut and persists globally', () => {
      renderWithRouter()

      fireEvent.keyDown(window, { key: 'B', ctrlKey: true, shiftKey: true })

      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
    })

    it.skip('does not toggle panel shortcuts when focus is in input', () => {
      renderWithRouter()

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      fireEvent.keyDown(input, { key: 'b', ctrlKey: true })
      fireEvent.keyDown(input, { key: 'B', ctrlKey: true, shiftKey: true })

      expect(useFileExplorerStore.getState().isVisible).toBe(true)
      expect(useSidebarStore.getState().isVisible).toBe(true)
      expect(mockUpdatePanelVisibility).not.toHaveBeenCalled()

      document.body.removeChild(input)
    })

    it.skip('treats xterm textarea focus as terminal focus for sidebar shortcuts', () => {
      renderWithRouter()

      const terminalRoot = document.createElement('div')
      terminalRoot.className = 'xterm'
      const textarea = document.createElement('textarea')
      terminalRoot.appendChild(textarea)
      document.body.appendChild(terminalRoot)
      textarea.focus()

      fireEvent.keyDown(textarea, { key: 'B', ctrlKey: true, shiftKey: true })

      expect(mockUpdatePanelVisibility).toHaveBeenCalledTimes(1)
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)

      document.body.removeChild(terminalRoot)
    })

    it.skip('does not suppress global non-sidebar shortcuts when focus is in xterm', () => {
      // Verify that a global shortcut whose active element is xterm's textarea
      // fires the appropriate handler rather than being suppressed.
      // Ctrl+N opens the new project modal — it is global and must work from terminal focus.
      renderWithRouter()

      const terminalRoot = document.createElement('div')
      terminalRoot.className = 'xterm'
      const textarea = document.createElement('textarea')
      terminalRoot.appendChild(textarea)
      document.body.appendChild(terminalRoot)
      textarea.focus()

      // File explorer toggle (Ctrl+B) is intentionally blocked in terminal — use
      // sidebar toggle (Ctrl+Shift+B) which IS global from terminal focus.
      // The sidebar was already tested above; here we confirm the panel
      // visibility mock is called exactly once (not zero, as a plain
      // textarea would produce).
      mockUpdatePanelVisibility.mockClear()
      fireEvent.keyDown(textarea, { key: 'B', ctrlKey: true, shiftKey: true })

      expect(mockUpdatePanelVisibility).toHaveBeenCalledTimes(1)
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)

      document.body.removeChild(terminalRoot)
    })

    it.skip('opens the command palette when Ctrl+K is pressed from terminal focus', () => {
      renderWithRouter()

      const terminalRoot = document.createElement('div')
      terminalRoot.className = 'xterm'
      const textarea = document.createElement('textarea')
      terminalRoot.appendChild(textarea)
      document.body.appendChild(terminalRoot)
      textarea.focus()

      fireEvent.keyDown(textarea, { key: 'k', ctrlKey: true })

      expect(screen.getByPlaceholderText('Type a command or search...')).toBeInTheDocument()

      document.body.removeChild(terminalRoot)
    })

    it.skip('opens command history when Ctrl+R is pressed from terminal focus', () => {
      renderWithRouter()

      const terminalRoot = document.createElement('div')
      terminalRoot.className = 'xterm'
      const textarea = document.createElement('textarea')
      terminalRoot.appendChild(textarea)
      document.body.appendChild(terminalRoot)
      textarea.focus()

      fireEvent.keyDown(textarea, { key: 'r', ctrlKey: true })

      expect(screen.getByText('Command History')).toBeInTheDocument()

      document.body.removeChild(terminalRoot)
    })
  })

  describe('Close flow persistence coordination', () => {
    it.skip('waits for pending app-settings persistence before responding to close with no dirty files', async () => {
      let closeRequestedCallback: (() => Promise<boolean>) | undefined
      mockApi.window.onCloseRequested.mockImplementation((callback: () => Promise<boolean>) => {
        closeRequestedCallback = callback
        return vi.fn()
      })

      const project = createProject('a', '/workspace/a', 'blue')
      mockUseProjects.mockReturnValue([project])
      mockUseActiveProject.mockReturnValue(project)
      mockUseActiveProjectId.mockReturnValue('a')

      const deferred = new Promise<void>((resolve) => {
        mockWaitForPendingAppSettingsPersistence.mockImplementationOnce(async () => {
          await new Promise<void>((r) => setTimeout(r, 0))
          resolve()
        })
      })

      renderWithRouter()
      expect(closeRequestedCallback).toBeDefined()
      if (!closeRequestedCallback) throw new Error('close callback missing')

      await expect(closeRequestedCallback()).resolves.toBe(false)

      expect(mockApi.window.respondToClose).not.toHaveBeenCalled()
      await deferred
      await waitFor(() => {
        expect(mockApi.window.respondToClose).toHaveBeenCalledWith('close')
      })
    })

    it.skip('waits for pending app-settings persistence before confirm-dialog discard close', async () => {
      let closeRequestedCallback: (() => Promise<boolean>) | undefined
      mockApi.window.onCloseRequested.mockImplementation((callback: () => Promise<boolean>) => {
        closeRequestedCallback = callback
        return vi.fn()
      })

      const project = createProject('a', '/workspace/a', 'blue')
      mockUseProjects.mockReturnValue([project])
      mockUseActiveProject.mockReturnValue(project)
      mockUseActiveProjectId.mockReturnValue('a')

      const dirtyEditorState = {
        activeFilePath: '/workspace/a/src/file.ts',
        openFiles: new Map([
          [
            '/workspace/a/src/file.ts',
            {
              filePath: '/workspace/a/src/file.ts',
              isDirty: true
            }
          ]
        ]),
        getDirtyFileCount: vi.fn(() => 1),
        saveAllDirty: vi.fn().mockResolvedValue(undefined),
        closeFile: vi.fn(),
        saveFile: vi.fn().mockResolvedValue(true)
      }

      const useEditorStoreModule = await import('@/stores/editor-store')
      const getStateSpy = vi.spyOn(useEditorStoreModule.useEditorStore, 'getState').mockReturnValue(
        dirtyEditorState as unknown as ReturnType<typeof useEditorStoreModule.useEditorStore.getState>
      )

      renderWithRouter()
      expect(closeRequestedCallback).toBeDefined()
      if (!closeRequestedCallback) throw new Error('close callback missing')

      await expect(closeRequestedCallback()).resolves.toBe(false)

      const dontSaveButton = await screen.findByRole('button', { name: "Don't Save" })

      let resolveWait: (() => void) | undefined
      mockWaitForPendingAppSettingsPersistence.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWait = resolve
          })
      )

      await act(async () => {
        fireEvent.click(dontSaveButton)
      })

      expect(mockApi.window.respondToClose).not.toHaveBeenCalled()
      resolveWait?.()
      await waitFor(() => {
        expect(mockApi.window.respondToClose).toHaveBeenCalledWith('close')
      })

      getStateSpy.mockRestore()
    })

    it.skip('still closes when waiting for app-settings persistence rejects', async () => {
      let closeRequestedCallback: (() => Promise<boolean>) | undefined
      mockApi.window.onCloseRequested.mockImplementation((callback: () => Promise<boolean>) => {
        closeRequestedCallback = callback
        return vi.fn()
      })

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const project = createProject('a', '/workspace/a', 'blue')
      mockUseProjects.mockReturnValue([project])
      mockUseActiveProject.mockReturnValue(project)
      mockUseActiveProjectId.mockReturnValue('a')

      mockWaitForPendingAppSettingsPersistence.mockRejectedValueOnce(new Error('settings flush failed'))

      renderWithRouter()
      expect(closeRequestedCallback).toBeDefined()
      if (!closeRequestedCallback) throw new Error('close callback missing')

      await expect(closeRequestedCallback()).resolves.toBe(false)

      await waitFor(() => {
        expect(mockApi.window.respondToClose).toHaveBeenCalledWith('close')
      })
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to wait for app settings persistence before close:',
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })
  })

  describe('Project switch watcher orchestration', () => {
    it.skip('watches unrelated roots across project switches and unwatches old root', async () => {
      const projects = [
        createProject('a', '/workspace/a', 'blue'),
        createProject('b', '/outside/b', 'green')
      ]

      mockUseProjects.mockReturnValue(projects)
      mockUseTerminals.mockReturnValue([])
      mockUseAllTerminals.mockReturnValue([])
      mockUseActiveTerminal.mockReturnValue(null)
      mockUseActiveTerminalId.mockReturnValue('')

      mockUseActiveProject.mockReturnValue(projects[0])
      mockUseActiveProjectId.mockReturnValue('a')

      const view = renderWithRouter()

      await waitFor(() => {
        expect(mockApi.filesystem.watchDirectory).toHaveBeenCalledWith('/workspace/a')
      })

      mockUseActiveProject.mockReturnValue(projects[1])
      mockUseActiveProjectId.mockReturnValue('b')
      view.rerender(
        <TooltipProvider>
          <MemoryRouter initialEntries={['/']}>
            <WorkspaceLayout />
          </MemoryRouter>
        </TooltipProvider>
      )

      await waitFor(() => {
        expect(mockApi.filesystem.watchDirectory).toHaveBeenCalledWith('/outside/b')
      })

      expect(mockApi.filesystem.unwatchDirectory).toHaveBeenCalledWith('/workspace/a')
    })

    it.skip('ignores stale async watch completion from older project switch', async () => {
      let resolveFirstWatch: (value: { success: boolean }) => void = () => undefined
      mockApi.filesystem.watchDirectory
        .mockImplementationOnce(
          () =>
            new Promise<{ success: boolean }>((resolve) => {
              resolveFirstWatch = resolve
            })
        )
        .mockResolvedValueOnce({ success: true })

      const projects = [
        createProject('a', '/workspace/a', 'blue'),
        createProject('c', '/workspace/c', 'purple')
      ]

      mockUseProjects.mockReturnValue(projects)
      mockUseTerminals.mockReturnValue([])
      mockUseAllTerminals.mockReturnValue([])
      mockUseActiveTerminal.mockReturnValue(null)
      mockUseActiveTerminalId.mockReturnValue('')

      mockUseActiveProject.mockReturnValue(projects[0])
      mockUseActiveProjectId.mockReturnValue('a')
      const view = renderWithRouter()

      mockUseActiveProject.mockReturnValue(projects[1])
      mockUseActiveProjectId.mockReturnValue('c')
      view.rerender(
        <TooltipProvider>
          <MemoryRouter initialEntries={['/']}>
            <WorkspaceLayout />
          </MemoryRouter>
        </TooltipProvider>
      )

      await waitFor(() => {
        expect(mockApi.filesystem.watchDirectory).toHaveBeenCalledWith('/workspace/c')
      })

      resolveFirstWatch({ success: true })

      await waitFor(() => {
        expect(mockApi.filesystem.unwatchDirectory).toHaveBeenCalledWith('/workspace/a')
      })
    })

    it.skip('does not re-run terminal sync when terminal ids stay unchanged across rerenders', async () => {
      const projects = [createProject('a', '/workspace/a', 'blue')]
      const terminal = {
        id: 'terminal-a',
        projectId: 'a',
        name: 'Terminal A',
        shell: 'bash',
        ptyId: 'pty-a'
      } as Terminal

      mockUseProjects.mockReturnValue(projects)
      mockUseTerminals.mockReturnValue([terminal])
      mockUseAllTerminals.mockReturnValue([terminal])
      mockUseActiveTerminal.mockReturnValue(terminal)
      mockUseActiveTerminalId.mockReturnValue('terminal-a')
      mockUseActiveProject.mockReturnValue(projects[0])
      mockUseActiveProjectId.mockReturnValue('a')

      const view = renderWithRouter()

      await waitFor(() => {
        expect(mockApi.terminal.onData).toHaveBeenCalledTimes(1)
      })

      const consoleLogSpy = vi.spyOn(console, 'log')
      const initialSyncCalls = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).includes('[WorkspaceLayout] syncTerminalTabs CALL')
      ).length

      view.rerender(
        <TooltipProvider>
          <MemoryRouter initialEntries={['/']}>
            <WorkspaceLayout />
          </MemoryRouter>
        </TooltipProvider>
      )

      await new Promise((resolve) => setTimeout(resolve, 0))

      const syncCallsAfter = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).includes('[WorkspaceLayout] syncTerminalTabs CALL')
      ).length

      expect(syncCallsAfter).toBe(initialSyncCalls)
      consoleLogSpy.mockRestore()
    })
  })
})
