import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tauriRef, mobileRef, projectRef } = vi.hoisted(() => ({
  // Mutable: mobile branch requires isTauriContext() === false.
  tauriRef: { current: false as boolean },
  // Mutable: gates the mobile shell render path.
  mobileRef: { current: true as boolean },
  // Mutable: the Git Changes button + git Sheet need an active project path.
  projectRef: {
    current: { id: 'p1', name: 'Demo', path: '/demo', color: 'blue', gitBranch: 'main' } as {
      path?: string
      name?: string
      id?: string
    }
  }
}))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767,
  resolveMobileWebShell: (_t: boolean, m: boolean) => m
}))

vi.mock('@/lib/platform', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform')>('@/lib/platform')
  return {
    ...actual,
    get isMac() {
      return false
    }
  }
})

vi.mock('@/stores/project-store', () => ({
  useProjectsLoaded: () => true,
  useProjects: () => [projectRef.current],
  useActiveProject: () => projectRef.current,
  useActiveProjectId: () => 'p1',
  useProjectActions: () => ({
    selectProject: vi.fn(),
    addProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    reorderProjects: vi.fn()
  }),
  useProjectStore: Object.assign(vi.fn(), {
    getState: () => ({
      projects: [],
      activeProjectId: 'p1',
      isLoaded: true,
      isWorktreeOperationLocked: false
    })
  })
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector) => selector({ terminals: [] })),
  useTerminals: () => [],
  useAllTerminals: () => [],
  useActiveTerminal: () => null,
  useActiveTerminalId: () => '',
  useTerminalActions: () => ({
    selectTerminal: vi.fn(),
    addTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    reorderTerminals: vi.fn(),
    setTerminalPtyId: vi.fn(),
    clearTerminalPtyId: vi.fn()
  }),
  useProjectsWithActivity: () => [],
  useProjectsWithErrors: () => new Set<string>(),
  cleanupProjectTerminals: vi.fn()
}))

vi.mock('@/stores/app-settings-store', () => ({
  useAppSettingsStore: vi.fn(
    (selector?: (state: { settings: { remoteBindMode: 'localhost' } }) => unknown) => {
      const state = { settings: { remoteBindMode: 'localhost' as const } }
      return selector ? selector(state) : state
    }
  ),
  useTerminalFontSize: vi.fn(() => 14),
  useUiZoomLevel: vi.fn(() => 1),
  useTerminalFontFamily: vi.fn(() => 'monospace'),
  useTerminalBufferSize: vi.fn(() => 10000),
  useDefaultShell: vi.fn(() => 'bash'),
  useMaxTerminalsPerProject: vi.fn(() => 10),
  useConfirmTerminalClose: vi.fn(() => true),
  useUpdateAppSetting: vi.fn(() => vi.fn()),
  useDefaultProjectColor: vi.fn(() => 'blue'),
  useColorTheme: vi.fn(() => 'termul'),
  useAppearanceMode: vi.fn(() => 'dark')
}))

vi.mock('@/stores/remote-status-store', () => ({
  useRemoteStatus: vi.fn(() => null),
  useRemoteStatusStore: Object.assign(vi.fn(), {
    getState: () => ({ setStatus: vi.fn() })
  })
}))

// workspace-store + editor-store + sidebar / file-explorer / theme-picker
// stores are imported as-real (matching the existing WorkspaceLayout.test.tsx
// pattern) so every selector hook (`useActiveTab`, `usePaneRoot`,
// `useFullscreenPaneId`, `useSidebarVisible`, `useFileExplorerVisible`, …) is
// defined. Their default/empty state is fine for the mobile branch.

vi.mock('@/stores/keyboard-shortcuts-store', () => ({
  useKeyboardShortcutsStore: vi.fn(
    (
      selector?: (state: {
        shortcuts: Record<string, { customKey: string; defaultKey: string }>
      }) => unknown
    ) => {
      const state = { shortcuts: { commandPalette: { customKey: 'ctrl+k', defaultKey: 'ctrl+k' } } }
      return selector ? selector(state) : state
    }
  ),
  matchesShortcut: () => false
}))

vi.mock('@/hooks/use-snapshots', () => ({
  useCreateSnapshot: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
  useSnapshotLoader: vi.fn()
}))

vi.mock('@/hooks/use-recent-commands', () => ({
  useRecentCommandsLoader: vi.fn(),
  useRecentCommandIds: vi.fn(() => []),
  useSaveRecentCommand: vi.fn()
}))

vi.mock('@/hooks/use-pinned-commands', () => ({
  usePinnedCommandsLoader: vi.fn(),
  usePinnedCommandIds: vi.fn(() => []),
  useTogglePinnedCommand: vi.fn()
}))

vi.mock('@/hooks/use-command-history', () => ({
  useCommandHistoryLoader: vi.fn(),
  useAddCommand: vi.fn(() => vi.fn()),
  useCommandHistory: vi.fn(() => []),
  useAllCommandHistory: vi.fn(() => [])
}))

// Stub CommandPalette to a marker so the mobile-branch threading test can
// assert the trigger flips `isCommandPaletteOpen` → `isOpen` without dragging
// in `cmdk` (whose scrollIntoView call is not implemented in jsdom). The real
// overlay rendering is covered in CommandPalette.test.tsx.
vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <input placeholder="Search commands, projects, settings..." readOnly /> : null
}))

// GitPanel dependencies (rendered inside the mobile git Sheet).
vi.mock('@/lib/git-api', () => ({ gitApi: { getDiff: vi.fn() } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/components/git/GitDiffView', () => ({ GitDiffView: () => null }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ selectedAgentConfigId: 'cfg-1', agentConfigs: [{ id: 'cfg-1' }] })
}))
const { gitState } = vi.hoisted(() => ({
  gitState: {
    statuses: {} as Record<string, unknown[]>,
    diffs: {},
    selectedFile: null,
    setSelectedFile: vi.fn(),
    refreshStatus: vi.fn(),
    fetchDiff: vi.fn(),
    stageFiles: vi.fn(),
    unstageFiles: vi.fn(),
    discardFiles: vi.fn(),
    commitContexts: {},
    fetchCommitContext: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    stashes: {},
    branches: {},
    fetchStashes: vi.fn(),
    fetchBranches: vi.fn(),
    stashSave: vi.fn(),
    stashApply: vi.fn(),
    stashPop: vi.fn(),
    stashDrop: vi.fn(),
    branchSwitch: vi.fn(),
    branchCreate: vi.fn()
  }
}))
vi.mock('@/stores/git-status-store', () => ({
  diffKey: (cwd: string, path: string, staged: boolean) => `${cwd}:${path}:${staged}`,
  useGitStatusStore: (selector: (s: Record<string, unknown>) => unknown) => selector(gitState)
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    remoteServerApi: { start: vi.fn(), stop: vi.fn(), status: vi.fn() },
    openerApi: { openUrlWithSystemBrowser: vi.fn(() => Promise.resolve({ success: true })) }
  }
})

// Stub heavy child components so the mobile shell renders without dragging in
// CodeMirror / xterm / page implementations.
vi.mock('@/components/workspace/PaneRenderer', () => ({
  PaneRenderer: () => <div data-pane-renderer-stub />
}))

// P17: shared canonical mock shape for the Story 6 sync hook + banner —
// identical inline factories across the three WorkspaceLayout suites.
vi.mock('@/hooks/use-workspace-manifest-sync', () => ({
  useWorkspaceManifestSync: vi.fn(),
  loadWorkspaceManifest: vi.fn().mockResolvedValue(false),
  resolveManifestConflict: vi.fn().mockResolvedValue(undefined),
  performManifestWrite: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/components/workspace/WorkspaceConflictBanner', () => ({
  WorkspaceConflictBanner: () => <div data-testid="workspace-conflict-banner" />
}))
vi.mock('@/pages/WorkspaceDashboard', () => ({ default: () => <div>dashboard</div> }))
vi.mock('@/pages/WorkspaceSnapshots', () => ({ default: () => <div>snapshots</div> }))
vi.mock('@/pages/AppPreferences', () => ({ AppPreferencesModal: () => <div>preferences</div> }))
vi.mock('@/pages/ProjectSettings', () => ({
  ProjectSettingsModal: () => <div>project-settings</div>
}))
vi.mock('@/components/TermulMark', () => ({ TermulMark: () => <span>mark</span> }))
vi.mock('@/components/chat/ChatHistoryTab', () => ({
  ChatHistoryTab: () => <div>history</div>
}))
vi.mock('@/components/chat/ProjectSwitcherDrawer', () => ({
  ProjectSwitcherDrawer: () => null
}))
vi.mock('@/components/mobile/MobileFileExplorer', () => ({
  MobileFileExplorer: () => null
}))
vi.mock('@/components/mobile/MobileTerminalControls', () => ({
  MobileTerminalControls: () => null
}))

// CAP-6 Patch 3: SSH workspace lazy/Suspense boundary test.
// Stub SSHWorkspace + SSHFileExplorer so the lazy chunks resolve to
// lightweight markers. The ssh-store and ssh-connection hooks are stubbed
// with a controllable profile ref so the SSH render path activates.
const { sshProfileRef } = vi.hoisted(() => ({
  sshProfileRef: {
    current: null as {
      id: string
      name: string
      host: string
      username: string
      password: string
    } | null
  }
}))

vi.mock('@/stores/ssh-store', () => ({
  useActiveSSHProfile: () => sshProfileRef.current,
  useActiveSSHProfileId: () => (sshProfileRef.current ? 'ssh-1' : null),
  useSSHActions: () => ({
    loadProfiles: vi.fn(),
    saveProfile: vi.fn(),
    deleteProfile: vi.fn(),
    importConfig: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    startPortForward: vi.fn(),
    stopPortForward: vi.fn(),
    clearCompletedTransfers: vi.fn(),
    selectProfile: vi.fn(),
    markConnecting: vi.fn(),
    markDisconnected: vi.fn(),
    updateConnectionId: vi.fn(),
    updateConnectionStatusByProfile: vi.fn(),
    setEditingFile: vi.fn()
  }),
  useSSHProfiles: () => [],
  useSSHStore: Object.assign(vi.fn(), {
    getState: () => ({ profiles: [], activeSSHProfileId: null })
  })
}))

vi.mock('@/hooks/use-ssh-connection', () => ({
  useSSHConnection: () => ({
    connectionId: 'conn-1',
    isConnected: true,
    sftpReady: true,
    entries: [],
    currentPath: '/home',
    expandedDirs: new Set(),
    childEntries: {},
    loadingDirs: new Set(),
    isLoadingRoot: false,
    handleConnect: vi.fn(),
    handleBrowseFiles: vi.fn(),
    toggleDirectory: vi.fn(),
    loadDirectory: vi.fn()
  })
}))

vi.mock('@/components/ssh/SSHWorkspace', () => ({
  SSHWorkspace: ({ profile }: { profile: { name?: string } }) => (
    <div data-testid="ssh-workspace-stub">SSH: {profile?.name}</div>
  )
}))

vi.mock('@/components/ssh/SSHFileExplorer', () => ({
  SSHFileExplorer: () => <div data-testid="ssh-file-explorer-stub" />
}))

import WorkspaceLayout from './WorkspaceLayout'

describe('WorkspaceLayout mobile branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriRef.current = false
    mobileRef.current = true
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo', color: 'blue', gitBranch: 'main' }
    gitState.statuses = {}
    gitState.selectedFile = null
    gitState.commitContexts = {}
    sshProfileRef.current = null
  })

  it('mounts MobileChatShell and threads the command-palette + git-changes triggers', async () => {
    render(
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    )

    // MobileChatShell is React.lazy — wait for it to load before asserting.
    await waitFor(() => expect(document.querySelector('[data-mobile-chat-shell]')).toBeTruthy())
    expect(screen.getByLabelText('Command palette')).toBeInTheDocument()
    expect(screen.getByLabelText('Git changes')).not.toBeDisabled()
  })

  it('opens the CommandPalette overlay when the mobile trigger is tapped', async () => {
    render(
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    )

    expect(
      screen.queryByPlaceholderText('Search commands, projects, settings...')
    ).not.toBeInTheDocument()
    // MobileChatShell is React.lazy — wait for the trigger button to appear.
    fireEvent.click(await screen.findByLabelText('Command palette'))
    expect(
      await screen.findByPlaceholderText('Search commands, projects, settings...')
    ).toBeInTheDocument()
  })

  it('opens the Git Changes Sheet with the mobile GitPanel file list when the trigger is tapped', async () => {
    render(
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    )

    // Sheet starts closed: the GitPanel file-list filter input is absent.
    expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
    // MobileChatShell is React.lazy — wait for the trigger button to appear.
    fireEvent.click(await screen.findByLabelText('Git changes'))
    // GitPanel mobile branch renders the file-list filter input (full-width).
    expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()
  })

  it('disables the Git changes trigger when no active project path', async () => {
    projectRef.current = { id: 'p1', name: 'Demo' }
    render(
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    )
    // MobileChatShell is React.lazy — wait for the trigger to appear.
    expect(await screen.findByLabelText('Git changes')).toBeDisabled()
  })

  it('closes the Git Changes sheet if the active project loses its path while open', async () => {
    const { rerender } = render(
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    )

    // MobileChatShell is React.lazy — wait for the trigger to appear.
    fireEvent.click(await screen.findByLabelText('Git changes'))
    expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()

    // Active project switches to one without a path while the sheet is open.
    projectRef.current = { id: 'p2', name: 'NoPath' }
    rerender(
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    )

    // The guard effect closes the sheet → GitPanel file list unmounts.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
    )
  })
})

describe('WorkspaceLayout SSH workspace lazy/Suspense boundary (CAP-6 Patch 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriRef.current = false
    mobileRef.current = true
    projectRef.current = {
      id: 'p1',
      name: 'Demo',
      path: '/demo',
      color: 'blue',
      gitBranch: 'main'
    }
    sshProfileRef.current = {
      id: 'ssh-1',
      name: 'Test SSH',
      host: 'example.com',
      username: 'user',
      password: 'pass'
    }
  })

  it('renders SSHWorkspace through React.lazy + <Suspense> when an SSH profile is active', async () => {
    render(
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    )

    // SSHWorkspace is React.lazy — <Suspense> shows ShellSkeleton first, then
    // the lazy chunk resolves and the SSH workspace renders. MobileChatShell
    // (also lazy) wraps workspaceMain which contains the SSH render site.
    const ssh = await screen.findByTestId('ssh-workspace-stub')
    expect(ssh).toBeInTheDocument()
    expect(ssh).toHaveTextContent('Test SSH')
  })
})
