import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RECONNECT_GRACE_MS } from '@/hooks/use-delayed-flag'
import { openAgentChatInOwnProject } from '@/lib/open-agent-chat'
import { normalizePath, type WorkingCopy } from '@/lib/working-copy'
import { useAcpStore } from '@/stores/acp-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { useGitStatusStore } from '@/stores/git-status-store'
import type { Project } from '@/types/project'
import { type ContextBarSettings, DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'
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

const {
  wcRef,
  updateProjectMock,
  updateTerminalGitBranchMock,
  refreshWorkingCopyMock,
  pickerProps,
  terminalRef
} = vi.hoisted(() => ({
  wcRef: { current: null as unknown },
  updateProjectMock: vi.fn(),
  updateTerminalGitBranchMock: vi.fn(),
  refreshWorkingCopyMock: vi.fn(async () => {}),
  pickerProps: { current: null as Record<string, unknown> | null },
  terminalRef: { current: {} as Record<string, unknown> }
}))

vi.mock('@/hooks/use-active-working-copy', () => ({
  useActiveWorkingCopy: () => wcRef.current
}))

// Keep the real picker but capture the props StatusBar hands it.
vi.mock('@/components/GitBranchPicker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/GitBranchPicker')>()
  return {
    GitBranchPicker: (props: Record<string, unknown>) => {
      pickerProps.current = props
      return actual.GitBranchPicker(props as never)
    }
  }
})

vi.mock('@/lib/open-agent-chat', () => ({ openAgentChatInOwnProject: vi.fn() }))

vi.mock('@/hooks/use-agent-chat-attention', () => ({
  useAgentChatProjectSignals: () => signalsRef.current
}))

// Mock the terminal store
vi.mock('@/stores/terminal-store', () => ({
  useActiveTerminal: vi.fn(() => ({
    id: 'test-terminal',
    projectId: 'test-project',
    cwd: '/home/user/project',
    gitBranch: 'feature-branch',
    gitStatus: {
      hasChanges: true,
      modified: 2,
      staged: 1,
      untracked: 3
    },
    lastExitCode: 0,
    ...terminalRef.current
  })),
  useTerminalStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      activeTerminalId: 'test-terminal',
      updateTerminalGitBranch: updateTerminalGitBranchMock
    })
  )
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      updateProject: updateProjectMock
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

const WT_PATH = '/home/user/project'

function resolvedWorktree(path = WT_PATH): WorkingCopy {
  return { state: 'resolved', kind: 'worktree', key: normalizePath(path), path, worktreeId: 'w1' }
}

function seedGit(path: string, branch: string | null = 'feature-branch'): void {
  const key = normalizePath(path)
  useGitStatusStore.setState({
    refreshWorkingCopy: refreshWorkingCopyMock,
    commitContexts: {
      [key]: {
        branch,
        hasUpstream: true,
        ahead: 4,
        behind: 5,
        stagedCount: 1,
        hasHead: true,
        lastSubject: '',
        lastBody: ''
      }
    },
    statuses: {
      [key]: [
        { path: 'a.ts', status: 'modified', staged: false },
        { path: 'b.ts', status: 'modified', staged: false },
        { path: 'c.ts', status: 'added', staged: true },
        { path: 'u1', status: 'untracked', staged: false },
        { path: 'u2', status: 'untracked', staged: false },
        { path: 'u3', status: 'untracked', staged: false }
      ]
    }
  })
}

beforeEach(() => {
  wcRef.current = resolvedWorktree()
  seedGit(WT_PATH)
  refreshWorkingCopyMock.mockClear()
  updateProjectMock.mockClear()
  updateTerminalGitBranchMock.mockClear()
  pickerProps.current = null
  terminalRef.current = {}
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

function showSettings(overrides: Partial<ContextBarSettings> = {}): void {
  useContextBarSettingsStore.setState({
    settings: {
      ...DEFAULT_CONTEXT_BAR_SETTINGS,
      showProjectName: true,
      showGitStatus: true,
      ...overrides
    }
  })
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
      showSettings()
      renderWithProviders(<StatusBar project={mockProject} />)

      // Check for modified count (2)
      expect(screen.getByText('2')).toBeDefined()
    })

    it('should not render git status when showGitStatus is false', () => {
      showSettings({ showGitStatus: false })

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

    it('hides project name and file counts by default but keeps branch, directory and exit code', () => {
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.queryByText('test-project')).toBeNull()
      expect(screen.queryByText('2')).toBeNull()
      expect(screen.getByText('feature-branch')).toBeDefined()
      expect(screen.getByText('~/project')).toBeDefined()
      expect(screen.getByText('Exit 0')).toBeDefined()
    })

    it('shows the project name and file counts when switched on', () => {
      showSettings()
      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.getByText('test-project')).toBeDefined()
      expect(screen.getByText('2')).toBeDefined()
    })

    it('should hide all optional elements when all settings are false', () => {
      useContextBarSettingsStore.setState({
        settings: {
          showProjectName: false,
          showGitBranch: false,
          showGitStatus: false,
          showWorkingDirectory: false,
          showExitCode: false
        }
      })

      renderWithProviders(<StatusBar project={mockProject} />)

      expect(screen.queryByText('test-project')).toBeNull()
      expect(screen.queryByText('feature-branch')).toBeNull()
      expect(screen.queryByText('~/project')).toBeNull()
      expect(screen.queryByText('Exit 0')).toBeNull()
    })
  })

  describe('working copy (CAP-7)', () => {
    beforeEach(() => {
      showSettings()
    })

    const projectFolder = (): WorkingCopy => ({
      state: 'resolved',
      kind: 'project',
      key: normalizePath(mockProject.path),
      path: mockProject.path,
      worktreeId: null
    })

    it('reads branch, ahead/behind and counts from the git cache of the working copy', () => {
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getByText('feature-branch')).toBeDefined()
      expect(pickerProps.current).toMatchObject({
        repoPath: WT_PATH,
        currentBranch: 'feature-branch',
        ahead: 4,
        behind: 5
      })
      // 2 modified, 1 staged, 3 untracked
      expect(screen.getByText('2')).toBeDefined()
      expect(screen.getByText('1')).toBeDefined()
      expect(screen.getByText('3')).toBeDefined()
    })

    it('counts a file that is both staged and modified once per bucket', () => {
      useGitStatusStore.setState({
        statuses: {
          [normalizePath(WT_PATH)]: [
            { path: 'a.ts', status: 'modified', staged: true },
            { path: 'a.ts', status: 'modified', staged: false }
          ]
        }
      })
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getAllByText('1')).toHaveLength(2)
      expect(screen.queryByText('2')).toBeNull()
    })

    it('tracks the working copy through refreshWorkingCopy', () => {
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(refreshWorkingCopyMock).toHaveBeenCalledWith(WT_PATH)
    })

    it('falls back to project.gitBranch only for the project folder', () => {
      wcRef.current = projectFolder()
      useGitStatusStore.setState({ commitContexts: {} })
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getByText('main')).toBeDefined()
    })

    it('does not fall back to project.gitBranch for a worktree', () => {
      useGitStatusStore.setState({ commitContexts: {} })
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.queryByText('main')).toBeNull()
      expect(screen.getByText('detached')).toBeDefined()
    })

    it('shows no branch picker and no counts when the working copy is unresolved', () => {
      wcRef.current = {
        state: 'unresolved',
        key: '/home/user/test-project/.termul/worktrees/gone',
        path: '/home/user/test-project/.termul/worktrees/gone'
      }
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.queryByLabelText('Switch git branch')).toBeNull()
      expect(screen.queryByText('feature-branch')).toBeNull()
      expect(screen.queryByText('main')).toBeNull()
      expect(screen.queryByText('2')).toBeNull()
      expect(refreshWorkingCopyMock).not.toHaveBeenCalled()
    })

    it('shows the unresolved path instead of the project folder', () => {
      wcRef.current = {
        state: 'unresolved',
        key: '/home/user/test-project/.termul/worktrees/gone',
        path: '/home/user/test-project/.termul/worktrees/gone'
      }
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getByText('~/test-project/.termul/worktrees/gone')).toBeDefined()
      expect(screen.queryByText('~/test-project')).toBeNull()
    })

    it('keeps a detached HEAD instead of falling back to project.gitBranch', () => {
      wcRef.current = projectFolder()
      seedGit(mockProject.path, null)
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getByText('detached')).toBeDefined()
      expect(screen.queryByText('main')).toBeNull()
    })

    it('hides the branch picker for a non-git project folder', () => {
      wcRef.current = projectFolder()
      renderWithProviders(<StatusBar project={{ ...mockProject, isGitRepo: false }} />)
      expect(screen.queryByLabelText('Switch git branch')).toBeNull()
      expect(pickerProps.current).toBeNull()
      expect(refreshWorkingCopyMock).not.toHaveBeenCalled()
    })

    it('shows the project path with no resolved working copy', () => {
      wcRef.current = null
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getByText('~/test-project')).toBeDefined()
    })

    it('refreshes the cache and leaves project.gitBranch alone after a worktree branch change', () => {
      renderWithProviders(<StatusBar project={mockProject} />)
      refreshWorkingCopyMock.mockClear()
      ;(pickerProps.current?.onBranchChanged as (branch: string) => void)('other')
      expect(refreshWorkingCopyMock).toHaveBeenCalledWith(WT_PATH)
      expect(updateProjectMock).not.toHaveBeenCalled()
      expect(updateTerminalGitBranchMock).not.toHaveBeenCalled()
    })

    it('still records the branch on the project for a project-folder checkout', () => {
      wcRef.current = projectFolder()
      terminalRef.current = { cwd: mockProject.path }
      renderWithProviders(<StatusBar project={mockProject} />)
      ;(pickerProps.current?.onBranchChanged as (branch: string) => void)('other')
      expect(updateProjectMock).toHaveBeenCalledWith('test-project', { gitBranch: 'other' })
      expect(updateTerminalGitBranchMock).toHaveBeenCalledWith('test-terminal', 'other')
    })

    it('does not touch a terminal outside the checked-out working copy or project', () => {
      wcRef.current = projectFolder()
      renderWithProviders(<StatusBar project={mockProject} />)
      const change = pickerProps.current?.onBranchChanged as (branch: string) => void
      // Terminal cwd (/home/user/project) is another folder than the working copy.
      change('other')
      expect(updateTerminalGitBranchMock).not.toHaveBeenCalled()
      terminalRef.current = { cwd: mockProject.path, projectId: 'someone-else' }
      renderWithProviders(<StatusBar project={mockProject} />)
      ;(pickerProps.current?.onBranchChanged as (branch: string) => void)('other')
      expect(updateTerminalGitBranchMock).not.toHaveBeenCalled()
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
      showSettings()
      const { container } = renderWithProviders(<StatusBar project={mockProject} />)
      expect(container.querySelector('[data-project-color="blue"]')).not.toBeNull()
    })

    it('renders the project item as a static label (no hover wash)', () => {
      showSettings()
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

  describe('project name visibility', () => {
    it('renders the project name when showProjectName is on, whatever else is off', () => {
      useContextBarSettingsStore.setState({
        settings: {
          showProjectName: true,
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
      vi.useFakeTimers()
      useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
      vi.advanceTimersByTime(RECONNECT_GRACE_MS)
      vi.useRealTimers()
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
      renderWithProviders(<StatusBar project={mockProject} />)
      const pill = screen.getByRole('button', { name: 'Fix login needs you' })
      expect(pill.className).toContain('bg-warning/10')
      fireEvent.click(pill)
      // Opens in the chat's own project (switching when it is another one).
      expect(openAgentChatInOwnProject).toHaveBeenCalledWith('session-1', 'StatusBar.NeedsYouPill')
    })
  })

  describe('Terminal button', () => {
    it('is shown for an open project', () => {
      renderWithProviders(<StatusBar project={mockProject} />)
      expect(screen.getByRole('button', { name: `Open terminal at ${WT_PATH}` })).toBeTruthy()
    })

    it('is absent without a project', () => {
      renderWithProviders(<StatusBar project={undefined} />)
      expect(screen.queryByRole('button', { name: /Open terminal at/ })).toBeNull()
    })
  })
})
