import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAcpStore } from '@/stores/acp-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'
import { StatusBar } from './StatusBar'

const { signalsRef } = vi.hoisted(() => ({
  signalsRef: {
    current: {
      attentionCounts: {} as Record<string, number>,
      firstNeedsYouSessionId: {} as Record<string, string>,
      runningProjectIds: new Set<string>()
    }
  }
}))

vi.mock('@/hooks/use-agent-chat-attention', () => ({
  useAgentChatProjectSignals: () => signalsRef.current
}))

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
  })),
  useTerminalStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      activeTerminalId: 'test-terminal',
      updateTerminalGitBranch: vi.fn()
    })
  )
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      updateProject: vi.fn()
    })
  )
}))

vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: {
    branches: vi.fn(() => Promise.resolve({ success: true, data: [] }))
  }
}))

// Mock remote status store (StatusBar hosts RemoteAccessPopover)
vi.mock('@/stores/remote-status-store', () => ({
  useRemoteStatus: vi.fn(() => null),
  useRemoteStatusStore: vi.fn(() => ({ setStatus: vi.fn() }))
}))

vi.mock('@/lib/api', () => ({
  remoteServerApi: {
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn()
  },
  openerApi: {
    openUrlWithSystemBrowser: vi.fn(() => Promise.resolve({ success: true, data: undefined }))
  }
}))

// Mock the home directory hook
vi.mock('@/hooks/use-cwd', () => ({
  useHomeDirectory: vi.fn(() => '/home/user'),
  formatPath: vi.fn((path: string, homeDir: string) => {
    if (path.startsWith(homeDir)) {
      return `~${path.slice(homeDir.length)}`
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
    it('should render git branch picker when showGitBranch is true', () => {
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.getByText('feature-branch')).toBeDefined()
      expect(screen.getByLabelText('Switch git branch')).toBeDefined()
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

      expect(screen.getByText('Exit 0')).toBeDefined()
    })

    it('should not render exit code when showExitCode is false', () => {
      useContextBarSettingsStore.setState({
        settings: { ...DEFAULT_CONTEXT_BAR_SETTINGS, showExitCode: false }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.queryByText('Exit 0')).toBeNull()
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
      expect(screen.queryByText('Exit 0')).toBeNull()
    })
  })

  describe('quiet bar (redesign)', () => {
    it('uses the card surface with a top hairline, not the project fill', () => {
      const { container } = renderWithProviders(<StatusBar project={mockProject} />)
      const bar = container.querySelector('[data-status-bar]')
      expect(bar?.className).toContain('bg-card')
      expect(bar?.className).toContain('border-t')
      expect(bar?.className).toContain('text-muted-foreground')
      expect(bar?.className).not.toContain('bg-status-bar')
      expect(bar?.className).not.toContain('text-primary-foreground')
    })

    it('keeps the quiet surface without a project', () => {
      const { container } = renderWithProviders(<StatusBar project={undefined} />)
      const bar = container.querySelector('[data-status-bar]')
      expect(bar?.className).toContain('bg-card')
      expect(bar?.className).not.toContain('bg-status-bar')
    })

    it('carries the project colour in the glyph', () => {
      const { container } = renderWithProviders(<StatusBar project={mockProject} />)
      expect(container.querySelector('[data-project-color="blue"]')).not.toBeNull()
    })

    it('renders the project item as a static label (no hover wash)', () => {
      renderWithProviders(<StatusBar project={mockProject} />)
      const item = screen.getByText('test-project').parentElement
      expect(item?.className).toContain('cursor-default')
      expect(item?.className).not.toContain('hover:bg-foreground/[0.03]')
    })

    it('does not render a primary-foreground hover wash on any item', () => {
      const { container } = renderWithProviders(<StatusBar project={mockProject} />)
      expect(container.innerHTML).not.toContain('primary-foreground/10')
      expect(container.innerHTML).not.toContain('primary-foreground/20')
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

  describe('remote access popover', () => {
    it('hides the remote access trigger on web (#843)', () => {
      // Desktop-only surface (desktop shared-live host status): jsdom has
      // no __TAURI_INTERNALS__, so isTauriContext() is false here and the
      // trigger must not render at all on a termul-served web page.
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.queryByLabelText('Remote terminal access')).toBeNull()
    })
  })
  // Story 10 (F1): the global web connection-health lamp lives in the
  // StatusBar. jsdom has no __TAURI_INTERNALS__, so isTauriContext() is
  // false and the indicator renders (web mode).
  describe('connection status indicator (Story 10)', () => {
    beforeEach(() => {
      useConnectionStatusStore.setState({
        controlChannel: 'connected',
        terminalChannel: 'connected'
      })
    })

    it('renders the connection lamp on web', () => {
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
    })

    it('reflects a degraded channel (control reconnecting)', () => {
      useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(
        screen.getByRole('status', { name: 'Control channel: reconnecting' })
      ).toBeInTheDocument()
    })
  })

  describe('needs-you pill', () => {
    afterEach(() => {
      signalsRef.current = {
        attentionCounts: {},
        firstNeedsYouSessionId: {},
        runningProjectIds: new Set<string>()
      }
    })

    it('is hidden when no chat needs attention', () => {
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.queryByText(/needs you/)).toBeNull()
    })

    it('names the chat and opens it on click', () => {
      signalsRef.current = {
        attentionCounts: { 'test-project': 1 },
        firstNeedsYouSessionId: { 'test-project': 'session-1' },
        runningProjectIds: new Set<string>()
      }
      useAcpStore.setState({
        sessions: {
          ...useAcpStore.getState().sessions,
          'session-1': { title: 'Fix login' } as never
        }
      })
      const addAgentChatTab = vi.fn()
      const prevAdd = useWorkspaceStore.getState().addAgentChatTab
      useWorkspaceStore.setState({ addAgentChatTab })
      try {
        renderWithProviders(<StatusBar project={mockProject} />)
        const pill = screen.getByRole('button', { name: 'Fix login needs you' })
        expect(pill.className).toContain('bg-warning/10')
        fireEvent.click(pill)
        expect(addAgentChatTab).toHaveBeenCalledWith('session-1')
      } finally {
        useWorkspaceStore.setState({ addAgentChatTab: prevAdd })
      }
    })
  })
})
