import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorkspaceLayout from './WorkspaceLayout'
import type { Project, Terminal } from '@/types/project'

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
  setTerminalPtyId: vi.fn()
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

vi.mock('@/stores/keyboard-shortcuts-store', () => ({
  useKeyboardShortcutsStore: vi.fn(() => ({
    shortcuts: {
      commandPalette: { customKey: 'Ctrl+K', defaultKey: 'Ctrl+K' },
      commandPaletteAlt: { customKey: 'Ctrl+Shift+P', defaultKey: 'Ctrl+Shift+P' },
      terminalSearch: { customKey: 'Ctrl+F', defaultKey: 'Ctrl+F' },
      commandHistory: { customKey: 'Ctrl+R', defaultKey: 'Ctrl+R' },
      newProject: { customKey: 'Ctrl+N', defaultKey: 'Ctrl+N' },
      newTerminal: { customKey: 'Ctrl+T', defaultKey: 'Ctrl+T' },
      nextTerminal: { customKey: 'Ctrl+Tab', defaultKey: 'Ctrl+Tab' },
      prevTerminal: { customKey: 'Ctrl+Shift+Tab', defaultKey: 'Ctrl+Shift+Tab' },
      zoomIn: { customKey: 'Ctrl+=', defaultKey: 'Ctrl+=' },
      zoomOut: { customKey: 'Ctrl+-', defaultKey: 'Ctrl+-' },
      zoomReset: { customKey: 'Ctrl+0', defaultKey: 'Ctrl+0' }
    }
  })),
  matchesShortcut: vi.fn(() => false)
}))

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
  useCommandHistory: vi.fn(() => [])
}))

vi.mock('@/hooks/use-app-settings', () => ({
  useUpdateAppSetting: vi.fn(() => vi.fn())
}))

// Mock window.api
const mockApi = {
  keyboard: {
    onShortcut: vi.fn(() => vi.fn())
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
    read: vi.fn(() => Promise.resolve({ success: true, data: null }))
  }
}

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

  describe('No Terminals Empty State', () => {
    beforeEach(() => {
      // Set up a project but no terminals
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

    it('should render no terminals empty state when project exists but has no terminals', () => {
      renderWithRouter()

      expect(screen.getByText('No Terminals Yet')).toBeInTheDocument()
    })

    it('should show descriptive message about creating first terminal', () => {
      renderWithRouter()

      expect(
        screen.getByText('Create a terminal to start running commands and managing your project')
      ).toBeInTheDocument()
    })

    it('should have a button to create first terminal', () => {
      renderWithRouter()

      const button = screen.getByText('Create Your First Terminal')
      expect(button).toBeInTheDocument()
      expect(button.tagName).toBe('BUTTON')
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

    it('should center no terminals empty state', () => {
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

      const emptyStateContainer = screen.getByText('No Terminals Yet').closest('div')?.parentElement
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

    it('should show no terminals state when project exists but has no terminals', () => {
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
      expect(screen.getByText('No Terminals Yet')).toBeInTheDocument()
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
})
