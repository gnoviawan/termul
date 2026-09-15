import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MOBILE_WEB_SHELL_MAX_PX } from '@/hooks/use-mobile-web-shell'

// Story 12 (CAP-8, QA finding F3): regression test for the REAL
// `useMobileWebShell` breakpoint detection. The sibling suites
// (`WorkspaceLayout.mobile.test.tsx`) mock `@/hooks/use-mobile-web-shell`
// away, so a breakpoint-detection regression (wrong query, broken
// matchMedia read, Tauri mis-detection) would render the desktop IDE chrome
// at phone width — exactly what QA observed at 390×844 — without any test
// failing. This suite instead:
//   - does NOT mock `@/hooks/use-mobile-web-shell`,
//   - mocks `@/lib/tauri-runtime` so `isTauriContext() → false` (web),
//   - stubs `window.matchMedia` so `(max-width: 767px)` matches at the QA
//     repro width (390px) and not at desktop width (1024px).
// Everything else mirrors the store-mock pattern from
// `WorkspaceLayout.mobile.test.tsx`.

const { tauriRef, projectRef, viewportWidthRef } = vi.hoisted(() => ({
  // Mutable: both branches require isTauriContext() === false (web).
  tauriRef: { current: false as boolean },
  // Mutable: the Git Changes button + git Sheet need an active project path.
  projectRef: {
    current: { id: 'p1', name: 'Demo', path: '/demo', color: 'blue', gitBranch: 'main' } as {
      path?: string
      name?: string
      id?: string
      color?: string
      gitBranch?: string
    }
  },
  // Mutable: the matchMedia stub resolves `(max-width: Npx)` /
  // `(min-width: Npx)` queries against this width.
  viewportWidthRef: { current: 390 as number }
}))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

// NOTE: `@/hooks/use-mobile-web-shell` is deliberately NOT mocked — the real
// hook must read the stubbed matchMedia and drive the branch decision.

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
// defined. Their default/empty state is fine for both branch assertions.

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
    selector({ selectedAgentConfigId: 'cfg-1', agentConfigs: [{ id: 'cfg-1' }] }),
  // Desktop branch only: ProjectSidebar reads this for activity indicators.
  useProjectsWithActiveAgentChat: () => []
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

// Stub heavy child components so both branches render without dragging in
// CodeMirror / xterm / page implementations.
vi.mock('@/components/workspace/PaneRenderer', () => ({
  PaneRenderer: () => <div data-pane-renderer-stub />
}))
vi.mock('@/components/file-explorer/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="file-explorer-stub" />
}))

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

vi.mock('@/stores/ssh-store', () => ({
  useActiveSSHProfile: () => null,
  useActiveSSHProfileId: () => null,
  // Desktop branch only: SSHPanel (inside ActivityRail) lists connections.
  useSSHConnections: () => [],
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
  SSHWorkspace: () => <div data-testid="ssh-workspace-stub" />
}))

vi.mock('@/components/ssh/SSHFileExplorer', () => ({
  SSHFileExplorer: () => <div data-testid="ssh-file-explorer-stub" />
}))

import WorkspaceLayout from './WorkspaceLayout'

/**
 * jsdom does not implement matchMedia. Resolve `(max-width: Npx)` /
 * `(min-width: Npx)` queries against the hoisted viewport-width ref so the
 * REAL `useMobileWebShell` hook sees the QA repro geometry. Mirrors the
 * defineProperty/restore pattern from `use-mobile-web-shell.test.ts`.
 */
let originalMatchMedia: PropertyDescriptor | undefined

function installMatchMediaStub(): void {
  if (originalMatchMedia === undefined) {
    originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => {
      const maxMatch = /\(max-width:\s*(\d+)px\)/.exec(query)
      const minMatch = /\(min-width:\s*(\d+)px\)/.exec(query)
      const matches = maxMatch
        ? viewportWidthRef.current <= Number(maxMatch[1])
        : minMatch
          ? viewportWidthRef.current >= Number(minMatch[1])
          : false
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn()
      }
    })
  })
}

describe('WorkspaceLayout mobile breakpoint (real useMobileWebShell hook)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriRef.current = false
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo', color: 'blue', gitBranch: 'main' }
    gitState.statuses = {}
    gitState.selectedFile = null
    gitState.commitContexts = {}
    installMatchMediaStub()
  })

  afterEach(() => {
    if (originalMatchMedia !== undefined) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia)
    }
  })

  it('renders the mobile shell — and NO desktop chrome — at the QA repro width 390px', async () => {
    viewportWidthRef.current = 390
    // TooltipProvider mirrors App.tsx / WorkspaceLayout.test.tsx — desktop
    // chrome (StatusBar, rail buttons) uses Radix tooltips.
    render(
      <TooltipProvider>
        <MemoryRouter>
          <WorkspaceLayout />
        </MemoryRouter>
      </TooltipProvider>
    )

    // MobileChatShell is React.lazy — wait for it to load before asserting.
    await waitFor(() => expect(document.querySelector('[data-mobile-chat-shell]')).toBeTruthy())

    // Desktop chrome must be absent: ActivityRail nav, ProjectSidebar,
    // StatusBar (which renders the lowercased project name, "demo").
    expect(screen.queryByLabelText('Global actions')).toBeNull()
    expect(screen.queryByTestId('header-new-project')).toBeNull()
    expect(screen.queryByText('demo')).toBeNull()

    // The mobile header affordances are present.
    expect(screen.getByLabelText('Open menu')).toBeInTheDocument()
    expect(screen.getByLabelText('Switch project')).toBeInTheDocument()
    expect(screen.getByLabelText('Browse files')).toBeInTheDocument()
    // Pin the flex sizing contract that keeps the workspace visible (this
    // story's production fix — jsdom performs no layout, so the class
    // contract is asserted directly): the workspace <main> sizes via flex-1
    // (not h-full) inside a flex-col wrapper. Reverting either class
    // collapses the workspace to 0 height in engines that treat a
    // flex-resolved parent size as indefinite for percentage resolution.
    const main = document.querySelector('[data-mobile-chat-shell] main')
    if (!main?.parentElement) {
      throw new Error('workspace <main> (and its wrapper) must be mounted inside the mobile shell')
    }
    expect(main).toHaveClass('flex-1')
    expect(main).not.toHaveClass('h-full')
    expect(main.parentElement).toHaveClass('flex')
    expect(main.parentElement).toHaveClass('flex-col')
    // The rest of the sizing contract: main and its flex-sized wrapper keep
    // min-h-0 (flex children may shrink below content), and the fixed chrome
    // (mobile header; the terminal-controls bar is pinned in its own suite)
    // keeps shrink-0 so the workspace never eats it.
    expect(main).toHaveClass('min-h-0')
    expect(main.parentElement).toHaveClass('min-h-0')
    const header = document.querySelector('[data-mobile-chat-shell] header')
    expect(header).toHaveClass('shrink-0')
  })

  it('renders the desktop chrome — and NOT the mobile shell — at 1024px', async () => {
    viewportWidthRef.current = 1024
    render(
      <TooltipProvider>
        <MemoryRouter>
          <WorkspaceLayout />
        </MemoryRouter>
      </TooltipProvider>
    )

    // Desktop branch renders synchronously (only FileExplorer is lazy, and
    // it is stubbed) — wait for effects to flush via the ActivityRail nav.
    await waitFor(() => expect(screen.getByLabelText('Global actions')).toBeInTheDocument())

    // The mobile shell must be absent.
    expect(document.querySelector('[data-mobile-chat-shell]')).toBeNull()

    // Desktop chrome present: ProjectSidebar + StatusBar ("demo").
    expect(screen.getByTestId('header-new-project')).toBeInTheDocument()
    expect(screen.getByText('demo')).toBeInTheDocument()
  })

  // The hook's contract is `(max-width: Npx)` — guard the exact boundary so
  // a breakpoint regression (wrong value, `<` vs `<=`) fails loudly.
  it.each([
    { width: MOBILE_WEB_SHELL_MAX_PX, expectMobile: true },
    { width: MOBILE_WEB_SHELL_MAX_PX + 1, expectMobile: false }
  ])('switches the shell at the exact breakpoint boundary ($width px → mobile=$expectMobile)', async ({
    width,
    expectMobile
  }) => {
    viewportWidthRef.current = width
    render(
      <TooltipProvider>
        <MemoryRouter>
          <WorkspaceLayout />
        </MemoryRouter>
      </TooltipProvider>
    )

    if (expectMobile) {
      await waitFor(() => expect(document.querySelector('[data-mobile-chat-shell]')).toBeTruthy())
      expect(screen.queryByLabelText('Global actions')).toBeNull()
    } else {
      await waitFor(() => expect(screen.getByLabelText('Global actions')).toBeInTheDocument())
      expect(document.querySelector('[data-mobile-chat-shell]')).toBeNull()
    }
  })
})
