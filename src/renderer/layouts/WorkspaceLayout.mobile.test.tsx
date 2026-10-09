import {
  act,
  fireEvent,
  type RenderResult,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react'
import { HashRouter, MemoryRouter, type NavigateFunction, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import {
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { useGitSheetStore } from '@/stores/git-sheet-store'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode, SplitNode } from '@/types/workspace.types'

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
      activeWorktreeId?: string | null
      worktrees?: Array<{ id: string; name: string; path: string }>
    }
  }
}))

// The palette's project picks: `selectProject` is the desktop path, and the
// shared `useProjectSwitch` routine (its own tests live in
// use-project-switch.test.tsx) is the phone shell's.
const { selectProjectSpy, switchToSpy, useProjectSwitchSpy } = vi.hoisted(() => {
  const switchTo = vi.fn(async () => 'completed' as const)
  const projectSwitch = { switchTo, clearFailed: vi.fn() }
  return {
    selectProjectSpy: vi.fn(),
    switchToSpy: switchTo,
    useProjectSwitchSpy: vi.fn((_source: string) => projectSwitch)
  }
})

vi.mock('@/hooks/use-project-switch', () => ({
  useProjectSwitch: useProjectSwitchSpy,
  useProjectSwitchState: () => ({ switchingId: null, queuedId: null, failedId: null, busy: false })
}))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

// `subscribeMediaQuery` stays real: the mobile header subscribes its ≤360px
// narrow query through it.
vi.mock('@/hooks/use-mobile-web-shell', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/use-mobile-web-shell')>(
    '@/hooks/use-mobile-web-shell'
  )
  return {
    ...actual,
    useMobileWebShell: () => mobileRef.current,
    MOBILE_WEB_SHELL_MAX_PX: 767,
    resolveMobileWebShell: (_t: boolean, m: boolean) => m
  }
})

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
  // The drawer's project row reads the active worktree (none in this fixture).
  getActiveWorktreeFromStore: () => undefined,
  useProjectsLoaded: () => true,
  useProjects: () => [projectRef.current],
  useActiveProject: () => projectRef.current,
  useActiveProjectId: () => 'p1',
  useProjectActions: () => ({
    selectProject: selectProjectSpy,
    addProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    reorderProjects: vi.fn()
  }),
  useProjectStore: Object.assign(vi.fn(), {
    getState: () => ({
      // Story 6: `getDefaultCwdForProject` reads `useProjectStore.getState()`
      // to resolve the main project root for git-history tabs — return the
      // same project the hooks see so the drawer repro creates a real tab.
      projects: [projectRef.current],
      activeProjectId: 'p1',
      isLoaded: true,
      isWorktreeOperationLocked: false
    })
  })
}))

vi.mock('@/stores/terminal-store', () => ({
  // `getState` serves the drawer's terminal rows, which render for any
  // seeded terminal tab.
  useTerminalStore: Object.assign(
    vi.fn((selector) => selector({ terminals: [] })),
    { getState: () => ({ terminals: [] }) }
  ),
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

vi.mock('@/stores/keyboard-shortcuts-store', () => {
  const state = { shortcuts: { commandPalette: { customKey: 'ctrl+k', defaultKey: 'ctrl+k' } } }
  return {
    // `getState` serves the document-level key handlers in WorkspaceLayout
    // (save shortcut), which any keydown, including Escape, reaches; the
    // overlay Esc tests exercise it.
    useKeyboardShortcutsStore: Object.assign(
      vi.fn(
        (
          selector?: (s: {
            shortcuts: Record<string, { customKey: string; defaultKey: string }>
          }) => unknown
        ) => (selector ? selector(state) : state)
      ),
      { getState: () => state }
    ),
    matchesShortcut: () => false
  }
})

// Persistence restore replaces the whole pane tree (resetLayout /
// loadProjectWorkspace) when it finds nothing for the project. The pane-tree
// rows and the overlay tests seed tabs into the real workspace store, so keep
// the restore out of the way, as the other WorkspaceLayout suites do.
vi.mock('@/hooks/use-editor-persistence', () => ({
  useEditorPersistence: vi.fn(),
  persistState: vi.fn()
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
// overlay rendering is covered in CommandPalette.test.tsx. The stub exposes
// whether the layout wired `onNewProject`, and runs it the way the real
// palette's `executeCommand` does (close first, then execute).
vi.mock('@/components/CommandPalette', () => ({
  CommandPalette: ({
    isOpen,
    onClose,
    onOpenCommandHistory,
    onSSHConnect,
    onNewProject,
    onSwitchProject
  }: {
    isOpen: boolean
    onClose: () => void
    onOpenCommandHistory?: () => void
    onSSHConnect?: (profileId: string) => void
    onNewProject?: () => void
    onSwitchProject?: (projectId: string) => void
  }) =>
    isOpen ? (
      <div data-palette-new-project={onNewProject ? 'wired' : 'absent'}>
        <input placeholder="Search commands, projects, settings..." readOnly />
        <button type="button" onClick={onOpenCommandHistory}>
          Open command history
        </button>
        <button
          type="button"
          onClick={() => {
            // The real palette runs the command, then closes itself.
            onSSHConnect?.('ssh-9')
            onClose()
          }}
        >
          Connect SSH profile
        </button>
        <button
          type="button"
          onClick={() => {
            // A project entry: close first, then execute, as `executeCommand` does.
            onClose()
            onSwitchProject?.('p2')
          }}
        >
          Palette: switch to Beta
        </button>
        {onNewProject && (
          <button
            type="button"
            onClick={() => {
              onClose()
              onNewProject()
            }}
          >
            Palette: New Project
          </button>
        )}
      </div>
    ) : null
}))

// NewProjectModal drags in project templates, shell detection and
// filesystem APIs; the layout test only needs to see that it opens.
vi.mock('@/components/NewProjectModal', () => ({
  NewProjectModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="new-project-modal-stub" /> : null
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

// A spy on the PTY kill path. PaneRenderer is stubbed below and the seeded
// leaves hold no terminal tabs, so this only proves the layout and drawer
// wiring never reach terminalApi.kill while the visible leaf changes. That
// unmounting a terminal view leaves its PTY alone is pinned where it is owned:
// ConnectedTerminal.test.tsx ('should not kill PTY process on unmount').
const { terminalKill } = vi.hoisted(() => ({
  terminalKill: vi.fn(() => Promise.resolve({ success: true }))
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    terminalApi: { ...actual.terminalApi, kill: terminalKill },
    remoteServerApi: { start: vi.fn(), stop: vi.fn(), status: vi.fn() },
    openerApi: { openUrlWithSystemBrowser: vi.fn(() => Promise.resolve({ success: true })) }
  }
})

// Stub heavy child components so the mobile shell renders without dragging in
// CodeMirror / xterm / page implementations.
// The stub exposes the node it was handed (so tests can see whether a split
// was collapsed to a leaf) and a mount counter (so tests can see a remount).
const { paneRendererState } = vi.hoisted(() => ({ paneRendererState: { mounts: 0 } }))
vi.mock('@/components/workspace/PaneRenderer', async () => {
  const React = await import('react')
  return {
    PaneRenderer: ({ node }: { node: { id: string; type: string } }) => {
      const [mountId] = React.useState(() => ++paneRendererState.mounts)
      return (
        <div
          data-pane-renderer-stub
          data-node-id={node.id}
          data-node-type={node.type}
          data-mount={mountId}
        />
      )
    }
  }
})

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
// Story 6: the stub mirrors the REAL AppPreferencesModal close wiring —
// SettingsModal renders a visible close button wired to
// useSettingsModalStore close — so the mobile repro (open prefs, tap
// visible close) is testable without the full settings surface.
vi.mock('@/pages/AppPreferences', () => ({
  AppPreferencesModal: () => {
    const isOpen = useSettingsModalStore((state) => state.view === 'app')
    const close = useSettingsModalStore((state) => state.close)
    return isOpen ? (
      <div role="dialog" aria-label="Application Preferences">
        <button type="button" aria-label="Close Application Preferences" onClick={close}>
          ×
        </button>
      </div>
    ) : null
  }
}))
vi.mock('@/pages/ProjectSettings', () => ({
  ProjectSettingsModal: () => <div>project-settings</div>
}))
vi.mock('@/components/CommandHistoryModal', () => ({
  CommandHistoryModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>command-history-modal</div> : null
}))
vi.mock('@/components/TermulMark', () => ({ TermulMark: () => <span>mark</span> }))
vi.mock('@/components/chat/ChatHistoryTab', () => ({
  ChatHistoryTab: () => <div>history</div>
}))
// The real hook subscribes to the acp and connection stores; this file mocks
// `@/stores/acp-store` with a selector-only stub (no `subscribe`). The hook has
// its own tests (use-shell-announcements.test.tsx).
vi.mock('@/hooks/use-shell-announcements', () => ({
  useShellAnnouncements: () => undefined
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
const { sshProfileRef, sshProfilesRef } = vi.hoisted(() => ({
  sshProfileRef: {
    current: null as {
      id: string
      name: string
      host: string
      username: string
      password: string
    } | null
  },
  // Mutable: saved profiles the palette can connect to (stable identity).
  sshProfilesRef: {
    current: [] as Array<{
      id: string
      name: string
      host: string
      username: string
      authMethod: 'password'
      hasStoredPassword: boolean
    }>
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
  useSSHProfiles: () => sshProfilesRef.current,
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

import { TooltipProvider } from '@/components/ui/tooltip'
import WorkspaceLayout from './WorkspaceLayout'

// Mirror the real app's root TooltipProvider (App.tsx / TauriApp.tsx): the
// mobile shell no longer mounts StatusBar, but the lazily loaded sheets and
// header controls still render under it in production.
function renderLayout(): RenderResult {
  return render(
    <TooltipProvider>
      <MemoryRouter>
        <WorkspaceLayout />
      </MemoryRouter>
    </TooltipProvider>
  )
}

const initialWorkspace = useWorkspaceStore.getState()

describe('WorkspaceLayout mobile branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGitSheetStore.setState({ open: false, cwd: '', projectId: '' })
    // Clear any sentinel a previous test left on the current history entry.
    window.history.replaceState(null, '', '#/')
    tauriRef.current = false
    mobileRef.current = true
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo', color: 'blue', gitBranch: 'main' }
    gitState.statuses = {}
    gitState.selectedFile = null
    gitState.commitContexts = {}
    sshProfileRef.current = null
    sshProfilesRef.current = []
    useSettingsModalStore.getState().close()
  })

  afterEach(async () => {
    // jsdom history traversals are asynchronous: a test that closes an overlay
    // right before it ends leaves a consume traversal in flight, and its
    // popstate would land on the NEXT test's freshly installed handler.
    // (Runs before RTL's auto-unmount, so this layout's handler is still live.)
    await settleOverlayBackStack()
  })

  // The header keeps three icon slots; Command palette, Git changes and Files
  // live in the header ⋯ ("More") sheet. MobileChatShell is React.lazy, so
  // each helper waits for the ⋯ button before opening the sheet.
  async function openMoreSheet(): Promise<void> {
    fireEvent.click(await screen.findByLabelText('More'))
    await screen.findByRole('dialog')
  }

  async function chooseMoreItem(name: string): Promise<void> {
    await openMoreSheet()
    fireEvent.click(screen.getByRole('button', { name }))
  }

  it('mounts MobileChatShell and threads the command-palette + git-changes triggers', async () => {
    renderLayout()

    // MobileChatShell is React.lazy — wait for it to load before asserting.
    await waitFor(() => expect(document.querySelector('[data-mobile-chat-shell]')).toBeTruthy())
    expect(screen.queryByLabelText('Command palette')).not.toBeInTheDocument()
    await openMoreSheet()
    expect(screen.getByRole('button', { name: 'Command palette' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Git changes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Project settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New terminal' })).toBeInTheDocument()
  })

  it('threads the project sheet through the header subtitle, not a header icon', async () => {
    renderLayout()

    expect(await screen.findByRole('button', { name: /switch project/ })).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    )
    expect(screen.queryByLabelText('Switch project')).not.toBeInTheDocument()
  })

  it('threads "Project settings" to the Project Settings modal', async () => {
    renderLayout()

    await chooseMoreItem('Project settings')

    expect(useSettingsModalStore.getState().view).toBe('project')
    expect(await screen.findByText('project-settings')).toBeInTheDocument()
  })

  it('threads "Command history" into the terminal ⋯ sheet', async () => {
    act(() => {
      useWorkspaceStore.getState().addTerminalTab('t1')
    })
    try {
      renderLayout()

      fireEvent.click(await screen.findByLabelText('Terminal actions'))
      fireEvent.click(await screen.findByRole('button', { name: 'Command history' }))

      expect(await screen.findByText('command-history-modal')).toBeInTheDocument()
    } finally {
      // The workspace store is real and shared by the tests below.
      act(() => {
        const { root, removeTab } = useWorkspaceStore.getState()
        for (const leaf of getAllLeafPanes(root)) {
          for (const tab of leaf.tabs) if (tab.type === 'terminal') removeTab(tab.id)
        }
      })
    }
  })
  // The mobile revamp retires the desktop StatusBar on the phone shell:
  // connection health moved to the drawer footer and ContextBarSettingsPopover
  // (a StatusBar child) is not mounted. Desktop keeps it (see the breakpoint suite).
  describe('terminal ⋯ sheet navigation rows (L-14)', () => {
    beforeEach(() => {
      act(() => {
        useWorkspaceStore.getState().addTerminalTab('t1')
      })
    })

    afterEach(() => {
      // The workspace store is real and shared by the tests below.
      act(() => {
        const { root, removeTab } = useWorkspaceStore.getState()
        for (const leaf of getAllLeafPanes(root)) {
          for (const tab of leaf.tabs) if (tab.type === 'terminal') removeTab(tab.id)
        }
      })
    })

    async function chooseTerminalItem(name: string): Promise<void> {
      fireEvent.click(await screen.findByLabelText('Terminal actions'))
      fireEvent.click(await screen.findByRole('button', { name }))
    }

    it('offers Git changes, Files, Command palette and Project settings, but not New terminal', async () => {
      renderLayout()

      fireEvent.click(await screen.findByLabelText('Terminal actions'))
      await screen.findByRole('dialog')

      const sheet = document.getElementById('mobile-terminal-actions-sheet')
      const labels = Array.from(sheet?.querySelectorAll('button') ?? [])
        .map((button) => button.textContent?.trim() ?? '')
        .filter((text) => text.length > 0 && text !== 'Close')
      expect(labels).toEqual([
        'Rename terminal',
        'Restart terminal',
        'Command history',
        'Git changes',
        'Files',
        'Command palette',
        'Project settings',
        'Close terminal'
      ])
    })

    it('threads "Git changes" to the Git Changes sheet', async () => {
      renderLayout()

      await chooseTerminalItem('Git changes')

      expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()
    })

    it('threads "Command palette" to the palette overlay', async () => {
      renderLayout()

      await chooseTerminalItem('Command palette')

      expect(
        await screen.findByPlaceholderText('Search commands, projects, settings...')
      ).toBeInTheDocument()
    })

    it('threads "Project settings" to the Project Settings modal', async () => {
      renderLayout()

      await chooseTerminalItem('Project settings')

      expect(useSettingsModalStore.getState().view).toBe('project')
      expect(await screen.findByText('project-settings')).toBeInTheDocument()
    })

    it('threads "Files" and closes the terminal sheet', async () => {
      renderLayout()

      await chooseTerminalItem('Files')

      await waitFor(() =>
        expect(document.getElementById('mobile-terminal-actions-sheet')).not.toBeInTheDocument()
      )
    })

    it('omits the Git changes row when there is no active project path', async () => {
      projectRef.current = { id: 'p1', name: 'Demo' }
      renderLayout()

      fireEvent.click(await screen.findByLabelText('Terminal actions'))
      await screen.findByRole('dialog')

      expect(screen.queryByRole('button', { name: 'Git changes' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Project settings' })).toBeInTheDocument()
    })
  })

  describe('palette project switch (L-13)', () => {
    it('sends a palette project pick through the shared switch routine, not selectProject', async () => {
      renderLayout()

      await chooseMoreItem('Command palette')
      fireEvent.click(await screen.findByRole('button', { name: 'Palette: switch to Beta' }))

      expect(useProjectSwitchSpy).toHaveBeenCalledWith('CommandPalette')
      expect(switchToSpy).toHaveBeenCalledTimes(1)
      expect(switchToSpy).toHaveBeenCalledWith('p2')
      expect(selectProjectSpy).not.toHaveBeenCalled()
      // The palette still closes on select; the project sheet is where badges show.
      await waitFor(() =>
        expect(
          screen.queryByPlaceholderText('Search commands, projects, settings...')
        ).not.toBeInTheDocument()
      )
    })
  })

  it('does not render the StatusBar on the mobile shell', async () => {
    renderLayout()

    await waitFor(() => expect(document.querySelector('[data-mobile-chat-shell]')).toBeTruthy())
    expect(document.querySelector('[data-status-bar]')).toBeNull()
  })

  it('opens the CommandPalette overlay when the mobile trigger is tapped', async () => {
    renderLayout()

    expect(
      screen.queryByPlaceholderText('Search commands, projects, settings...')
    ).not.toBeInTheDocument()
    // MobileChatShell is React.lazy — wait for the ⋯ button, then the row.
    await chooseMoreItem('Command palette')
    expect(
      await screen.findByPlaceholderText('Search commands, projects, settings...')
    ).toBeInTheDocument()
  })

  it('opens the Git Changes Sheet with the mobile GitPanel file list when the trigger is tapped', async () => {
    renderLayout()

    // Sheet starts closed: the GitPanel file-list filter input is absent.
    expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
    // MobileChatShell is React.lazy — wait for the ⋯ button, then the row.
    await chooseMoreItem('Git changes')
    // GitPanel mobile branch renders the file-list filter input (full-width).
    expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()
  })

  // a11y floor: the header ⋯ row that opens the Git sheet is a plain button that
  // sets state in another component, so Radix has no trigger to return focus
  // to. Closing the sheet must hand focus back to the header ⋯ button (the row
  // unmounts with its sheet), not <body>.
  it('returns focus to the header ⋯ button when Escape closes the Git sheet', async () => {
    renderLayout()

    const trigger = await screen.findByLabelText('More')
    await chooseMoreItem('Git changes')
    expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
    )
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('returns focus to the header ⋯ button when the sheet Close button is used', async () => {
    renderLayout()

    const trigger = await screen.findByLabelText('More')
    await chooseMoreItem('Git changes')
    await screen.findByPlaceholderText('Filter changes...')

    const sheet = document.querySelector('[data-sheet]') as HTMLElement
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))

    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
    )
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  // The changed-files bar's "Git" action lives in AgentChatPanel, which this
  // file's PaneRenderer stub cannot host. A stand-in button beside the real
  // layout is wired the way the panel wires it: the tapped button is handed to
  // `openGitSheet(cwd, opener)` through `useGitSheetStore`. The Git sheet must
  // return focus to it, not to <body> (and not to ⋯, which was never used).
  describe('Git sheet opened from the changed-files Git action', () => {
    function GitActionStandIn(): React.JSX.Element {
      const openGitSheet = useGitSheetStore((s) => s.openGitSheet)
      return (
        <button
          type="button"
          onClick={(event) => openGitSheet('/demo/.worktrees/chat', event.currentTarget)}
        >
          Open Git changes
        </button>
      )
    }

    function tree(showAction: boolean): React.JSX.Element {
      return (
        <TooltipProvider>
          <MemoryRouter>
            {showAction && <GitActionStandIn />}
            <WorkspaceLayout />
          </MemoryRouter>
        </TooltipProvider>
      )
    }

    async function openFromGitAction(): Promise<{ action: HTMLElement; view: RenderResult }> {
      const view = render(tree(true))
      await screen.findByLabelText('More')
      const action = screen.getByRole('button', { name: 'Open Git changes' })
      fireEvent.click(action)
      expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()
      expect(useGitSheetStore.getState().cwd).toBe('/demo/.worktrees/chat')
      return { action, view }
    }

    it('returns focus to the Git action when Escape closes the sheet', async () => {
      const { action } = await openFromGitAction()

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(action))
      expect(document.activeElement).not.toBe(screen.getByLabelText('More'))
    })

    it("returns focus to the Git action when the sheet's Close button is used", async () => {
      const { action } = await openFromGitAction()

      const sheet = document.querySelector('[data-sheet]') as HTMLElement
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(action))
    })

    it('returns focus to the Git action when hardware back closes the sheet', async () => {
      const { action } = await openFromGitAction()

      await waitForSentinelDepth(1)
      await pressSystemBack()

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(action))
    })

    it('leaves focus alone, with no throw, when the Git action is gone by the time it closes', async () => {
      const { action, view } = await openFromGitAction()
      // The bar unmounts while the sheet is open (a question replaced it).
      view.rerender(tree(false))
      expect(action.isConnected).toBe(false)

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      await waitFor(() =>
        expect(logFrontendError).toHaveBeenCalledWith({
          level: 'info',
          source: 'sheet-focus-return',
          message: 'Sheet closed with no connected focus target: git-sheet'
        })
      )
      expect(document.activeElement).toBe(document.body)
    })
  })

  // Story 10 (QA F9/F7): the git sheet is no longer a radius-0 full-screen
  // takeover — rounded top corners + max-height with the app visible behind
  // the overlay; the safe-area bottom inset from Story 7 is preserved.
  it('git Sheet wrapper renders rounded top corners with a max height, not h-full', async () => {
    renderLayout()

    await chooseMoreItem('Git changes')
    const filter = await screen.findByPlaceholderText('Filter changes...')

    // The ⋯ sheet may still be unmounting; pick the Git sheet itself.
    const sheetContent = filter.closest('[data-sheet]')
    expect(sheetContent).not.toBeNull()
    const cls = sheetContent?.className ?? ''
    expect(cls).toContain('rounded-t-xl')
    expect(cls).toContain('max-h-[90vh]')
    expect(cls).not.toContain('h-full')
    expect(cls).toContain('pb-[env(safe-area-inset-bottom)]')
  })

  it('omits the Git changes row when no active project path', async () => {
    projectRef.current = { id: 'p1', name: 'Demo' }
    renderLayout()
    // MobileChatShell is React.lazy — wait for the ⋯ button to appear.
    await openMoreSheet()
    expect(screen.getByRole('button', { name: 'Command palette' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Git changes' })).not.toBeInTheDocument()
  })

  it('closes the Git Changes sheet if the active project loses its path while open', async () => {
    const { rerender } = renderLayout()

    // MobileChatShell is React.lazy — wait for the ⋯ button, then the row.
    await chooseMoreItem('Git changes')
    expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()

    // Active project switches to one without a path while the sheet is open.
    projectRef.current = { id: 'p2', name: 'NoPath' }
    rerender(
      <TooltipProvider>
        <MemoryRouter>
          <WorkspaceLayout />
        </MemoryRouter>
      </TooltipProvider>
    )

    // The guard effect closes the sheet → GitPanel file list unmounts.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
    )
  })

  describe('Git sheet cwd and lifecycle (store-backed)', () => {
    const worktreeProject = {
      id: 'p1',
      name: 'Demo',
      path: '/demo',
      color: 'blue',
      gitBranch: 'main',
      activeWorktreeId: 'w1',
      worktrees: [{ id: 'w1', name: 'a', path: '/demo/.worktrees/a' }]
    }

    it('opens the header Git sheet on the project path when there is no active worktree', async () => {
      renderLayout()

      await chooseMoreItem('Git changes')
      await screen.findByPlaceholderText('Filter changes...')

      expect(gitState.refreshStatus).toHaveBeenCalledWith('/demo')
      expect(useGitSheetStore.getState()).toMatchObject({
        open: true,
        cwd: '/demo',
        projectId: 'p1'
      })
    })

    it("opens the header Git sheet on the project's active worktree, not the project path", async () => {
      projectRef.current = worktreeProject
      renderLayout()

      await chooseMoreItem('Git changes')
      await screen.findByPlaceholderText('Filter changes...')

      expect(gitState.refreshStatus).toHaveBeenCalledWith('/demo/.worktrees/a')
      expect(gitState.refreshStatus).not.toHaveBeenCalledWith('/demo')
    })

    it("opens on a chat's own worktree cwd when the dock's Git action passes it", async () => {
      renderLayout()
      await screen.findByLabelText('More')

      act(() => useGitSheetStore.getState().openGitSheet('/demo/.worktrees/chat'))

      await screen.findByPlaceholderText('Filter changes...')
      expect(gitState.refreshStatus).toHaveBeenCalledWith('/demo/.worktrees/chat')
    })

    it('stays closed and warns when no cwd resolves', async () => {
      projectRef.current = { id: 'p1', name: 'Demo' }
      renderLayout()
      await screen.findByLabelText('More')

      act(() => useGitSheetStore.getState().openGitSheet())

      expect(useGitSheetStore.getState().open).toBe(false)
      expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      expect(logFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
    })

    it('closes the sheet when the active project changes from the one it opened on', async () => {
      const { rerender } = renderLayout()
      await chooseMoreItem('Git changes')
      expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()

      // Another project with a path becomes active: the snapshotted cwd would
      // be stale, so the sheet closes instead of re-pointing.
      projectRef.current = { id: 'p2', name: 'Other', path: '/other' }
      rerender(
        <TooltipProvider>
          <MemoryRouter>
            <WorkspaceLayout />
          </MemoryRouter>
        </TooltipProvider>
      )

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      expect(useGitSheetStore.getState().open).toBe(false)
    })

    it('closes the sheet and the store when Escape dismisses it', async () => {
      renderLayout()
      await chooseMoreItem('Git changes')
      await screen.findByPlaceholderText('Filter changes...')
      expect(useGitSheetStore.getState().open).toBe(true)

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      expect(useGitSheetStore.getState().open).toBe(false)
    })

    it("closes the sheet and the store from the sheet's own Close button", async () => {
      renderLayout()
      await chooseMoreItem('Git changes')
      await screen.findByPlaceholderText('Filter changes...')

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      expect(useGitSheetStore.getState().open).toBe(false)
    })

    it('closes the store when the layout unmounts, so a remount starts cold', async () => {
      const { unmount } = renderLayout()
      await chooseMoreItem('Git changes')
      await screen.findByPlaceholderText('Filter changes...')
      expect(useGitSheetStore.getState().open).toBe(true)

      unmount()

      expect(useGitSheetStore.getState().open).toBe(false)
    })
  })

  // ── Story 6: trap-free mobile navigation ────────────────────────────────

  describe('hardware back closes overlays (popstate)', () => {
    it('system back closes the open Git sheet and the app does not navigate away', async () => {
      renderLayout()

      await chooseMoreItem('Git changes')
      expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()

      // The overlay grew the stack 0 → 1: the managed reconciler arms one
      // history sentinel, and a real back press pops it.
      await waitForSentinelDepth(1)
      const hashBefore = window.location.hash
      await pressSystemBack()

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      expect(window.location.hash).toBe(hashBefore)
      expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
    })

    it('a route push with the Git sheet open re-arms the sentinel, so one back closes the sheet and keeps the route', async () => {
      const navigateRef: { current: NavigateFunction | null } = { current: null }
      function NavProbe(): null {
        navigateRef.current = useNavigate()
        return null
      }
      render(
        <TooltipProvider>
          <HashRouter>
            <NavProbe />
            <WorkspaceLayout />
          </HashRouter>
        </TooltipProvider>
      )

      await chooseMoreItem('Git changes')
      expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()
      await waitForSentinelDepth(1)

      // The router pushes a route (no popstate): the layout hands its new
      // location key to the back-stack hook, which re-arms the sentinel.
      await act(async () => {
        navigateRef.current?.('/snapshots')
      })
      await waitFor(() => expect(window.location.hash).toBe('#/snapshots'))
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      expect(window.location.hash).toBe('#/snapshots')
      expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
    })

    it('returns focus to the header ⋯ button when hardware back closes the sheet', async () => {
      renderLayout()

      const trigger = await screen.findByLabelText('More')
      await chooseMoreItem('Git changes')
      expect(await screen.findByPlaceholderText('Filter changes...')).toBeInTheDocument()

      await waitForSentinelDepth(1)
      await pressSystemBack()

      await waitFor(() =>
        expect(screen.queryByPlaceholderText('Filter changes...')).not.toBeInTheDocument()
      )
      await waitFor(() => expect(document.activeElement).toBe(trigger))
    })

    it('system back closes the CommandPalette overlay when it is topmost', async () => {
      renderLayout()

      await chooseMoreItem('Command palette')
      expect(
        await screen.findByPlaceholderText('Search commands, projects, settings...')
      ).toBeInTheDocument()

      await waitForSentinelDepth(1)
      await pressSystemBack()

      await waitFor(() =>
        expect(
          screen.queryByPlaceholderText('Search commands, projects, settings...')
        ).not.toBeInTheDocument()
      )
      expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
    })

    describe('overlays outside the old stack', () => {
      afterEach(() => {
        useWorkspaceStore.setState({
          root: initialWorkspace.root,
          activePaneId: initialWorkspace.activePaneId,
          agentLauncherPaneId: null
        })
      })

      async function openLauncherOverlay(): Promise<void> {
        // Wait for the lazy shell, then open the launcher over a pane that has
        // a tab (an empty pane would render it as the pane body instead).
        await screen.findByLabelText('More')
        act(() => {
          useWorkspaceStore.getState().addGitTab('/demo')
          const paneId = useWorkspaceStore.getState().activePaneId
          if (paneId) useWorkspaceStore.getState().showAgentLauncher(paneId)
        })
      }

      it('system back closes the AgentLauncher overlay', async () => {
        renderLayout()
        await openLauncherOverlay()
        expect(useWorkspaceStore.getState().agentLauncherPaneId).not.toBeNull()

        await waitForSentinelDepth(1)
        const hashBefore = window.location.hash
        await pressSystemBack()

        // PaneRenderer is stubbed here, so the owning store reports it closed.
        await waitFor(() => expect(useWorkspaceStore.getState().agentLauncherPaneId).toBeNull())
        expect(window.location.hash).toBe(hashBefore)
        expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
      })

      it('Esc with focus outside the launcher closes it and consumes its sentinel', async () => {
        renderLayout()
        await openLauncherOverlay()
        await waitForSentinelDepth(1)

        fireEvent.keyDown(document.body, { key: 'Escape' })

        await waitFor(() => expect(useWorkspaceStore.getState().agentLauncherPaneId).toBeNull())
        await waitForSentinelDepth(0)
      })

      it('palette → Command history swap keeps one sentinel, and back closes the sub-modal', async () => {
        renderLayout()

        await chooseMoreItem('Command palette')
        await screen.findByPlaceholderText('Search commands, projects, settings...')
        await waitForSentinelDepth(1)
        const backSpy = vi.spyOn(window.history, 'back')
        const goSpy = vi.spyOn(window.history, 'go')
        const pushSpy = vi.spyOn(window.history, 'pushState')

        // The palette closes and the lazy sub-modal opens in one batch.
        fireEvent.click(screen.getByRole('button', { name: 'Open command history' }))
        expect(await screen.findByText('command-history-modal')).toBeInTheDocument()
        expect(
          screen.queryByPlaceholderText('Search commands, projects, settings...')
        ).not.toBeInTheDocument()
        await settleOverlayBackStack()

        expect(backSpy).not.toHaveBeenCalled()
        expect(goSpy).not.toHaveBeenCalled()
        expect(pushSpy).not.toHaveBeenCalled()
        expect(readOverlaySentinelDepth(window.history.state)).toBe(1)

        // One back closes the sub-modal.
        await pressSystemBack()
        await waitFor(() =>
          expect(screen.queryByText('command-history-modal')).not.toBeInTheDocument()
        )
        expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
        backSpy.mockRestore()
        goSpy.mockRestore()
        pushSpy.mockRestore()
      })

      describe('SSH password prompt', () => {
        async function openSshPrompt(): Promise<void> {
          sshProfilesRef.current = [
            {
              id: 'ssh-9',
              name: 'Build box',
              host: 'build.example',
              username: 'dev',
              authMethod: 'password',
              hasStoredPassword: false
            }
          ]
          renderLayout()
          await chooseMoreItem('Command palette')
          await waitForSentinelDepth(1)

          // The palette closes and the inline prompt opens in one batch.
          fireEvent.click(await screen.findByRole('button', { name: 'Connect SSH profile' }))
          expect(await screen.findByText('SSH Password')).toBeInTheDocument()
          await settleOverlayBackStack()
          expect(readOverlaySentinelDepth(window.history.state)).toBe(1)
        }

        it('system back closes the prompt and clears it', async () => {
          await openSshPrompt()
          const hashBefore = window.location.hash

          await pressSystemBack()

          await waitFor(() => expect(screen.queryByText('SSH Password')).not.toBeInTheDocument())
          expect(window.location.hash).toBe(hashBefore)
          expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
        })

        it('its Cancel button consumes the sentinel', async () => {
          await openSshPrompt()

          await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
          })

          expect(screen.queryByText('SSH Password')).not.toBeInTheDocument()
          await waitForSentinelDepth(0)
        })
      })

      it('system back closes App Preferences', async () => {
        renderLayout()
        await screen.findByLabelText('More')

        act(() => useSettingsModalStore.getState().openApp())
        await screen.findByRole('button', { name: 'Close Application Preferences' })
        await waitForSentinelDepth(1)
        const hashBefore = window.location.hash

        await pressSystemBack()

        await waitFor(() =>
          expect(
            screen.queryByRole('button', { name: 'Close Application Preferences' })
          ).not.toBeInTheDocument()
        )
        expect(useSettingsModalStore.getState().view).toBeNull()
        expect(window.location.hash).toBe(hashBefore)
        expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
      })

      it('closing App Preferences with its close button consumes the sentinel', async () => {
        renderLayout()
        await screen.findByLabelText('More')

        act(() => useSettingsModalStore.getState().openApp())
        const closeBtn = await screen.findByRole('button', {
          name: 'Close Application Preferences'
        })
        await waitForSentinelDepth(1)
        const hashBefore = window.location.hash

        await act(async () => {
          fireEvent.click(closeBtn)
        })

        await waitForSentinelDepth(0)
        expect(useSettingsModalStore.getState().view).toBeNull()
        expect(window.location.hash).toBe(hashBefore)
      })
    })
  })

  // The MobileChatShell unit tests mock the overlay store, so the shell's own
  // registrations (`mobile-drawer`, `files-sheet`, `projects-sheet`) are only
  // exercised against the REAL store and reconciler here.
  describe('MobileChatShell sheets on the real overlay store', () => {
    const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

    it('the drawer registers as mobile-drawer; system back closes it and consumes its sentinel', async () => {
      renderLayout()
      const menuBtn = await screen.findByLabelText('Open menu')

      fireEvent.click(menuBtn)
      await waitForSentinelDepth(1)
      expect(stackIds()).toEqual(['mobile-drawer'])
      expect(menuBtn).toHaveAttribute('aria-expanded', 'true')

      await pressSystemBack()

      await waitFor(() => expect(menuBtn).toHaveAttribute('aria-expanded', 'false'))
      expect(stackIds()).toEqual([])
      expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
    })

    it('Esc closes the drawer once and consumes its sentinel', async () => {
      renderLayout()
      const menuBtn = await screen.findByLabelText('Open menu')
      fireEvent.click(menuBtn)
      await waitForSentinelDepth(1)

      fireEvent.keyDown(document.body, { key: 'Escape' })

      await waitFor(() => expect(menuBtn).toHaveAttribute('aria-expanded', 'false'))
      await waitForSentinelDepth(0)
      expect(stackIds()).toEqual([])
    })

    it('drawer → Settings keeps one sentinel (no traversal, no push), and back closes Preferences', async () => {
      renderLayout()
      fireEvent.click(await screen.findByLabelText('Open menu'))
      await waitForSentinelDepth(1)
      const settingsBtn = await screen.findByLabelText('Settings')
      const backSpy = vi.spyOn(window.history, 'back')
      const goSpy = vi.spyOn(window.history, 'go')
      const pushSpy = vi.spyOn(window.history, 'pushState')
      try {
        // The drawer closes and Preferences opens in one handler.
        await act(async () => {
          fireEvent.click(settingsBtn)
        })
        await screen.findByRole('button', { name: 'Close Application Preferences' })
        await settleOverlayBackStack()

        expect(stackIds()).toEqual(['settings-modal'])
        expect(backSpy).not.toHaveBeenCalled()
        expect(goSpy).not.toHaveBeenCalled()
        expect(pushSpy).not.toHaveBeenCalled()
        expect(readOverlaySentinelDepth(window.history.state)).toBe(1)
      } finally {
        backSpy.mockRestore()
        goSpy.mockRestore()
        pushSpy.mockRestore()
      }

      await pressSystemBack()

      await waitFor(() => expect(useSettingsModalStore.getState().view).toBeNull())
      expect(stackIds()).toEqual([])
      expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
    })

    // The header ⋯ sheet and the sheets it hands off to (Files) or the subtitle
    // opens (project) each register once; choosing a ⋯ row swaps the registered
    // sheet in one batch, so one sentinel serves the whole chain.
    it.each([
      ['header ⋯', 'header-more-sheet', async () => openMoreSheet()],
      ['Files', 'files-sheet', async () => chooseMoreItem('Files')],
      [
        'project',
        'projects-sheet',
        async () => {
          fireEvent.click(await screen.findByRole('button', { name: /switch project/ }))
        }
      ]
    ])('the %s sheet registers as %s; system back closes it', async (_label, id, open) => {
      renderLayout()

      await open()
      await waitForSentinelDepth(1)
      expect(stackIds()).toEqual([id])

      await pressSystemBack()

      await waitFor(() => expect(stackIds()).toEqual([]))
      expect(readOverlaySentinelDepth(window.history.state)).toBe(0)
    })
  })

  // ── Mobile shell fixes (UX FIX 6 and 11) ─────────────────────────────────

  describe('palette New Project (FIX 6)', () => {
    it('wires New Project into the palette on the mobile shell and opens NewProjectModal', async () => {
      renderLayout()

      // The header no longer carries a palette icon; the palette lives in the header ⋯ sheet.
      await chooseMoreItem('Command palette')
      expect(
        await screen.findByPlaceholderText('Search commands, projects, settings...')
      ).toBeInTheDocument()
      expect(document.querySelector('[data-palette-new-project]')).toHaveAttribute(
        'data-palette-new-project',
        'wired'
      )
      expect(screen.queryByTestId('new-project-modal-stub')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Palette: New Project' }))

      // Selecting it closes the palette, then opens the modal.
      await waitFor(() =>
        expect(
          screen.queryByPlaceholderText('Search commands, projects, settings...')
        ).not.toBeInTheDocument()
      )
      expect(await screen.findByTestId('new-project-modal-stub')).toBeInTheDocument()
    })
  })

  describe('split collapse to the active leaf (FIX 11)', () => {
    const leafA: LeafNode = {
      type: 'leaf',
      id: 'pane-a',
      tabs: [{ type: 'git', id: 'git-a', cwd: '/demo' }],
      activeTabId: 'git-a'
    }
    const leafB: LeafNode = {
      type: 'leaf',
      id: 'pane-b',
      tabs: [{ type: 'git-history', id: 'git-history-b', cwd: '/demo' }],
      activeTabId: 'git-history-b'
    }
    const splitRoot: SplitNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: [leafA, leafB],
      sizes: [50, 50]
    }

    const seed = (activePaneId: string, fullscreenPaneId: string | null = null): void => {
      useWorkspaceStore.setState({
        root: splitRoot,
        activePaneId,
        fullscreenPaneId,
        agentLauncherPaneId: null
      })
    }
    const paneStubs = (): NodeListOf<Element> =>
      document.querySelectorAll('[data-pane-renderer-stub]')
    const unresolvedWarnings = (): unknown[][] =>
      vi
        .mocked(logFrontendError)
        .mock.calls.filter(([payload]) => payload.source === 'useMobileActiveLeaf')

    afterEach(() => {
      useWorkspaceStore.getState().resetLayout()
    })

    it('renders only the active leaf of a synced split and leaves the shared tree untouched', async () => {
      seed('pane-b')
      renderLayout()

      await waitFor(() => expect(paneStubs()).toHaveLength(1))
      const stub = paneStubs()[0]
      expect(stub).toHaveAttribute('data-node-id', 'pane-b')
      expect(stub).toHaveAttribute('data-node-type', 'leaf')

      // The collapse is a read-only view: the tree, the active pane and the
      // fullscreen pane are exactly what desktop synced.
      const state = useWorkspaceStore.getState()
      expect(state.root).toBe(splitRoot)
      expect(getAllLeafPanes(state.root)).toHaveLength(2)
      expect(state.activePaneId).toBe('pane-b')
      expect(state.fullscreenPaneId).toBeNull()
      expect(unresolvedWarnings()).toHaveLength(0)
      // The collapse path itself never calls the PTY kill API (see the spy).
      expect(terminalKill).not.toHaveBeenCalled()
    })

    it('shows the other leaf alone, remounted, when a drawer row for its tab is tapped', async () => {
      seed('pane-b')
      renderLayout()
      await waitFor(() => expect(paneStubs()).toHaveLength(1))
      const firstMount = paneStubs()[0].getAttribute('data-mount')

      fireEvent.click(await screen.findByLabelText('Open menu'))
      // The Git Changes row belongs to leaf A, the inactive leaf.
      fireEvent.click(await screen.findByRole('button', { name: 'Git Changes' }))

      await waitFor(() => expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-a'))
      expect(paneStubs()).toHaveLength(1)
      expect(paneStubs()[0]).toHaveAttribute('data-node-type', 'leaf')
      // Keyed by the leaf id: a pane switch remounts instead of reusing state.
      expect(paneStubs()[0].getAttribute('data-mount')).not.toBe(firstMount)

      // Nothing was closed or merged: both leaves are still in the tree.
      const state = useWorkspaceStore.getState()
      expect(state.root.type).toBe('split')
      expect(getAllLeafPanes(state.root).map((leaf) => leaf.id)).toEqual(['pane-a', 'pane-b'])
      expect(state.activePaneId).toBe('pane-a')
      expect(state.fullscreenPaneId).toBeNull()
      // Switching the visible leaf never calls the PTY kill API (see the spy).
      expect(terminalKill).not.toHaveBeenCalled()
    })

    it('leaves fullscreen and shows the other leaf when a drawer row for its tab is tapped', async () => {
      seed('pane-b', 'pane-b')
      renderLayout()
      await waitFor(() => expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-b'))

      fireEvent.click(await screen.findByLabelText('Open menu'))
      // The Git Changes row belongs to leaf A, not the fullscreen leaf B.
      fireEvent.click(await screen.findByRole('button', { name: 'Git Changes' }))

      await waitFor(() => expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-a'))
      expect(paneStubs()).toHaveLength(1)

      const state = useWorkspaceStore.getState()
      expect(state.fullscreenPaneId).toBeNull()
      expect(state.activePaneId).toBe('pane-a')
      // Nothing was closed or merged: both leaves are still in the tree, and
      // no PTY died.
      expect(state.root.type).toBe('split')
      expect(getAllLeafPanes(state.root).map((leaf) => leaf.id)).toEqual(['pane-a', 'pane-b'])
      expect(terminalKill).not.toHaveBeenCalled()
    })

    it('keeps fullscreen when the tapped drawer row belongs to the fullscreen leaf', async () => {
      seed('pane-b', 'pane-b')
      renderLayout()
      await waitFor(() => expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-b'))

      fireEvent.click(await screen.findByLabelText('Open menu'))
      fireEvent.click(await screen.findByRole('button', { name: 'Git History' }))

      await waitFor(() =>
        expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
      )
      expect(paneStubs()).toHaveLength(1)
      expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-b')
      const state = useWorkspaceStore.getState()
      expect(state.fullscreenPaneId).toBe('pane-b')
      expect(state.activePaneId).toBe('pane-b')
    })

    it('keeps the same leaf mounted across re-renders while it stays active', async () => {
      seed('pane-b')
      renderLayout()
      await waitFor(() => expect(paneStubs()).toHaveLength(1))
      const firstMount = paneStubs()[0].getAttribute('data-mount')

      // Opening and closing the drawer re-renders the shell around the pane.
      fireEvent.click(await screen.findByLabelText('Open menu'))
      fireEvent.click(await screen.findByRole('button', { name: 'Git History' }))

      await waitFor(() =>
        expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
      )
      expect(paneStubs()).toHaveLength(1)
      expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-b')
      expect(paneStubs()[0].getAttribute('data-mount')).toBe(firstMount)
    })

    it('falls back to the first leaf and warns once when activePaneId matches no leaf', async () => {
      seed('ghost-pane')
      renderLayout()

      await waitFor(() => expect(paneStubs()).toHaveLength(1))
      expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-a')
      expect(unresolvedWarnings()).toHaveLength(1)
      expect(unresolvedWarnings()[0][0]).toEqual(
        expect.objectContaining({ level: 'warn', source: 'useMobileActiveLeaf' })
      )

      // A re-render with the same unresolved id does not log again, and the
      // store is not repaired by the view.
      fireEvent.click(await screen.findByLabelText('Open menu'))
      expect(unresolvedWarnings()).toHaveLength(1)
      expect(useWorkspaceStore.getState().activePaneId).toBe('ghost-pane')
      expect(useWorkspaceStore.getState().root).toBe(splitRoot)
    })

    it('renders a fullscreen leaf as the single pane without clearing fullscreen', async () => {
      seed('pane-a', 'pane-a')
      renderLayout()

      await waitFor(() => expect(paneStubs()).toHaveLength(1))
      expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-a')
      expect(useWorkspaceStore.getState().fullscreenPaneId).toBe('pane-a')
      expect(useWorkspaceStore.getState().root).toBe(splitRoot)
    })

    it('renders the active leaf, not a different fullscreen leaf, so the pane matches the drawer and header', async () => {
      // `loadProjectWorkspace` can restore an activePaneId while keeping the
      // previous fullscreenPaneId, so "fullscreen A, active B" is reachable.
      // The mobile shell follows activePaneId (the leaf its drawer and header
      // describe); the fullscreen leaf only wins on desktop.
      seed('pane-b', 'pane-a')
      renderLayout()

      await waitFor(() => expect(paneStubs()).toHaveLength(1))
      expect(paneStubs()[0]).toHaveAttribute('data-node-id', 'pane-b')
      expect(paneStubs()[0]).toHaveAttribute('data-node-type', 'leaf')

      const state = useWorkspaceStore.getState()
      expect(state.root).toBe(splitRoot)
      expect(state.activePaneId).toBe('pane-b')
      expect(state.fullscreenPaneId).toBe('pane-a')
    })

    it('hands a single-leaf workspace to PaneRenderer unchanged', async () => {
      useWorkspaceStore.getState().resetLayout()
      const only = useWorkspaceStore.getState().root
      renderLayout()

      await waitFor(() => expect(paneStubs()).toHaveLength(1))
      expect(paneStubs()[0]).toHaveAttribute('data-node-id', only.id)
      expect(paneStubs()[0]).toHaveAttribute('data-node-type', 'leaf')
      expect(unresolvedWarnings()).toHaveLength(0)
    })
  })

  describe('git tab reuse-by-(type, cwd)', () => {
    it('drawer Git history button repeated 4 times yields exactly one activated tab', async () => {
      renderLayout()

      // MobileChatShell is React.lazy — wait for the drawer trigger.
      const menuBtn = await screen.findByLabelText('Open menu')
      for (let i = 0; i < 4; i++) {
        fireEvent.click(menuBtn)
        const historyBtn = await screen.findByLabelText('Git history')
        expect(historyBtn).not.toBeDisabled()
        fireEvent.click(historyBtn)
      }

      // The real workspace store holds the tabs: exactly one git-history tab
      // for the default cwd, and it is the active tab.
      const root = useWorkspaceStore.getState().root
      const leaves = getAllLeafPanes(root)
      const historyTabs = leaves.flatMap((leaf) =>
        leaf.tabs.filter((t) => t.type === 'git-history')
      )
      expect(historyTabs).toHaveLength(1)
      const containingPane = leaves.find((leaf) =>
        leaf.tabs.some((t) => t.id === historyTabs[0].id)
      )
      expect(containingPane?.activeTabId).toBe(historyTabs[0].id)
    })
  })

  describe('Preferences visible close (QA F5 repro)', () => {
    it('Preferences opens from the drawer settings button and closes via its visible close control', async () => {
      // The real settings-modal store drives the (stubbed) AppPreferencesModal
      // mount; its visible close control lives in SettingsModal, so render
      // the real modal shell here by NOT stubbing the close path.
      renderLayout()

      // Open Preferences from the drawer (the mobile path).
      fireEvent.click(await screen.findByLabelText('Open menu'))
      const settingsBtn = await screen.findByLabelText('Settings')
      await act(async () => {
        fireEvent.click(settingsBtn)
      })

      // The modal shell renders with a visible close button.
      const closeBtn = await screen.findByRole('button', {
        name: 'Close Application Preferences'
      })
      await act(async () => {
        fireEvent.click(closeBtn)
      })

      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Close Application Preferences' })
        ).not.toBeInTheDocument()
      )
      expect(useSettingsModalStore.getState().view).toBeNull()
    })
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
    renderLayout()

    // SSHWorkspace is React.lazy — <Suspense> shows ShellSkeleton first, then
    // the lazy chunk resolves and the SSH workspace renders. MobileChatShell
    // (also lazy) wraps workspaceMain which contains the SSH render site.
    const ssh = await screen.findByTestId('ssh-workspace-stub')
    expect(ssh).toBeInTheDocument()
    expect(ssh).toHaveTextContent('Test SSH')
  })
})
