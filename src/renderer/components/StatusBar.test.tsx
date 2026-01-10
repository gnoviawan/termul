import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'
import type { Project } from '@/types/project'

// Mock the terminal store
vi.mock('@/stores/terminal-store', () => ({
  useActiveTerminal: vi.fn(() => ({
    id: 'test-terminal',
    cwd: '/home/user/project',
    gitBranch: 'feature-branch',
    gitStatus: {
      hasChanges: true,
      modified: 2,
      staged: 1,
      untracked: 3
    },
    lastExitCode: 0
  }))
}))

// Mock the home directory hook
vi.mock('@/hooks/use-cwd', () => ({
  useHomeDirectory: vi.fn(() => '/home/user'),
  formatPath: vi.fn((path: string, homeDir: string) => {
    if (path.startsWith(homeDir)) {
      return '~' + path.slice(homeDir.length)
    }
    return path
  })
}))

// Mock window.api
const mockApi = {
  persistence: {
    writeDebounced: vi.fn(() => Promise.resolve({ success: true, data: undefined }))
  }
}

beforeEach(() => {
  vi.stubGlobal('api', mockApi)
  // Reset store to defaults before each test
  useContextBarSettingsStore.setState({
    settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS },
    isLoaded: true
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const mockProject: Project = {
  id: 'test-project',
  name: 'Test Project',
  path: '/home/user/test-project',
  color: 'blue',
  gitBranch: 'main'
}

// Helper to render with required providers
function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe('StatusBar', () => {
  describe('conditional rendering based on visibility settings', () => {
    it('should render git branch when showGitBranch is true', () => {
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.getByText('feature-branch')).toBeDefined()
    })

    it('should not render git branch when showGitBranch is false', () => {
      useContextBarSettingsStore.setState({
        settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS, showGitBranch: false }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.queryByText('feature-branch')).toBeNull()
    })

    it('should render git status when showGitStatus is true and has changes', () => {
      renderWithProviders(<StatusBar project={mockProject} />)

      // Check for modified count (2)
      expect(screen.getByText('2')).toBeDefined()
    })

    it('should not render git status when showGitStatus is false', () => {
      useContextBarSettingsStore.setState({
        settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS, showGitStatus: false }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      // Should not find the git status numbers
      expect(screen.queryByText('2')).toBeNull()
    })

    it('should render working directory when showWorkingDirectory is true', () => {
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.getByText('~/project')).toBeDefined()
    })

    it('should not render working directory when showWorkingDirectory is false', () => {
      useContextBarSettingsStore.setState({
        settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS, showWorkingDirectory: false }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.queryByText('~/project')).toBeNull()
    })

    it('should render exit code when showExitCode is true', () => {
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.getByText('Exit: 0')).toBeDefined()
    })

    it('should not render exit code when showExitCode is false', () => {
      useContextBarSettingsStore.setState({
        settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS, showExitCode: false }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.queryByText('Exit: 0')).toBeNull()
    })

    it('should hide all optional elements when all settings are false', () => {
      useContextBarSettingsStore.setState({
        settings: {
          showGitBranch: false,
          showGitStatus: false,
          showWorkingDirectory: false,
          showExitCode: false
        }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      // Only project name should be visible
      expect(screen.getByText('test-project')).toBeDefined()
      expect(screen.queryByText('feature-branch')).toBeNull()
      expect(screen.queryByText('~/project')).toBeNull()
      expect(screen.queryByText('Exit: 0')).toBeNull()
    })
  })

  describe('project name always visible', () => {
    it('should always render project name regardless of settings', () => {
      useContextBarSettingsStore.setState({
        settings: {
          showGitBranch: false,
          showGitStatus: false,
          showWorkingDirectory: false,
          showExitCode: false
        }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.getByText('test-project')).toBeDefined()
    })
  })

  describe('settings gear icon', () => {
    it('should render the context bar settings popover trigger', () => {
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.getByLabelText('Context bar settings')).toBeDefined()
    })
  })
})
