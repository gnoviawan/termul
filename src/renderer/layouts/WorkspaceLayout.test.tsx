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
  useTerminalActions: () => mockUseTerminalActions()
}))

vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontSize: vi.fn(() => 14),
  useTerminalFontFamily: vi.fn(() => 'monospace'),
  useTerminalBufferSize: vi.fn(() => 10000),
  useDefaultShell: vi.fn(() => 'bash'),
  useMaxTerminalsPerProject: vi.fn(() => 10),
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
    sidebarToggle: { customKey: 'ctrl+shift+b', defaultKey: 'ctrl+shift+b' }
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

const { mockUpdatePanelVisibility, mockWaitForPendingAppSettingsPersistence } = vi.hoisted(() => ({
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

vi.mock('@/hooks/use-editor-persistence', () => ({
  useEditorPersistence: vi.fn(),
  persistState: vi.fn()
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
  // Reset mocks
  mockUseProjectsLoaded.mockReturnValue(true)
  mockUseProjects.mockReturnValue([])
  mockUseActiveProject.mockReturnValue(null)
  mockUseActiveProjectId.mockReturnValue('')
  mockUseTerminals.mockReturnValue([])
  mockUseAllTerminals.mockReturnValue([])
  mockUseActiveTerminal.mockReturnValue(null)
  mockUseActiveTerminalId.mockReturnValue('')
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
      <MemoryRouter initialEntries={initialEntries}>
        <WorkspaceLayout />
      </MemoryRouter>
    </TooltipProvider>
  )
}

describe('WorkspaceLayout - Empty States', () => {
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

    it('should render empty pane hint when project exists but has no tabs', () => {
      renderWithRouter()

      expect(screen.getByText('Drag a tab or file here')).toBeInTheDocument()
    })

    it('should show pane-level new terminal action', () => {
      renderWithRouter()

      expect(screen.getByTitle('New terminal (default shell)')).toBeInTheDocument()
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

    it('should center empty pane hint in workspace area', () => {
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

    it('should show empty pane hint when project exists but has no tabs', () => {
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

    it('should not show empty states when terminals exist', () => {
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

    it('keeps Ctrl+B toggling file explorer and persists globally', () => {
      renderWithRouter()

      fireEvent.keyDown(window, { key: 'b', ctrlKey: true })

      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', false)
    })

    it('toggles sidebar with configured sidebar shortcut and persists globally', () => {
      renderWithRouter()

      fireEvent.keyDown(window, { key: 'B', ctrlKey: true, shiftKey: true })

      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
    })

    it('does not toggle panel shortcuts when focus is in input', () => {
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
  })

  describe('Close flow persistence coordination', () => {
    it('waits for pending app-settings persistence before responding to close with no dirty files', async () => {
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

    it('waits for pending app-settings persistence before confirm-dialog discard close', async () => {
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
  })

  describe('Project switch watcher orchestration', () => {
    it('watches unrelated roots across project switches and unwatches old root', async () => {
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

    it('ignores stale async watch completion from older project switch', async () => {
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
  })
})
