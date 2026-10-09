import type { ShellInfo } from '@shared/types/ipc.types'
import type { SFTPEntry } from '@shared/types/ssh.types'
import { AnimatePresence, type HTMLMotionProps, motion, useReducedMotion } from 'framer-motion'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ActivityRail } from '@/components/ActivityRail'
import { ChatRoute } from '@/components/ChatRoute'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { CreateSnapshotModal } from '@/components/CreateSnapshotModal'
import { FolderKanban } from '@/components/icons'
import { NewProjectModal } from '@/components/NewProjectModal'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { ResizeEdges } from '@/components/ResizeEdges'
import { StatusBar } from '@/components/StatusBar'
import { TitleBar } from '@/components/TitleBar'
import {
  FileExplorerToggleButton,
  panelEdgeToggleButtonClass,
  SidebarToggleButton,
  TitleStripTitle,
  titlebarNoDragStyle
} from '@/components/TitlebarPanelToggles'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { WebTokenGateScreen } from '@/components/WebTokenGateScreen'
import { PaneRenderer } from '@/components/workspace/PaneRenderer'
import { WorkspaceConflictBanner } from '@/components/workspace/WorkspaceConflictBanner'
import { requestCloseAgentChat } from '@/hooks/use-agent-idle-shutdown'
import {
  useUpdateAppSetting,
  useUpdatePanelVisibility,
  waitForPendingAppSettingsPersistence
} from '@/hooks/use-app-settings'
import {
  useAllCommandHistory,
  useCommandHistory,
  useCommandHistoryLoader
} from '@/hooks/use-command-history'
import { useEditorPersistence } from '@/hooks/use-editor-persistence'
import { useFileWatcher } from '@/hooks/use-file-watcher'
import { useMobileActiveLeaf } from '@/hooks/use-mobile-active-leaf'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { PaneDndProvider } from '@/hooks/use-pane-dnd'
import { usePinnedCommandsLoader } from '@/hooks/use-pinned-commands'
import { useRecentCommandsLoader } from '@/hooks/use-recent-commands'
import { useCreateSnapshot, useSnapshotLoader } from '@/hooks/use-snapshots'
import { useSSHConnection } from '@/hooks/use-ssh-connection'
import { useWorkspaceManifestSync } from '@/hooks/use-workspace-manifest-sync'
import { useWorktreeShortcuts } from '@/hooks/use-worktree-shortcuts'
import { saveTerminalLayout } from '@/hooks/useTerminalAutoSave'
import { useWorkspaceOverlayBackStack } from '@/layouts/use-workspace-overlay-back-stack'
import { flushSessionHistory, waitForPendingSessionIndexWrite } from '@/lib/acp-history-persistence'
import { launchAgentInPane } from '@/lib/agent-launch'
import { BUILT_IN_AGENTS } from '@/lib/agents/agent-registry'
import { loadCustomAgents } from '@/lib/agents/custom-agents'
import {
  filesystemApi,
  keyboardApi,
  persistenceApi,
  sshApi,
  terminalApi,
  windowApi
} from '@/lib/api'
import { browserTabHide, browserTabShow } from '@/lib/browser-api'
import { pickCanvasDoc } from '@/lib/canvas-doc'
import { isSaveFileShortcut, requestSaveEditorFile } from '@/lib/editor-save'
import { logFrontendError } from '@/lib/log-api'
import { EASE_OUT } from '@/lib/motion'
import { isMac, macOsTitlebarStripClass } from '@/lib/platform'
import { setRouterNavigate } from '@/lib/router-navigate'
import { sheetCloseAutoFocus } from '@/lib/sheet-focus-return'
import { listen, type UnlistenFn } from '@/lib/tauri-event'
import { isTauriContext } from '@/lib/tauri-runtime'
import { spawnTerminalInPane } from '@/lib/terminal-spawn'
import { getEffectiveThemeId } from '@/lib/themes'
import { cn } from '@/lib/utils'
import { randomUUID } from '@/lib/uuid'
import { checkWebAuthGate, getWebAuthGateState, useWebAuthGate } from '@/lib/web-auth-gate'
import { isWorkspaceRoutePath } from '@/lib/workspace-route'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import {
  useAppearanceMode,
  useColorTheme,
  useConfirmTerminalClose,
  useDefaultShell,
  useMaxTerminalsPerProject,
  useUiZoomLevel
} from '@/stores/app-settings-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import { wireConnectionStatusTracking } from '@/stores/connection-status-store'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore, useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useGitSheetStore } from '@/stores/git-sheet-store'
import { matchesShortcut, useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import {
  useActiveProject,
  useActiveProjectId,
  useProjectActions,
  useProjects,
  useProjectsLoaded
} from '@/stores/project-store'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import {
  useActiveSSHProfile,
  useActiveSSHProfileId,
  useSSHActions,
  useSSHProfiles,
  useSSHStore
} from '@/stores/ssh-store'
import {
  useActiveTerminal,
  useActiveTerminalId,
  useTerminalActions,
  useTerminalStore,
  useTerminals
} from '@/stores/terminal-store'
import { useThemePickerOpen, useThemePickerStore } from '@/stores/theme-picker-store'
import {
  editorTabId,
  findPaneById,
  findPaneContainingTab,
  getActiveFilePathFromTree,
  getActiveTerminalIdFromTree,
  useActiveTab,
  useFullscreenPaneId,
  usePaneRoot,
  useWorkspaceStore,
  type WorkspaceTab
} from '@/stores/workspace-store'
import { UI_ZOOM_DEFAULT, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STEP } from '@/types/settings'

const SSHWorkspace = lazy(() =>
  import('@/components/ssh/SSHWorkspace').then((m) => ({ default: m.SSHWorkspace }))
)
const CommandHistoryModal = lazy(() =>
  import('@/components/CommandHistoryModal').then((m) => ({
    default: m.CommandHistoryModal
  }))
)
const CommandPalette = lazy(() =>
  import('@/components/CommandPalette').then((m) => ({ default: m.CommandPalette }))
)
const GitPanel = lazy(() =>
  import('@/components/git/GitPanel').then((m) => ({ default: m.GitPanel }))
)
const ThemePicker = lazy(() =>
  import('@/components/ThemePicker').then((m) => ({ default: m.ThemePicker }))
)
const FileExplorer = lazy(() =>
  import('@/components/file-explorer/FileExplorer').then((m) => ({ default: m.FileExplorer }))
)
const MobileChatShell = lazy(() =>
  import('@/components/mobile/MobileChatShell').then((m) => ({ default: m.MobileChatShell }))
)
const SSHFileExplorer = lazy(() =>
  import('@/components/ssh/SSHFileExplorer').then((m) => ({ default: m.SSHFileExplorer }))
)
const ProjectSettingsModal = lazy(() =>
  import('@/pages/ProjectSettings').then((m) => ({ default: m.ProjectSettingsModal }))
)
const AppPreferencesModal = lazy(() =>
  import('@/pages/AppPreferences').then((m) => ({ default: m.AppPreferencesModal }))
)

/** Lightweight skeleton Suspense fallback for lazy-loaded shell components. */
function ShellSkeleton(): React.JSX.Element {
  return <Skeleton className="h-full w-full" />
}

/**
 * Width-reveal transition props for the projects sidebar and the file
 * explorer column: 0 → auto width + fade in (~200ms), faster collapse on
 * exit (~150ms). The wrapper animates the width and clips overflow; the
 * inner content keeps its own fixed width so it clips rather than squishes.
 * Under prefers-reduced-motion both directions apply instantly.
 */
function panelRevealMotion(
  reducedMotion: boolean
): Pick<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'exit'> {
  return {
    initial: reducedMotion ? false : { width: 0, opacity: 0 },
    animate: {
      width: 'auto',
      opacity: 1,
      transition: reducedMotion ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }
    },
    exit: reducedMotion
      ? { opacity: 0, transition: { duration: 0 } }
      : { width: 0, opacity: 0, transition: { duration: 0.15, ease: EASE_OUT } }
  }
}

/**
 * Enter/exit for the web-only slim edge toggles that replace a hidden
 * sidebar/explorer. They live in the same AnimatePresence as the panel, so
 * they mount the moment the panel starts collapsing — hold them width-0 and
 * transparent for the panel's 150ms exit so the toggle never briefly
 * double-occupies then jitters.
 */
function edgeToggleMotion(
  reducedMotion: boolean
): Pick<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'exit'> {
  return {
    initial: reducedMotion ? false : { width: 0, opacity: 0 },
    animate: {
      width: 'auto',
      opacity: 1,
      transition: reducedMotion ? { duration: 0 } : { duration: 0.1, delay: 0.15, ease: EASE_OUT }
    },
    exit: reducedMotion
      ? { opacity: 0, transition: { duration: 0 } }
      : { width: 0, opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } }
  }
}

/**
 * Shared close guard for editor tabs: `saving`/`reloading` block closing;
 * the transient `saved` flash does not. Used by the single-close path, the
 * bulk-close dispatch, and the aggregate-confirm classification.
 */
function isEditorTabBusy(filePath: string): boolean {
  const status = useEditorStore.getState().openFiles.get(filePath)?.operationStatus ?? 'idle'
  return status === 'saving' || status === 'reloading'
}

function pluralizeCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * Approved-dirty set for the paths where no dirty-editor consent exists:
 * the direct dispatch (nothing needed confirmation) and the terminal-only
 * "Close" dialog. A targeted editor that is dirty at execute time against
 * this set is skipped with a warn log rather than discarded.
 */
const NO_APPROVED_DIRTY: ReadonlySet<string> = new Set<string>()

/** Aggregate bulk-close confirmation payload (one dialog per bulk action). */
interface BulkCloseRequest {
  tabs: WorkspaceTab[]
  /** Terminals targeted while `confirmTerminalClose` is on. */
  terminalCount: number
  /** Dirty editors targeted (drive the Save & Close / Don't Save actions). */
  dirtyFilePaths: string[]
}

function getShortcutTargetContext(target: EventTarget | null): {
  isInEditor: boolean
  isInTerminal: boolean
  isInInput: boolean
} {
  const element = target instanceof HTMLElement ? target : document.body
  const isInEditor = !!(element.closest('.cm-content') || element.closest('.bn-editor'))
  const isInTerminal = !!element.closest('.xterm')
  const isInInput =
    !isInTerminal &&
    (element.tagName === 'INPUT' ||
      element.tagName === 'TEXTAREA' ||
      element.isContentEditable ||
      !!element.closest('[contenteditable="true"]'))

  return { isInEditor, isInTerminal, isInInput }
}

/**
 * Width of the draggable spacer that clears the macOS native traffic lights
 * (tauri.conf.json trafficLightPosition x=14; three ~12px lights ~8px apart
 * end near x=66). The spacer is its own drag handle so the clearance area
 * stays a window-drag zone; the toggle sits in a separate no-drag container.
 */
const macOsTrafficLightClearance = 'w-[80px] shrink-0'

function MacOsTitlebarStrip(): React.JSX.Element | null {
  // macOS desktop only — native traffic lights + drag region. Web (even on
  // a Mac browser) falls through to the web TitleBar path instead.
  if (!isMac || !isTauriContext()) return null

  return (
    <div
      className={macOsTitlebarStripClass}
      data-tauri-drag-region
      data-testid="macos-titlebar-strip"
    >
      {/* Draggable spacer clearing the native traffic lights so the area
          left of the sidebar toggle stays a window-drag handle. */}
      <div className={`h-full ${macOsTrafficLightClearance}`} data-tauri-drag-region />

      {/* Left-sidebar toggle — no-drag, sits right of the traffic lights. */}
      <div className="flex items-center h-full" style={titlebarNoDragStyle}>
        <SidebarToggleButton />
      </div>

      <TitleStripTitle />

      <div className="flex-1 h-full" data-tauri-drag-region />

      {/* Right-sidebar (file explorer) toggle — top-right. */}
      <div className="flex items-center h-full" style={titlebarNoDragStyle}>
        <FileExplorerToggleButton />
      </div>
    </div>
  )
}

export default function WorkspaceLayout(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const settingsModalView = useSettingsModalView()
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)

  useEffect(() => {
    setRouterNavigate(navigate)
    return () => setRouterNavigate(null)
  }, [navigate])
  // Agent chat entry point (moved from the pane tab bar to the Activity Rail).
  // The dialogs are owned here so the rail button can open them globally; the

  const hiddenBrowserTabForModalRef = useRef<string | null>(null)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isShortcutMenuOpen, setIsShortcutMenuOpen] = useState(false)
  const [isCreateSnapshotModalOpen, setIsCreateSnapshotModalOpen] = useState(false)
  const [closeConfirmTerminal, setCloseConfirmTerminal] = useState<{
    terminalId: string
    tabId: string
  } | null>(null)
  const [closeConfirmLoading, setCloseConfirmLoading] = useState(false)
  const [closeConfirmRememberChoice, setCloseConfirmRememberChoice] = useState(false)
  const [closingTerminalIds, setClosingTerminalIds] = useState<string[]>([])
  const [dirtyCloseFilePath, setDirtyCloseFilePath] = useState<string | null>(null)
  const [bulkClose, setBulkClose] = useState<BulkCloseRequest | null>(null)
  const [bulkCloseLoading, setBulkCloseLoading] = useState(false)
  const [isCommandHistoryOpen, setIsCommandHistoryOpen] = useState(false)
  const [isAppCloseDialogOpen, setIsAppCloseDialogOpen] = useState(false)
  // Mobile-only full-width Sheet rendering GitPanel (single-column mobile
  // branch). Open state + snapshotted cwd live in a store so the chat dock's
  // changed-files bar can open it too.
  const { open: gitSheetOpen, cwd: gitSheetCwd, projectId: gitSheetProjectId } = useGitSheetStore()
  const { openGitSheet, closeGitSheet } = useGitSheetStore.getState()
  const [appCloseDirtyCount, setAppCloseDirtyCount] = useState(0)

  const isLoaded = useProjectsLoaded()

  // #854: probe the web auth gate at boot. On a token-gated server a
  // missing/rotated token 401s the projects mirror (the `!isLoaded` branch
  // below would otherwise spin "Loading..." forever with no way to enter a
  // token — the exact bug). Resolving ok (desktop, ungated server, or valid
  // persisted token) leaves this layout untouched; `unauthorized` swaps the
  // loading state for the token-entry screen. A successful submission flips
  // the gate to ok and the projects loader (gated on
  // useWebAuthGateOk in use-projects-persistence.ts) re-fetches with the
  // fresh Authorization header.
  const webAuthGate = useWebAuthGate()
  useEffect(() => {
    checkWebAuthGate()
  }, [])

  // Warm custom-agent cache so tab icons resolve before the launcher opens.
  useEffect(() => {
    void loadCustomAgents()
  }, [])
  // Story 10: wire the web connection-health feeds (control + terminal
  // channel) into the connection-status store once per workspace mount.
  // No-op on Tauri desktop (the store stays at initial values and the
  // StatusBar indicator renders nothing there).
  useEffect(() => {
    wireConnectionStatusTracking()
  }, [])

  const confirmTerminalClose = useConfirmTerminalClose()
  const projects = useProjects()
  const activeProject = useActiveProject()
  const activeProjectId = useActiveProjectId()
  const {
    selectProject,
    addProject,
    updateProject,
    deleteProject,
    archiveProject,
    restoreProject,
    reorderProjects
  } = useProjectActions()

  const terminals = useTerminals()
  const activeTerminal = useActiveTerminal()
  const activeTerminalId = useActiveTerminalId()
  const { addTerminal, closeTerminal, renameTerminal } = useTerminalActions()

  // File explorer & editor state
  const isExplorerVisible = useFileExplorerVisible()
  const isSidebarVisible = useSidebarVisible()
  const isMobileWebShell = useMobileWebShell()
  const reducedMotion = useReducedMotion() ?? false

  // SSH state
  const sshProfiles = useSSHProfiles()
  const { loadProfiles: loadSSHProfiles, selectProfile: selectSSHProfile } = useSSHActions()
  const activeSSHProfileId = useActiveSSHProfileId()
  const activeSSHProfile = useActiveSSHProfile()
  const [sshPasswordPrompt, setSSHPasswordPrompt] = useState<{
    profileId: string
    profileName: string
  } | null>(null)
  const [sshPasswordInput, setSSHPasswordInput] = useState('')
  const [sshPromptPasswords, setSSHPromptPasswords] = useState<Record<string, string>>({})
  const closeSshPasswordPrompt = useCallback(() => {
    setSSHPasswordPrompt(null)
    setSSHPasswordInput('')
  }, [])

  // The Git sheet's open state lives in `useGitSheetStore` (so the chat dock's
  // changed-files bar can open it); the back stack only ever closes it.
  const setGitSheetOpen = useCallback(
    (open: boolean) => {
      if (!open) closeGitSheet()
    },
    [closeGitSheet]
  )

  // Story 6 + mobile overlay back stack: overlay registrations, the mobile
  // shell flag and the app-root popstate handler live in one hook.
  useWorkspaceOverlayBackStack({
    isMobileWebShell,
    gitSheetOpen,
    setGitSheetOpen,
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    isCommandHistoryOpen,
    setIsCommandHistoryOpen,
    isSshPasswordPromptOpen: sshPasswordPrompt !== null,
    closeSshPasswordPrompt
  })

  const sshProfileWithPassword = activeSSHProfile
    ? {
        ...activeSSHProfile,
        password: sshPromptPasswords[activeSSHProfile.id] ?? activeSSHProfile.password
      }
    : null

  const sshConn = useSSHConnection(sshProfileWithPassword)

  const handleSSHMkdir = useCallback(async () => {
    if (!sshConn.connectionId) return
    const name = prompt('New folder name:')
    if (!name) return
    const newPath = sshConn.currentPath.endsWith('/')
      ? `${sshConn.currentPath}${name}`
      : `${sshConn.currentPath}/${name}`
    try {
      const r = await sshApi.sftpMkdir(sshConn.connectionId, newPath)
      if (r.success) {
        toast.success(`Created: ${name}`)
        sshConn.loadDirectory(sshConn.currentPath)
      } else toast.error(`Failed: ${r.error}`)
    } catch (error) {
      toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory])

  const handleSSHCreateFile = useCallback(async () => {
    if (!sshConn.connectionId) return
    const name = prompt('New file name:')
    if (!name) return
    const newPath = sshConn.currentPath.endsWith('/')
      ? `${sshConn.currentPath}${name}`
      : `${sshConn.currentPath}/${name}`
    try {
      const r = await sshApi.sftpCreateFile(sshConn.connectionId, newPath)
      if (r.success) {
        toast.success(`Created: ${name}`)
        sshConn.loadDirectory(sshConn.currentPath)
      } else toast.error(`Failed: ${r.error}`)
    } catch (error) {
      toast.error(`Failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory])

  const handleSSHDelete = useCallback(
    async (entry: SFTPEntry) => {
      if (!sshConn.connectionId) return
      if (!confirm(`Delete ${entry.entryType} "${entry.name}"?`)) return
      try {
        const r = await sshApi.sftpDelete(sshConn.connectionId, entry.path)
        if (r.success) {
          toast.success(`Deleted: ${entry.name}`)
          sshConn.loadDirectory(sshConn.currentPath)
        } else toast.error(`Delete failed: ${r.error}`)
      } catch (error) {
        toast.error(`Delete failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]
  )

  const handleSSHRename = useCallback(
    async (entry: SFTPEntry) => {
      if (!sshConn.connectionId) return
      const newName = prompt(`Rename "${entry.name}" to:`, entry.name)
      if (!newName || newName === entry.name) return
      const pp = entry.path.substring(0, entry.path.lastIndexOf('/'))
      try {
        const r = await sshApi.sftpRename(sshConn.connectionId, entry.path, `${pp}/${newName}`)
        if (r.success) {
          toast.success(`Renamed: ${entry.name} → ${newName}`)
          sshConn.loadDirectory(sshConn.currentPath)
        } else toast.error(`Rename failed: ${r.error}`)
      } catch (error) {
        toast.error(`Rename failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [sshConn.connectionId, sshConn.currentPath, sshConn.loadDirectory]
  )

  // Load SSH profiles on mount
  useEffect(() => {
    loadSSHProfiles()
  }, [loadSSHProfiles])

  // Reconcile real SSH connection status from the backend (heartbeat,
  // reconnect, failure). Without this the badge can only ever show the
  // optimistic state set at connect time.
  useEffect(() => {
    if (typeof sshApi?.onConnectionStatusChanged !== 'function') return
    const unlisten = sshApi.onConnectionStatusChanged((connectionId, status, error) => {
      useSSHStore.getState().updateConnectionStatus(connectionId, status, error)
    })
    return () => {
      unlisten?.()
    }
  }, [])

  const handleSelectSSHProfile = useCallback(
    (profileId: string) => {
      selectSSHProfile(profileId)
    },
    [selectSSHProfile]
  )

  const handleSelectProject = useCallback(
    (id: string) => {
      selectProject(id)
      selectSSHProfile(null) // Deselect SSH when switching to project
    },
    [selectProject, selectSSHProfile]
  )
  const activeTab = useActiveTab()
  const paneRoot = usePaneRoot()
  const fullscreenPaneId = useFullscreenPaneId()
  const isAgentLauncherOpen = useWorkspaceStore((s) => s.agentLauncherPaneId !== null)
  const fullscreenPane = useMemo(() => {
    if (!fullscreenPaneId) return null
    const pane = findPaneById(paneRoot, fullscreenPaneId)
    return pane?.type === 'leaf' ? pane : null
  }, [fullscreenPaneId, paneRoot])
  // Mobile shell only: a split synced from desktop collapses to the active
  // leaf (read-only; null on desktop so the desktop node is unchanged).
  const mobileActiveLeaf = useMobileActiveLeaf(isMobileWebShell)
  const prevProjectIdRef = useRef<string>('')
  const watchedRootPathRef = useRef<string | null>(null)
  const projectSwitchRequestIdRef = useRef(0)

  // Ref for terminal close handler — used inside keydown effect to avoid
  // declaration-order dependency. The ref is updated each render.
  const handleCloseTerminalRef = useRef<((id: string, tabId: string) => void) | null>(null)

  /** Close the active tab (reused by keyboard shortcut and native menu event). */
  const closeActiveTab = useCallback(() => {
    if (!activeTab) return
    if (activeTab.type === 'editor') {
      const fileState = useEditorStore.getState().openFiles.get(activeTab.filePath)
      if (fileState?.isDirty) {
        setDirtyCloseFilePath(activeTab.filePath)
      } else {
        const didClose = useEditorStore.getState().closeFileIfIdle(activeTab.filePath)
        if (didClose) {
          useWorkspaceStore.getState().removeTab(activeTab.id)
        }
      }
    } else if (activeTab.type === 'git' || activeTab.type === 'git-history') {
      useWorkspaceStore.getState().removeTab(activeTab.id)
    } else if (activeTab.type === 'terminal') {
      handleCloseTerminalRef.current?.(activeTab.terminalId, activeTab.id)
    } else if (activeTab.type === 'browser') {
      useBrowserSessionStore.getState().removeTab(activeTab.browserTabId)
      useWorkspaceStore.getState().removeTab(activeTab.id)
    } else if (activeTab.type === 'agent-chat') {
      requestCloseAgentChat(activeTab.sessionId, () => {
        useWorkspaceStore.getState().removeTab(activeTab.id)
      })
    }
  }, [activeTab])

  // File watcher hook
  useFileWatcher()

  useEffect(() => {
    const persistBeforeUnload = () => {
      if (!activeProjectId) return
      void saveTerminalLayout(activeProjectId).catch((error) => {
        console.warn('Failed to persist terminal layout before reload:', error)
      })
      // R4: force-flush a non-debounced snapshot of every live ACP session's
      // cached payload on refresh unload so the durable copy is at worst one
      // turn behind (never truncated by a live-window trim). Best-effort: a
      // hard refresh may still abort the in-flight async drain (matching
      // `persistSession`'s never-throw contract) — log on failure, never
      // throw on unload.
      try {
        useAcpStore.getState().flushLiveSessionSaves()
      } catch (error) {
        console.warn('Failed to snapshot ACP sessions before reload:', error)
      }
      void flushSessionHistory().catch((error) => {
        console.warn('Failed to flush ACP history before reload:', error)
      })
    }

    window.addEventListener('beforeunload', persistBeforeUnload)
    window.addEventListener('pagehide', persistBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', persistBeforeUnload)
      window.removeEventListener('pagehide', persistBeforeUnload)
    }
  }, [activeProjectId])

  // Worktree shortcut handlers
  useWorktreeShortcuts()

  // Sync file explorer root path and register project root watcher when project changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeProject?.path covers the only property used
  useEffect(() => {
    const nextRootPathCandidate = activeProject?.path
    if (
      !activeProject ||
      typeof nextRootPathCandidate !== 'string' ||
      nextRootPathCandidate === ''
    ) {
      // Project removed or has no path — clear explorer root and unwatch
      useFileExplorerStore.getState().setRootPath('')
      if (watchedRootPathRef.current) {
        filesystemApi.unwatchDirectory(watchedRootPathRef.current)
        watchedRootPathRef.current = null
      }
      prevProjectIdRef.current = activeProjectId
      return
    }
    if (activeProjectId === prevProjectIdRef.current) {
      return
    }

    const nextRootPath = nextRootPathCandidate

    const switchRequestId = ++projectSwitchRequestIdRef.current
    const previousWatchedRoot = watchedRootPathRef.current

    let cancelled = false

    async function applyProjectSwitch(): Promise<void> {
      try {
        const watchResult = await filesystemApi.watchDirectory(nextRootPath)

        if (cancelled || switchRequestId !== projectSwitchRequestIdRef.current) {
          filesystemApi.unwatchDirectory(nextRootPath)
          return
        }

        if (!watchResult.success) {
          useFileExplorerStore.getState().setRootPath(nextRootPath)
          useFileExplorerStore.getState().setRootLoadError({
            message: watchResult.error,
            code: watchResult.code
          })
          return
        }

        useFileExplorerStore.getState().setRootPath(nextRootPath)

        if (previousWatchedRoot && previousWatchedRoot !== nextRootPath) {
          filesystemApi.unwatchDirectory(previousWatchedRoot)
        }

        watchedRootPathRef.current = nextRootPath
        prevProjectIdRef.current = activeProjectId
      } catch (error) {
        if (cancelled || switchRequestId !== projectSwitchRequestIdRef.current) {
          return
        }

        const message = error instanceof Error ? error.message : 'Failed to watch project directory'
        useFileExplorerStore.getState().setRootPath(nextRootPath)
        useFileExplorerStore.getState().setRootLoadError({
          message,
          code: 'WATCH_FAILED'
        })
      }
    }

    void applyProjectSwitch()

    return () => {
      cancelled = true
    }
  }, [activeProject?.path, activeProjectId])

  // Editor state persistence
  useEditorPersistence(activeProjectId)

  // Story 6: cross-client workspace manifest sync (load happens inside
  // useEditorPersistence's restore flow via loadAndRestoreManifest; this hook
  // wires the debounced write side + conflict surfacing).
  useWorkspaceManifestSync(activeProjectId)

  useEffect(() => {
    return () => {
      if (watchedRootPathRef.current) {
        filesystemApi.unwatchDirectory(watchedRootPathRef.current)
      }
    }
  }, [])

  // Ensure tabs exist for currently visible project terminals.
  // Project workspace loading/removal is owned by persistence + restore flows.
  // Debounce: rapid terminal store mutations (addTerminal → setTerminalPtyId →
  // addTabToPane) settle before syncTerminalTabs runs, preventing the MOUNT/UNMOUNT
  // cascade where intermediate states look like "orphaned" tabs.
  const ensureCallCountRef = useRef(0)
  const lastEnsuredTerminalIdsRef = useRef<string[]>([])
  const lastEnsuredProjectIdRef = useRef<string>('')
  const syncDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const terminalIds = terminals.map((terminal) => terminal.id)

    // Clear any pending debounce — only the latest mutation triggers a sync.
    if (syncDebounceTimerRef.current) {
      clearTimeout(syncDebounceTimerRef.current)
      syncDebounceTimerRef.current = null
    }

    // If we switched projects, we should wait for the persistence layer (useEditorPersistence)
    // to finish its job of replacing the entire workspace tree.
    // Forcing a sync on the WRONG tree (the old project's tree) causes "leaking" tabs.
    if (activeProjectId !== lastEnsuredProjectIdRef.current) {
      lastEnsuredTerminalIdsRef.current = terminalIds
      lastEnsuredProjectIdRef.current = activeProjectId
      // We skip the sync here because useEditorPersistence will handle the initial layout.
      return
    }

    const prevIds = lastEnsuredTerminalIdsRef.current
    if (terminalIds.length === prevIds.length && terminalIds.every((id, i) => id === prevIds[i])) {
      return
    }

    // Debounce: wait for store mutations to settle before syncing tabs.
    // This prevents the cascade where syncTerminalTabs runs between addTerminal
    // and addTabToPane, sees a tab as orphaned, removes it, triggering
    // ConnectedTerminal unmount and a restore re-trigger.
    syncDebounceTimerRef.current = setTimeout(() => {
      lastEnsuredTerminalIdsRef.current = terminalIds
      const ensureId = `ensure-${ensureCallCountRef.current++}-${Date.now().toString().slice(-6)}`

      console.log(`[WorkspaceLayout] syncTerminalTabs CALL [${ensureId}]`, {
        projectId: activeProjectId,
        terminalCount: terminalIds.length,
        terminalIds,
        prevCount: prevIds.length,
        callCount: ensureCallCountRef.current
      })

      const workspaceStore = useWorkspaceStore.getState()
      workspaceStore.syncTerminalTabs(terminalIds)
    }, 100)

    return () => {
      if (syncDebounceTimerRef.current) {
        clearTimeout(syncDebounceTimerRef.current)
        syncDebounceTimerRef.current = null
      }
    }
  }, [terminals, activeProjectId])

  // Sync legacy stores (activeTerminalId, activeFilePath) from workspace pane tree
  useEffect(() => {
    return useWorkspaceStore.subscribe((state, prevState) => {
      if (state.root === prevState.root && state.activePaneId === prevState.activePaneId) return

      const terminalId = getActiveTerminalIdFromTree(state)
      if (terminalId !== null) {
        const termStore = useTerminalStore.getState()
        if (termStore.activeTerminalId !== terminalId) {
          termStore.selectTerminal(terminalId)
        }
      }

      const filePath = getActiveFilePathFromTree(state)
      const editorStore = useEditorStore.getState()
      if (editorStore.activeFilePath !== filePath) {
        editorStore.setActiveFilePath(filePath)
      }
    })
  }, [])

  const closeAppWithPersistenceFlush = useCallback(async () => {
    try {
      const [
        pendingAppSettingsResult,
        pendingPersistenceResult,
        pendingSessionIndexResult,
        historyFlushResult
      ] = await Promise.allSettled([
        waitForPendingAppSettingsPersistence(),
        persistenceApi.flushPendingWrites(),
        waitForPendingSessionIndexWrite(),
        flushSessionHistory()
      ])

      if (pendingAppSettingsResult.status === 'rejected') {
        console.error(
          'Failed to wait for app settings persistence before close:',
          pendingAppSettingsResult.reason
        )
      }

      // Note: waitForPendingSessionIndexWrite swallows rejections internally
      // (trackPendingIndexWrite catches and logs them), so this branch is
      // effectively dead code — kept as a defensive guard in case the
      // swallowing behavior changes.
      if (pendingSessionIndexResult.status === 'rejected') {
        console.error(
          'Failed to wait for session index persistence before close:',
          pendingSessionIndexResult.reason
        )
      }

      if (historyFlushResult.status === 'rejected') {
        console.error('Failed to flush ACP history before close:', historyFlushResult.reason)
      }

      if (pendingPersistenceResult.status === 'fulfilled') {
        if (!pendingPersistenceResult.value.success) {
          console.error(
            'Failed to flush pending persistence writes before close:',
            pendingPersistenceResult.value.error
          )
        }
      } else {
        console.error(
          'Failed to flush pending persistence writes before close:',
          pendingPersistenceResult.reason
        )
      }
    } finally {
      windowApi.respondToClose('close')
      setIsAppCloseDialogOpen(false)
    }
  }, [])

  // Intercept app close to check for unsaved files
  useEffect(() => {
    return windowApi.onCloseRequested(() => {
      const dirtyCount = useEditorStore.getState().getDirtyFileCount()
      if (dirtyCount > 0) {
        setAppCloseDirtyCount(dirtyCount)
        setIsAppCloseDialogOpen(true)
      } else {
        void closeAppWithPersistenceFlush()
      }

      return Promise.resolve(false)
    })
  }, [closeAppWithPersistenceFlush])

  // Tray Quit is an explicit app-quit request. It reuses the renderer's
  // existing dirty-file prompt and persistence flush instead of bypassing it
  // with a native app.exit(0).
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let disposed = false
    listen<void>('tray:quit-requested', () => {
      const dirtyCount = useEditorStore.getState().getDirtyFileCount()
      if (dirtyCount > 0) {
        setAppCloseDirtyCount(dirtyCount)
        setIsAppCloseDialogOpen(true)
      } else {
        void closeAppWithPersistenceFlush()
      }
    })
      .then((fn) => {
        if (disposed) {
          fn()
        } else {
          unlisten = fn
        }
      })
      .catch((error) => {
        console.error('Failed to register tray quit listener:', error)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [closeAppWithPersistenceFlush])

  // Listen for native menu "Close Tab" event (macOS Cmd+W intercepted by menu bar)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    listen<void>('menu:close-tab', () => {
      // Skip when Agent Launcher is open to avoid accidental tab closure
      if (!isAgentLauncherOpen) {
        closeActiveTab()
      }
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {
        // Not in Tauri context — ignore
      })
    return () => {
      unlisten?.()
    }
  }, [closeActiveTab, isAgentLauncherOpen])

  // Load snapshots when project changes
  useSnapshotLoader()
  // Load recent commands for command palette
  useRecentCommandsLoader()
  // Load pinned commands for command palette
  usePinnedCommandsLoader()
  // Load command history for current project
  useCommandHistoryLoader(activeProjectId)
  const commandHistory = useCommandHistory(activeProjectId)
  const allCommandHistory = useAllCommandHistory()
  const createSnapshot = useCreateSnapshot()

  const handleCreateSnapshot = useCallback(
    async (name: string, description?: string) => {
      await createSnapshot(name, description)
    },
    [createSnapshot]
  )

  const handleOpenSnapshotModal = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsCreateSnapshotModalOpen(true)
  }, [])

  // OpenPencil canvas mode (CAP-1): the palette command resolves the
  // project's `.op` document (first one in the project root, via the pure
  // pickCanvasDoc helper) and opens it as the singleton canvas tab. The
  // palette hides the command on the mobile shell; the canvas facade gates
  // direct calls with a typed UNSUPPORTED_SURFACE failure.
  const handleOpenCanvas = useCallback(() => {
    setIsCommandPaletteOpen(false)
    if (!activeProjectId) return
    const projectPath = activeProject?.path
    if (!projectPath) {
      toast.error('The active project has no root folder to search for a .op document.')
      return
    }
    void (async () => {
      const result = await filesystemApi.readDirectory(projectPath)
      if (!result.success) {
        toast.error(`Could not read the project folder: ${result.error}`)
        return
      }
      const opDoc = pickCanvasDoc(result.data)
      if (!opDoc) {
        toast.info('No .op document found in the project root.')
        return
      }
      await useCanvasStore.getState().openCanvas(activeProjectId, opDoc.path)
    })()
  }, [activeProjectId, activeProject?.path])

  // Keyboard shortcuts
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  const handleOpenProjectSettings = useCallback(() => {
    setIsCommandPaletteOpen(false)
    useSettingsModalStore.getState().openProject()
  }, [])

  const handleOpenAppPreferences = useCallback(() => {
    setIsCommandPaletteOpen(false)
    if (useThemePickerStore.getState().isOpen) {
      useThemePickerStore.getState().cancel()
    }
    useSettingsModalStore.getState().openApp()
  }, [])

  const handleOpenCommandHistory = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsCommandHistoryOpen(true)
  }, [])

  const handleOpenShortcutMenu = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsShortcutMenuOpen(true)
  }, [])

  // SSH - just select profile (SSH workspace handles its own connect/terminal)
  const handleSSHConnect = useCallback(
    (profileId: string) => {
      const profile = sshProfiles.find((p) => p.id === profileId)
      if (!profile) return

      if (profile.authMethod === 'password' && !profile.hasStoredPassword) {
        // No password in OS keychain — show password prompt
        setSSHPasswordPrompt({ profileId, profileName: profile.name })
        setSSHPasswordInput('')
      } else {
        // Select profile → SSH workspace handles connect
        selectSSHProfile(profileId)
      }
    },
    [sshProfiles, selectSSHProfile]
  )

  const handleSSHPasswordSubmit = useCallback(() => {
    if (!sshPasswordPrompt) return
    const password = sshPasswordInput
    setSSHPromptPasswords((prev) => ({
      ...prev,
      [sshPasswordPrompt.profileId]: password
    }))
    setSSHPasswordPrompt(null)
    setSSHPasswordInput('')
    selectSSHProfile(sshPasswordPrompt.profileId)
  }, [sshPasswordPrompt, sshPasswordInput, selectSSHProfile])

  const getShortcutLabel = useCallback(
    (id: string): string | undefined => {
      const shortcut = shortcuts[id]
      return shortcut ? (shortcut.customKey ?? shortcut.defaultKey) : undefined
    },
    [shortcuts]
  )

  const getProjectShortcutLabel = useCallback(
    (index: number): string | undefined => {
      const shortcut = shortcuts[`project-${index + 1}`]
      return shortcut ? (shortcut.customKey ?? shortcut.defaultKey) : undefined
    },
    [shortcuts]
  )

  const uiZoomLevel = useUiZoomLevel()
  const colorTheme = useColorTheme()
  const appearanceMode = useAppearanceMode()

  const isThemePickerOpen = useThemePickerOpen()

  const closeThemePickerPeerOverlays = useCallback(() => {
    setIsCommandPaletteOpen(false)
    setIsShortcutMenuOpen(false)
    setIsCommandHistoryOpen(false)
    // Close the settings modal too — the old code closed the /preferences
    // route via navigate('/') before opening the theme picker. The route is
    // gone, so close the modal via the store (EdgeCaseHunter #3).
    useSettingsModalStore.getState().close()
  }, [])

  const handleToggleThemePicker = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    closeThemePickerPeerOverlays()
    useThemePickerStore.getState().toggle(getEffectiveThemeId(colorTheme, appearanceMode))
  }, [appearanceMode, closeThemePickerPeerOverlays, colorTheme])

  const handleOpenThemePicker = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    closeThemePickerPeerOverlays()
    const store = useThemePickerStore.getState()
    if (!store.isOpen) {
      store.open(getEffectiveThemeId(colorTheme, appearanceMode))
    }
  }, [appearanceMode, closeThemePickerPeerOverlays, colorTheme])

  const appDefaultShell = useDefaultShell()
  const maxTerminals = useMaxTerminalsPerProject()
  const updateAppSetting = useUpdateAppSetting()
  const updatePanelVisibility = useUpdatePanelVisibility()

  // Helper to get active key for a shortcut
  const getActiveKey = useCallback(
    (id: string): string => {
      const shortcut = shortcuts[id]
      return shortcut?.customKey ?? shortcut?.defaultKey ?? ''
    },
    [shortcuts]
  )

  // Shared whole-UI zoom action used by both the DOM keydown path and the
  // keyboardApi.onShortcut callback so behavior stays identical.
  const applyZoomAction = useCallback(
    (action: 'zoomIn' | 'zoomOut' | 'zoomReset'): void => {
      const next =
        action === 'zoomIn'
          ? Math.min(uiZoomLevel + UI_ZOOM_STEP, UI_ZOOM_MAX)
          : action === 'zoomOut'
            ? Math.max(uiZoomLevel - UI_ZOOM_STEP, UI_ZOOM_MIN)
            : UI_ZOOM_DEFAULT
      if (next !== uiZoomLevel) updateAppSetting('uiZoomLevel', next)
    },
    [uiZoomLevel, updateAppSetting]
  )

  // Determine if we should show the terminal area (only on workspace dashboard)
  const isWorkspaceRoute = isWorkspaceRoutePath(location.pathname)

  // Unified tab cycling - cycles through ALL workspace tabs in active pane
  const cycleTab = useCallback(
    (direction: 'next' | 'prev') => {
      if (!isWorkspaceRoute) return
      const store = useWorkspaceStore.getState()
      const nextTabId = store.getNextTabId(direction === 'next' ? 1 : -1)
      if (nextTabId) {
        store.setActiveTab(store.activePaneId, nextTabId)
      }
    },
    [isWorkspaceRoute]
  )

  // Terminal creation callbacks - defined before keyboard shortcut useEffect
  const handleCreateTerminalInPane = useCallback(
    async (paneId: string, shellName?: string) => {
      const cwd = getDefaultCwdForProject(activeProjectId)

      const result = await spawnTerminalInPane(paneId, activeProjectId, cwd, {
        shell: shellName || activeProject?.defaultShell || appDefaultShell || undefined,
        envVars: activeProject?.envVars,
        maxTerminalsPerProject: maxTerminals
      })
      if (!result.success) {
        toast.error(result.error || 'Failed to create terminal')
      }
    },
    [
      activeProject?.defaultShell,
      activeProject?.envVars,
      activeProjectId,
      appDefaultShell,
      maxTerminals
    ]
  )

  // ADR-004.5: command-bar "Launch Agent" entry. Launches the default agent's
  // TUI in the active pane with no seed prompt so the user composes inside the
  // agent UI; the empty-pane launcher offers the full prompt+picker flow.
  const handleLaunchAgent = useCallback(async () => {
    const paneId = useWorkspaceStore.getState().activePaneId
    if (!paneId || !activeProjectId) return
    const cwd = getDefaultCwdForProject(activeProjectId)
    const result = await launchAgentInPane(
      paneId,
      activeProjectId,
      cwd,
      BUILT_IN_AGENTS[0],
      undefined,
      {
        envVars: activeProject?.envVars,
        maxTerminalsPerProject: maxTerminals
      }
    )
    if (!result.success) {
      toast.error(result.error || 'Failed to launch agent')
    }
  }, [activeProjectId, activeProject?.envVars, maxTerminals])

  const handleAddTerminal = useCallback(
    (paneId: string | undefined, shell?: ShellInfo) => {
      const targetPaneId = paneId ?? useWorkspaceStore.getState().activePaneId
      if (!targetPaneId) return
      if (shell) {
        handleCreateTerminalInPane(targetPaneId, shell.path)
      } else {
        handleCreateTerminalInPane(targetPaneId)
      }
    },
    [handleCreateTerminalInPane]
  )

  const handleNewBrowserTab = useCallback((paneId?: string) => {
    const resolvedPaneId = paneId ?? useWorkspaceStore.getState().activePaneId
    if (resolvedPaneId) {
      const browserTabId = randomUUID()
      useBrowserSessionStore.getState().createTab(browserTabId)
      useWorkspaceStore.getState().addBrowserTab(browserTabId, resolvedPaneId)
    }
  }, [])

  const handleOpenAgentChat = useCallback(() => {
    if (!activeProject?.path) return
    const open = (): void => {
      const paneId = useWorkspaceStore.getState().activePaneId
      if (paneId) useWorkspaceStore.getState().showAgentLauncher(paneId)
    }
    // The launcher overlay only renders on the workspace route; navigate there
    // first when invoked from a child route (e.g. preferences/settings).
    if (location.pathname !== '/') {
      navigate('/')
      requestAnimationFrame(open)
    } else {
      open()
    }
  }, [activeProject?.path, location.pathname, navigate])

  const handleAddGitTab = useCallback(
    (paneId?: string) => {
      const resolvedPaneId = paneId ?? useWorkspaceStore.getState().activePaneId
      if (resolvedPaneId && activeProject?.path) {
        // Reuse-by-(type, cwd): activating the existing tab instead of
        // minting `git-${randomUUID()}` per click (QA: 4 clicks → 4 tabs).
        useWorkspaceStore.getState().addGitTab(activeProject.path, resolvedPaneId)
      }
    },
    [activeProject?.path]
  )

  // Close the mobile Git Changes sheet if the active project loses its path
  // or changes from the one it opened on (its cwd is a snapshot); also on
  // unmount so a remount starts cold like the old local state did.
  useEffect(() => {
    const moved = gitSheetProjectId && activeProject?.id !== gitSheetProjectId
    if (gitSheetOpen && (!activeProject?.path || moved)) closeGitSheet()
  }, [gitSheetOpen, gitSheetProjectId, activeProject?.id, activeProject?.path, closeGitSheet])
  useEffect(() => () => closeGitSheet(), [closeGitSheet])

  const handleAddGitHistoryTab = useCallback(
    (paneId?: string) => {
      const resolvedPaneId = paneId ?? useWorkspaceStore.getState().activePaneId
      if (!resolvedPaneId) return
      // Resolve the default cwd (the main project root) so the history view
      // reflects the full repo, not a transient worktree binding.
      const resolvedCwd = getDefaultCwdForProject(activeProjectId)
      if (!resolvedCwd) return
      // Reuse-by-(type, cwd): repeated opens activate the existing
      // git-history tab for this repo instead of stacking duplicates.
      useWorkspaceStore.getState().addGitHistoryTab(resolvedCwd, resolvedPaneId)
    },
    [activeProjectId]
  )

  // Capture-phase save so WebView/editors cannot block Ctrl+S before it
  // reaches us. #907: while the web auth gate has the workspace swapped for
  // the token screen, the (hidden) workspace's save shortcut must stay
  // inert — typing Ctrl+S in the token field must never save the hidden
  // active editor.
  useEffect(() => {
    const handleSaveShortcut = (e: KeyboardEvent): void => {
      // Live gate state via the accessor — the guard stays correct without
      // re-registering the listener on every gate transition.
      if (getWebAuthGateState().status === 'unauthorized') return
      if (!isSaveFileShortcut(e)) return
      e.preventDefault()
      e.stopPropagation()
      const path =
        activeTab?.type === 'editor' ? activeTab.filePath : useEditorStore.getState().activeFilePath
      if (path) {
        void requestSaveEditorFile(path)
      }
    }

    window.addEventListener('keydown', handleSaveShortcut, { capture: true })
    return () => window.removeEventListener('keydown', handleSaveShortcut, { capture: true })
  }, [activeTab])

  // biome-ignore lint/correctness/useExhaustiveDependencies: handler reads latest values via closure; deps intentionally narrow
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isSaveFileShortcut(e)) return
      // #907: workspace shortcuts stay inert while the token screen owns
      // the surface (same guard as the capture-phase save handler above).
      // Read via the non-React accessor so the guard sees the LIVE gate
      // state without widening this effect's deps (CI contention).
      if (getWebAuthGateState().status === 'unauthorized') return

      // Safety net: skip workspace handling when an earlier handler has already
      // processed this event by calling preventDefault() — e.g. xterm clipboard
      // ops or ConnectedTerminal's customKeyEventHandler for terminal-owned keys.
      if (e.defaultPrevented) return

      const { isInEditor, isInTerminal, isInInput } = getShortcutTargetContext(e.target)

      // Close Tab (Ctrl+W / ⌘+W)
      // On macOS: ⌘+W closes tab, Ctrl+W is forwarded to shell (backward-kill-word)
      // On Windows/Linux: Ctrl+W closes tab
      // Always preventDefault to suppress OS/webview close behavior; only
      // close the tab when the Agent Launcher is not open.
      if (matchesShortcut(e, getActiveKey('closeTab'))) {
        e.preventDefault()
        if (!isAgentLauncherOpen) {
          closeActiveTab()
        }
        return
      }

      // Toggle File Explorer (Ctrl+B / ⌘+B) — skip when in editor/input/terminal
      if (matchesShortcut(e, getActiveKey('toggleFileExplorer'))) {
        if (!isInEditor && !isInInput && !isInTerminal) {
          e.preventDefault()
          void updatePanelVisibility('fileExplorerVisible', !isExplorerVisible).catch((error) => {
            toast.error(
              error instanceof Error ? error.message : 'Failed to update file explorer visibility'
            )
          })
        }
        return
      }

      if (matchesShortcut(e, getActiveKey('sidebarToggle'))) {
        if (!isInEditor && !isInInput) {
          e.preventDefault()
          e.stopPropagation()
          void updatePanelVisibility('sidebarVisible', !isSidebarVisible).catch((error) => {
            toast.error(
              error instanceof Error ? error.message : 'Failed to update sidebar visibility'
            )
          })
        }
        return
      }

      // ── Global shortcuts — work from any focus context ────────────────
      // These must be checked before the isInInput/isInEditor guard.
      // They open overlays or perform workspace actions that should be
      // reachable while typing in the editor, browser, or terminal.

      // Command palette (Ctrl+K / Ctrl+Shift+P)
      if (
        matchesShortcut(e, getActiveKey('commandPalette')) ||
        matchesShortcut(e, getActiveKey('commandPaletteAlt'))
      ) {
        e.preventDefault()
        e.stopPropagation()
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        setIsCommandPaletteOpen(true)
        return
      }

      // Command history (Ctrl+R)
      if (matchesShortcut(e, getActiveKey('commandHistory'))) {
        e.preventDefault()
        e.stopPropagation()
        if (activeProjectId) {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur()
          }
          setIsCommandHistoryOpen(true)
        }
        return
      }

      // Color theme picker (Ctrl+Alt+T)
      if (matchesShortcut(e, getActiveKey('colorThemePicker'))) {
        e.preventDefault()
        e.stopPropagation()
        handleOpenThemePicker()
        return
      }

      // New project (Ctrl+N)
      if (matchesShortcut(e, getActiveKey('newProject'))) {
        e.preventDefault()
        e.stopPropagation()
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        setIsNewProjectModalOpen(true)
        return
      }

      // Ctrl+T: show the agent launcher prompt overlay in the active pane.
      // The launcher is an overlay — existing tabs are preserved underneath.
      // When the agent is launched, a new tab is added to the same pane.
      if (matchesShortcut(e, getActiveKey('newTerminal'))) {
        if (!isWorkspaceRoute) return
        e.preventDefault()
        e.stopPropagation()
        const paneId = useWorkspaceStore.getState().activePaneId
        if (paneId) {
          const current = useWorkspaceStore.getState().agentLauncherPaneId
          // Toggle: if already showing on this pane, hide it; otherwise show it.
          if (current === paneId) {
            useWorkspaceStore.getState().hideAgentLauncher()
          } else {
            useWorkspaceStore.getState().showAgentLauncher(paneId)
          }
        }
        return
      }

      // New browser tab (Ctrl+Shift+N) - workspace only, desktop only.
      // Story 8 (web honesty): browser tabs are native child webviews — the
      // web client cannot create them, so the shortcut must no-op there
      // instead of adding a tab whose pane renders blank (rejected
      // browserTabCreate).
      if (matchesShortcut(e, getActiveKey('newBrowserTab'))) {
        if (!isWorkspaceRoute || !isTauriContext()) return
        e.preventDefault()
        e.stopPropagation()
        handleNewBrowserTab()
        return
      }

      // Tab cycling (Ctrl+PageDown / Ctrl+PageUp)
      if (matchesShortcut(e, getActiveKey('nextTerminal'))) {
        e.preventDefault()
        e.stopPropagation()
        cycleTab('next')
        return
      }
      if (matchesShortcut(e, getActiveKey('prevTerminal'))) {
        e.preventDefault()
        e.stopPropagation()
        cycleTab('prev')
        return
      }

      // Zoom in/out/reset — whole-UI zoom (VS Code style)
      if (matchesShortcut(e, getActiveKey('zoomIn'))) {
        e.preventDefault()
        e.stopPropagation()
        applyZoomAction('zoomIn')
        return
      }
      if (matchesShortcut(e, getActiveKey('zoomOut'))) {
        e.preventDefault()
        e.stopPropagation()
        applyZoomAction('zoomOut')
        return
      }
      if (matchesShortcut(e, getActiveKey('zoomReset'))) {
        e.preventDefault()
        e.stopPropagation()
        applyZoomAction('zoomReset')
        return
      }

      // Cmd/Ctrl + 1-9 for project switching
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const index = parseInt(e.key, 10) - 1
        if (projects[index]) selectProject(projects[index].id)
        return
      }

      // ── Below this: only runs when NOT in input/editor ────────────────
      // Terminal search (Ctrl+F) - handled at pane level
      if (matchesShortcut(e, getActiveKey('terminalSearch'))) {
        if (isWorkspaceRoute) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    projects,
    selectProject,
    addTerminal,
    terminals,
    activeProjectId,
    activeProject,
    activeTerminalId,
    activeTerminal,
    getActiveKey,
    applyZoomAction,
    appDefaultShell,
    maxTerminals,
    isWorkspaceRoute,
    cycleTab,
    activeTab,
    handleCreateTerminalInPane,
    handleNewBrowserTab,
    updatePanelVisibility,
    isExplorerVisible,
    isSidebarVisible,
    handleOpenThemePicker,
    closeActiveTab,
    isAgentLauncherOpen
  ])

  useEffect(() => {
    // Hide the active browser webview while a modal/overlay is open, since native
    // child webviews paint above the DOM and would otherwise obscure it. Covers
    // the New Project modal and the agent launcher overlay. The browser consent
    // prompt no longer hides the pane: it renders as the in-pane
    // BrowserConsentStrip or the in-chat BrowserConsentCard, neither of which
    // overlays the webview (spec-acp-browser-automation-v2 CAP-5).
    const modalOpen = isNewProjectModalOpen || isAgentLauncherOpen
    if (modalOpen) {
      if (activeTab?.type === 'browser') {
        hiddenBrowserTabForModalRef.current = activeTab.browserTabId
        browserTabHide(activeTab.browserTabId).catch(console.error)
      }
      return
    }

    const hiddenBrowserTabId = hiddenBrowserTabForModalRef.current
    if (hiddenBrowserTabId) {
      browserTabShow(hiddenBrowserTabId).catch(console.error)
      hiddenBrowserTabForModalRef.current = null
    }
  }, [isNewProjectModalOpen, isAgentLauncherOpen, activeTab])

  // Listen for optional backend shortcut callbacks. In current Tauri fallback mode this is effectively a future-compat shim.
  useEffect(() => {
    return keyboardApi.onShortcut((shortcut) => {
      switch (shortcut) {
        case 'nextTerminal':
          cycleTab('next')
          break
        case 'prevTerminal':
          cycleTab('prev')
          break
        case 'zoomIn':
          applyZoomAction('zoomIn')
          break
        case 'zoomOut':
          applyZoomAction('zoomOut')
          break
        case 'zoomReset':
          applyZoomAction('zoomReset')
          break
        case 'sidebarToggle':
          void updatePanelVisibility('sidebarVisible', !isSidebarVisible).catch((error) => {
            toast.error(
              error instanceof Error ? error.message : 'Failed to update sidebar visibility'
            )
          })
          break
        case 'colorThemePicker':
          handleOpenThemePicker()
          break
      }
    })
  }, [cycleTab, applyZoomAction, handleOpenThemePicker, updatePanelVisibility, isSidebarVisible])

  const closeTerminalByRecordId = useCallback(
    async (terminalRecordId: string): Promise<boolean> => {
      const terminalToClose = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === terminalRecordId)

      if (!terminalToClose) {
        return false
      }

      if (closingTerminalIds.includes(terminalRecordId)) {
        return false
      }

      setClosingTerminalIds((current) => [...current, terminalRecordId])

      try {
        if (terminalToClose.ptyId) {
          const result = await terminalApi.kill(terminalToClose.ptyId)
          if (!result.success) {
            console.error('Failed to close terminal PTY:', result.error)
            toast.error(result.error || 'Failed to close terminal process. Please try again.')
            return false
          }
        }

        closeTerminal(terminalRecordId, activeProjectId)
        return true
      } finally {
        setClosingTerminalIds((current) => current.filter((id) => id !== terminalRecordId))
      }
    },
    [activeProjectId, closeTerminal, closingTerminalIds]
  )

  const closeTerminalTabByTabId = useCallback(
    async (tabId: string): Promise<boolean> => {
      const root = useWorkspaceStore.getState().root
      const containingPane = findPaneContainingTab(root, tabId)
      if (!containingPane) {
        return false
      }

      const tab = containingPane.tabs.find((t) => t.id === tabId)
      if (tab?.type !== 'terminal') {
        return false
      }

      const didClose = await closeTerminalByRecordId(tab.terminalId)
      if (!didClose) {
        return false
      }
      useWorkspaceStore.getState().closeTab(containingPane.id, tabId)
      return true
    },
    [closeTerminalByRecordId]
  )

  // Returns true only when it opened the close confirm, so a caller that sits
  // under that dialog (the mobile drawer) knows to get out of its way. Closing
  // at once, or refusing a terminal that is already closing, returns false.
  const handleCloseTerminal = useCallback(
    (id: string, tabId: string): boolean => {
      if (closingTerminalIds.includes(id)) {
        return false
      }

      if (!confirmTerminalClose) {
        void closeTerminalTabByTabId(tabId)
        return false
      }

      setCloseConfirmRememberChoice(false)
      setCloseConfirmTerminal({ terminalId: id, tabId })
      return true
    },
    [closeTerminalTabByTabId, closingTerminalIds, confirmTerminalClose]
  )

  // Keep ref in sync so the keydown effect can call it without declaration-order issues
  handleCloseTerminalRef.current = handleCloseTerminal

  const handleConfirmCloseTerminal = useCallback(async () => {
    if (!closeConfirmTerminal) {
      return
    }

    setCloseConfirmLoading(true)
    try {
      if (closeConfirmRememberChoice) {
        await updateAppSetting('confirmTerminalClose', false)
      }

      const didClose = await closeTerminalTabByTabId(closeConfirmTerminal.tabId)
      if (didClose) {
        setCloseConfirmTerminal(null)
        setCloseConfirmRememberChoice(false)
      }
    } finally {
      setCloseConfirmLoading(false)
    }
  }, [closeConfirmRememberChoice, closeConfirmTerminal, closeTerminalTabByTabId, updateAppSetting])

  const handleCancelCloseTerminal = useCallback(() => {
    if (closeConfirmLoading) {
      return
    }

    setCloseConfirmRememberChoice(false)
    setCloseConfirmTerminal(null)
  }, [closeConfirmLoading])

  // Dirty file close handlers. Returns true only when it opened the dirty-file
  // confirm (see `handleCloseTerminal`).
  const handleCloseEditorTab = useCallback((filePath: string): boolean => {
    const fileState = useEditorStore.getState().openFiles.get(filePath)
    if (fileState?.operationStatus === 'saving' || fileState?.operationStatus === 'reloading') {
      return false
    }
    if (fileState?.isDirty) {
      setDirtyCloseFilePath(filePath)
      return true
    }
    useEditorStore.getState().closeFileIfIdle(filePath)
    useWorkspaceStore.getState().removeTab(editorTabId(filePath))
    return false
  }, [])

  const handleSaveThenClose = useCallback(async () => {
    if (dirtyCloseFilePath) {
      const saved = await useEditorStore.getState().saveFile(dirtyCloseFilePath)
      if (!saved) {
        toast.error('Failed to save file. Changes were not discarded.')
        setDirtyCloseFilePath(null)
        return
      }
      useEditorStore.getState().closeFileIfIdle(dirtyCloseFilePath)
      useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath))
      setDirtyCloseFilePath(null)
    }
  }, [dirtyCloseFilePath])

  const handleDiscardAndClose = useCallback(() => {
    if (dirtyCloseFilePath) {
      useEditorStore.getState().closeFileIfIdle(dirtyCloseFilePath)
      useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath))
      setDirtyCloseFilePath(null)
    }
  }, [dirtyCloseFilePath])

  const handleCancelDirtyClose = useCallback(() => {
    setDirtyCloseFilePath(null)
  }, [])

  // Bulk close dispatch: every tab routes through its normal close primitive
  // minus the per-item dialog (the aggregate dialog replaced it upstream).
  // Per-tab failures surface through the renderer log, not silently.
  // `approvedDirty` is the set of editor paths whose dirty state was covered
  // by the aggregate confirmation (Save & Close / Don't Save) — anything else
  // dirty at execute time is skipped rather than discarded without consent.
  const closeBulkTabNow = useCallback(
    (tab: WorkspaceTab, approvedDirty: ReadonlySet<string>): void => {
      switch (tab.type) {
        case 'terminal':
          void closeTerminalTabByTabId(tab.id)
            .then((didClose) => {
              if (!didClose) {
                void logFrontendError({
                  level: 'warn',
                  source: 'WorkspaceLayout.bulkClose',
                  message: `bulk close: terminal tab ${tab.id} did not close`
                })
              }
            })
            .catch((error) => {
              void logFrontendError({
                level: 'warn',
                source: 'WorkspaceLayout.bulkClose',
                message: `bulk close: terminal tab ${tab.id} close threw: ${error instanceof Error ? error.message : String(error)}`
              })
            })
          break
        case 'editor': {
          const filePath = tab.filePath
          const fileState = useEditorStore.getState().openFiles.get(filePath)
          if (!fileState) {
            // Ghost editor tab: closeFileIfIdle returns false forever for a
            // file absent from openFiles — drop the orphaned workspace tab
            // like the single-close path (handleCloseEditorTab) does.
            useWorkspaceStore.getState().removeTab(editorTabId(filePath))
            break
          }
          if (fileState.isDirty && !approvedDirty.has(filePath)) {
            void logFrontendError({
              level: 'warn',
              source: 'WorkspaceLayout.bulkClose',
              message: `bulk close: skipped ${filePath} — file became dirty after confirmation`
            })
            break
          }
          const didClose = useEditorStore.getState().closeFileIfIdle(filePath)
          if (didClose) {
            useWorkspaceStore.getState().removeTab(editorTabId(filePath))
          } else {
            void logFrontendError({
              level: 'warn',
              source: 'WorkspaceLayout.bulkClose',
              message: `bulk close: editor tab ${tab.id} did not close`
            })
          }
          break
        }
        case 'browser':
          useBrowserSessionStore.getState().removeTab(tab.browserTabId)
          useWorkspaceStore.getState().removeTab(tab.id)
          break
        case 'git':
        case 'git-history':
          useWorkspaceStore.getState().removeTab(tab.id)
          break
        case 'agent-chat':
          requestCloseAgentChat(tab.sessionId, () => {
            useWorkspaceStore.getState().removeTab(tab.id)
          })
          break
        case 'canvas':
          // Canvas disposal on bulk close — same route as the tab bar's
          // closeWorkspaceTab (daemon evict + tab removal).
          void useCanvasStore.getState().closeCanvas(tab.projectId)
          useWorkspaceStore.getState().removeTab(tab.id)
          break
        default: {
          // Exhaustiveness guard: a new WorkspaceTab kind must be routed above.
          const unknownTab: never = tab
          void logFrontendError({
            level: 'warn',
            source: 'WorkspaceLayout.bulkClose',
            message: `bulk close: unhandled workspace tab kind ${JSON.stringify(unknownTab)}`
          })
        }
      }
    },
    [closeTerminalTabByTabId]
  )

  // One throwing close primitive must not skip the remaining targets.
  const closeBulkTabSafely = useCallback(
    (tab: WorkspaceTab, approvedDirty: ReadonlySet<string>): void => {
      try {
        closeBulkTabNow(tab, approvedDirty)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'WorkspaceLayout.bulkClose',
          message: `bulk close: tab ${tab.id} close threw: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    },
    [closeBulkTabNow]
  )

  // Currently-dirty targeted editor paths, recomputed at execute time: a
  // path that left openFiles while the dialog was open is skipped instead of
  // spuriously aborting on saveFile(false), and a file dirtied while the
  // dialog was open is folded into the consented set.
  const bulkApprovedDirtyPaths = useCallback((tabs: WorkspaceTab[]): Set<string> => {
    return new Set(
      tabs
        .filter((tab): tab is WorkspaceTab & { type: 'editor' } => tab.type === 'editor')
        .map((tab) => tab.filePath)
        .filter((filePath) => useEditorStore.getState().openFiles.get(filePath)?.isDirty === true)
    )
  }, [])

  // `onCloseTabs` from WorkspaceTabBar: compute the confirm-required subset
  // once, then either close everything directly or open ONE aggregate dialog.
  const handleCloseTabs = useCallback(
    (targetTabs: WorkspaceTab[]): void => {
      // The aggregate request is single-slot — never overwrite a pending one.
      if (bulkClose) {
        void logFrontendError({
          level: 'warn',
          source: 'WorkspaceLayout.bulkClose',
          message: 'bulk close requested while an aggregate close dialog is already open'
        })
        return
      }
      // Skip tabs the single-close guards would refuse anyway: terminals with
      // a close already in flight (or no store record) and editors mid-save.
      const actionable = targetTabs.filter((tab) => {
        if (tab.type === 'terminal') {
          return (
            !closingTerminalIds.includes(tab.terminalId) &&
            useTerminalStore.getState().terminals.some((t) => t.id === tab.terminalId)
          )
        }
        if (tab.type === 'editor') {
          return !isEditorTabBusy(tab.filePath)
        }
        return true
      })
      if (actionable.length === 0) {
        void logFrontendError({
          level: 'info',
          source: 'WorkspaceLayout.bulkClose',
          message: `bulk close no-op: all ${targetTabs.length} target(s) filtered out by close guards`
        })
        return
      }

      const terminalTabs = actionable.filter((tab) => tab.type === 'terminal')
      const dirtyFilePaths = actionable
        .filter((tab): tab is WorkspaceTab & { type: 'editor' } => tab.type === 'editor')
        .map((tab) => tab.filePath)
        .filter((filePath) => useEditorStore.getState().openFiles.get(filePath)?.isDirty === true)
      const confirmRequired =
        (confirmTerminalClose && terminalTabs.length > 0) || dirtyFilePaths.length > 0

      void logFrontendError({
        level: 'info',
        source: 'WorkspaceLayout.bulkClose',
        message: `bulk close requested: ${actionable.length} tab(s), ${terminalTabs.length} terminal(s), ${dirtyFilePaths.length} dirty file(s), confirmRequired=${confirmRequired}`
      })

      if (!confirmRequired) {
        for (const tab of actionable) {
          closeBulkTabSafely(tab, NO_APPROVED_DIRTY)
        }
        return
      }

      setBulkClose({
        tabs: actionable,
        terminalCount: terminalTabs.length,
        dirtyFilePaths
      })
    },
    [bulkClose, closeBulkTabSafely, closingTerminalIds, confirmTerminalClose]
  )

  const handleBulkCloseConfirm = useCallback(async () => {
    if (!bulkClose || bulkCloseLoading) return

    setBulkCloseLoading(true)
    try {
      // Save & Close: every currently-dirty targeted file must save before
      // ANY tab closes; a single failure aborts the whole bulk action. When
      // the dialog was raised for terminals only (plain "Close"), the
      // approved set stays empty so a file dirtied meanwhile is skipped and
      // warned in closeBulkTabNow instead of being discarded.
      const approvedDirty =
        bulkClose.dirtyFilePaths.length > 0
          ? bulkApprovedDirtyPaths(bulkClose.tabs)
          : NO_APPROVED_DIRTY
      for (const filePath of approvedDirty) {
        const saved = await useEditorStore.getState().saveFile(filePath)
        if (!saved) {
          toast.error('Failed to save file. No tabs were closed.')
          void logFrontendError({
            level: 'warn',
            source: 'WorkspaceLayout.bulkClose',
            message: `bulk close aborted: saveFile failed for ${filePath}`
          })
          setBulkClose(null)
          return
        }
      }
      for (const tab of bulkClose.tabs) {
        closeBulkTabSafely(tab, approvedDirty)
      }
      setBulkClose(null)
    } catch (error) {
      // The failure may have come from the close phase after some tabs
      // already closed, so don't claim "no tabs were closed" here.
      toast.error('Bulk close aborted')
      void logFrontendError({
        source: 'WorkspaceLayout.bulkClose',
        message: `bulk close aborted: ${error instanceof Error ? error.message : String(error)}`
      })
      setBulkClose(null)
    } finally {
      setBulkCloseLoading(false)
    }
  }, [bulkClose, bulkCloseLoading, bulkApprovedDirtyPaths, closeBulkTabSafely])

  // Don't Save / Discard & Close: dirty editor contents are dropped by
  // closeFileIfIdle; every other target closes through its normal path.
  const handleBulkCloseDiscard = useCallback(() => {
    if (!bulkClose) return
    const approvedDirty =
      bulkClose.dirtyFilePaths.length > 0
        ? bulkApprovedDirtyPaths(bulkClose.tabs)
        : NO_APPROVED_DIRTY
    for (const tab of bulkClose.tabs) {
      closeBulkTabSafely(tab, approvedDirty)
    }
    setBulkClose(null)
  }, [bulkClose, bulkApprovedDirtyPaths, closeBulkTabSafely])

  const handleBulkCloseCancel = useCallback(() => {
    if (bulkCloseLoading) return
    setBulkClose(null)
  }, [bulkCloseLoading])

  // A project switch swaps every store the pending request references — a
  // stale aggregate dialog must never act on the new project's tabs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on activeProjectId intentionally — the reset runs on switch, not on reads
  useEffect(() => {
    setBulkClose(null)
    setBulkCloseLoading(false)
  }, [activeProjectId])

  // App close dialog handlers
  const handleSaveAllAndClose = useCallback(async () => {
    await useEditorStore.getState().saveAllDirty()
    const remaining = useEditorStore.getState().getDirtyFileCount()
    if (remaining > 0) {
      toast.error('Some files failed to save. Please try again or discard changes.')
      return
    }
    await closeAppWithPersistenceFlush()
  }, [closeAppWithPersistenceFlush])

  const handleDiscardAllAndClose = useCallback(() => {
    void closeAppWithPersistenceFlush()
  }, [closeAppWithPersistenceFlush])

  const handleCancelAppClose = useCallback(() => {
    windowApi.respondToClose('cancel')
    setIsAppCloseDialogOpen(false)
  }, [])

  // Command history handlers
  const handleInsertCommand = useCallback(
    (command: string) => {
      // TODO: Route to active terminal pane via context
      if (activeTerminal?.ptyId) {
        terminalApi.write(activeTerminal.ptyId, command)
      }
    },
    [activeTerminal]
  )

  const handleClearCommandHistory = useCallback(async () => {
    if (!activeProjectId) return
    // Persist empty array first, then clear in-memory on success
    const result = await persistenceApi.write(`projects/${activeProjectId}/command-history`, [])
    if (!result.success) {
      toast.error(`Failed to clear history: ${result.error}`)
      throw new Error(result.error)
    }
    // Only clear in-memory state after successful persistence
    const { clearHistory } = useCommandHistoryStore.getState()
    clearHistory(activeProjectId)
  }, [activeProjectId])

  const terminalToClose = terminals.find((t) => t.id === closeConfirmTerminal?.terminalId)

  // Show loading state while projects are being loaded
  if (!isLoaded) {
    // #854: a token-gated server refusing our (absent/rotated) token shows
    // the token-entry screen INSTEAD of the Loading state — the missing UX
    // that made the web client hang forever on an installed PWA.
    if (webAuthGate.status === 'unauthorized') {
      return <WebTokenGateScreen />
    }
    if (isMobileWebShell) {
      return (
        <div className="flex h-screen flex-col overflow-hidden bg-background">
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        </div>
      )
    }
    return (
      <div className="h-screen flex flex-col overflow-hidden bg-background">
        <ResizeEdges />
        <div className="flex-1 flex flex-col overflow-hidden min-h-0 h-full">
          <MacOsTitlebarStrip />
          <div className="flex-1 flex overflow-hidden min-h-0">
            <ActivityRail
              isShortcutsOpen={isShortcutMenuOpen}
              onShortcutsOpenChange={setIsShortcutMenuOpen}
              onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
              canOpenGitChanges={false}
            />
            <div className="flex-1 flex flex-col min-w-0">
              <TitleBar />
              <div className="flex-1 flex items-center justify-center">
                <div className="text-muted-foreground text-sm">Loading...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const workspaceMain = (
    <>
      {activeSSHProfile ? (
        <Suspense fallback={<ShellSkeleton />}>
          <SSHWorkspace profile={sshProfileWithPassword!} conn={sshConn} />
        </Suspense>
      ) : projects.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center bg-background px-6 rounded-xl">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            className="flex max-w-md flex-col items-center text-center"
          >
            <div className="mb-6">
              <FolderKanban className="h-24 w-24 text-muted-foreground/50" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">No Projects Yet</h2>
            <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
              Create your first project to organize your terminals, snapshots, and commands
            </p>
            <Button type="button" size="sm" onClick={() => setIsNewProjectModalOpen(true)}>
              Create Your First Project
            </Button>
          </motion.div>
        </div>
      ) : (
        <>
          {isWorkspaceRoute ? (
            <>
              <ChatRoute />
              <motion.div
                key={fullscreenPaneId ? 'fullscreen' : 'normal'}
                initial={{ opacity: 0.85, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="h-full min-h-0 flex-1 overflow-hidden"
              >
                <PaneRenderer
                  key={mobileActiveLeaf?.id}
                  node={mobileActiveLeaf ?? fullscreenPane ?? paneRoot}
                  onAddTerminal={handleAddTerminal}
                  onAddBrowserTab={handleNewBrowserTab}
                  onCloseTerminal={handleCloseTerminal}
                  onRenameTerminal={renameTerminal}
                  onCloseEditorTab={handleCloseEditorTab}
                  onCloseTabs={handleCloseTabs}
                  closingTerminalIds={closingTerminalIds}
                  defaultShell={activeProject?.defaultShell || appDefaultShell}
                />
              </motion.div>
            </>
          ) : (
            <div className="relative flex-1 overflow-hidden bg-background rounded-xl">
              <div className="h-full w-full">
                <Outlet />
              </div>
            </div>
          )}
          {/* Story 11 (QA F9) put StatusBar on mobile; the mobile revamp
              retires it there as desktop chrome. Connection health now
              lives in the drawer footer. The last-command exit code has no
              mobile surface until the header goal's terminal sheet lands,
              and ContextBarSettingsPopover is not mounted on mobile. */}
          {!isMobileWebShell && <StatusBar project={activeProject} />}
        </>
      )}
    </>
  )

  const appModals = (
    <>
      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        onCreateProject={addProject}
      />

      {isThemePickerOpen && (
        <Suspense fallback={null}>
          <ThemePicker />
        </Suspense>
      )}

      {isCommandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={isCommandPaletteOpen}
            onClose={() => setIsCommandPaletteOpen(false)}
            projects={projects}
            onSwitchProject={selectProject}
            onAddTerminal={() => handleAddTerminal(undefined)}
            onShowAgentLauncher={() => {
              const paneId = useWorkspaceStore.getState().activePaneId
              if (paneId) {
                useWorkspaceStore.getState().showAgentLauncher(paneId)
              }
            }}
            onLaunchAgent={handleLaunchAgent}
            onNewBrowserTab={handleNewBrowserTab}
            onOpenCanvas={handleOpenCanvas}
            onNewProject={isMobileWebShell ? () => setIsNewProjectModalOpen(true) : undefined}
            onSaveSnapshot={handleOpenSnapshotModal}
            onOpenProjectSettings={handleOpenProjectSettings}
            onOpenAppPreferences={handleOpenAppPreferences}
            onOpenCommandHistory={activeProjectId ? handleOpenCommandHistory : undefined}
            onOpenShortcutMenu={handleOpenShortcutMenu}
            onOpenThemePicker={handleOpenThemePicker}
            onSSHConnect={handleSSHConnect}
            sshProfiles={sshProfiles.map((p) => ({
              id: p.id,
              name: p.name,
              host: p.host,
              username: p.username
            }))}
            getShortcutLabel={getShortcutLabel}
            getProjectShortcutLabel={getProjectShortcutLabel}
          />
        </Suspense>
      )}

      <CreateSnapshotModal
        isOpen={isCreateSnapshotModalOpen}
        onClose={() => setIsCreateSnapshotModalOpen(false)}
        onCreateSnapshot={handleCreateSnapshot}
      />

      {isCommandHistoryOpen && (
        <Suspense fallback={null}>
          <CommandHistoryModal
            isOpen={isCommandHistoryOpen}
            onClose={() => setIsCommandHistoryOpen(false)}
            entries={commandHistory}
            allEntries={allCommandHistory}
            onSelectCommand={handleInsertCommand}
            onClearHistory={handleClearCommandHistory}
          />
        </Suspense>
      )}

      {settingsModalView === 'project' && (
        <Suspense fallback={null}>
          <ProjectSettingsModal />
        </Suspense>
      )}

      {settingsModalView === 'app' && (
        <Suspense fallback={null}>
          <AppPreferencesModal />
        </Suspense>
      )}

      {/* SSH Password Prompt */}
      {sshPasswordPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/50">
          <div className="bg-background border border-border rounded-lg shadow-lg w-[360px] p-4">
            <h3 className="text-sm font-semibold mb-1">SSH Password</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Enter password for{' '}
              <span className="font-medium">{sshPasswordPrompt.profileName}</span>
            </p>
            <input
              type="password"
              value={sshPasswordInput}
              onChange={(e) => setSSHPasswordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSSHPasswordSubmit()
                if (e.key === 'Escape') {
                  setSSHPasswordPrompt(null)
                  setSSHPasswordInput('')
                }
              }}
              placeholder="Password"
              autoFocus
              className="w-full px-3 py-1.5 text-sm bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex justify-end gap-2 mt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSSHPasswordPrompt(null)
                  setSSHPasswordInput('')
                }}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleSSHPasswordSubmit}>
                Connect
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Close Terminal Confirmation */}
      <ConfirmDialog
        isOpen={closeConfirmTerminal !== null}
        title="Close Terminal"
        message={`Are you sure you want to close "${
          terminalToClose?.name || 'this terminal'
        }"? Any running processes will be terminated.`}
        confirmLabel="Close"
        cancelLabel="Cancel"
        variant="danger"
        isLoading={closeConfirmLoading}
        onConfirm={handleConfirmCloseTerminal}
        onCancel={handleCancelCloseTerminal}
      >
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
          <input
            type="checkbox"
            checked={closeConfirmRememberChoice}
            onChange={(e) => setCloseConfirmRememberChoice(e.target.checked)}
            disabled={closeConfirmLoading}
            className="rounded border-border bg-background"
          />
          Don't ask again when closing terminals
        </label>
      </ConfirmDialog>

      {/* Dirty File Close Confirmation */}
      <ConfirmDialog
        isOpen={dirtyCloseFilePath !== null}
        title="Unsaved Changes"
        message={`Save changes to "${dirtyCloseFilePath?.split(/[\\/]/).pop() ?? ''}" before closing?`}
        confirmLabel="Save"
        cancelLabel="Cancel"
        secondaryAction={{ label: 'Discard', onClick: handleDiscardAndClose }}
        onConfirm={handleSaveThenClose}
        onCancel={handleCancelDirtyClose}
      />

      {/* App Close Unsaved Files Confirmation */}
      <ConfirmDialog
        isOpen={isAppCloseDialogOpen}
        title="Unsaved Changes"
        message={`You have ${appCloseDirtyCount} unsaved file${appCloseDirtyCount !== 1 ? 's' : ''}. Save changes before closing?`}
        confirmLabel="Save All"
        cancelLabel="Cancel"
        secondaryAction={{
          label: "Don't Save",
          onClick: handleDiscardAllAndClose
        }}
        onConfirm={handleSaveAllAndClose}
        onCancel={handleCancelAppClose}
      />

      {/* Bulk tab close — ONE aggregate dialog for the whole target list.
          Dirty editors add the save/discard split from the app-close pattern;
          terminals already closing or editors mid-save were filtered out in
          handleCloseTabs before this state was set. */}
      <ConfirmDialog
        isOpen={bulkClose !== null}
        title="Close Tabs"
        message={(() => {
          if (!bulkClose) return ''
          const parts: string[] = []
          if (bulkClose.terminalCount > 0) {
            parts.push(
              `${pluralizeCount(bulkClose.terminalCount, 'terminal has', 'terminals have')} running processes`
            )
          }
          if (bulkClose.dirtyFilePaths.length > 0) {
            parts.push(
              `${pluralizeCount(bulkClose.dirtyFilePaths.length, 'file has', 'files have')} unsaved changes`
            )
          }
          return `Close ${pluralizeCount(bulkClose.tabs.length, 'tab', 'tabs')}? ${parts.join('; ')}.`
        })()}
        confirmLabel={bulkClose && bulkClose.dirtyFilePaths.length > 0 ? 'Save & Close' : 'Close'}
        cancelLabel="Cancel"
        variant="danger"
        isLoading={bulkCloseLoading}
        secondaryAction={
          bulkClose && bulkClose.dirtyFilePaths.length > 0
            ? { label: "Don't Save", onClick: handleBulkCloseDiscard }
            : undefined
        }
        onConfirm={() => void handleBulkCloseConfirm()}
        onCancel={handleBulkCloseCancel}
      />
    </>
  )
  // #907 (F3): the WS transport flagged the web auth gate `unauthorized`
  // MID-SESSION (token revoked/rotated server-side). The token-entry screen
  // must re-surface even though projects are already loaded — the
  // `!isLoaded` branch above only covers boot. Preserves #854: the gate
  // screen stays the only interactive surface until a valid token is
  // submitted. The swap unmounts the workspace, so state remounts cold
  // after re-entry — the accepted trade for a dead token. Sits BEFORE the
  // mobile branch so web/PWA users get the same re-surface.
  if (webAuthGate.status === 'unauthorized') {
    return <WebTokenGateScreen />
  }

  if (isMobileWebShell) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)]">
        {/* pt-[env(safe-area-inset-top)] (Story 7, QA F2): with
            `viewport-fit=cover` the webview extends under the notch; the shell
            root pads by the top inset so the header's 44px buttons clear
            the cutout. Evaluates to 0 on non-notch devices (no extra padding). */}
        <Suspense fallback={<ShellSkeleton />}>
          <MobileChatShell
            onNewChat={handleOpenAgentChat}
            canNewChat={Boolean(activeProject?.path)}
            onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
            onOpenGitChanges={() => openGitSheet()}
            onOpenGitHistory={() => handleAddGitHistoryTab()}
            onNewProject={() => setIsNewProjectModalOpen(true)}
            onNewTerminal={() => handleAddTerminal(undefined)}
            onCloseTerminal={handleCloseTerminal}
            onRenameTerminal={renameTerminal}
            onCloseEditorTab={handleCloseEditorTab}
            onOpenProjectSettings={handleOpenProjectSettings}
            onOpenCommandHistory={activeProjectId ? handleOpenCommandHistory : undefined}
            onRestartTerminal={(terminalId) => {
              // Restart: kill the PTY, close the old tab, then re-spawn.
              const terminal = useTerminalStore
                .getState()
                .terminals.find((t) => t.id === terminalId)
              if (!terminal?.ptyId) return
              const root = useWorkspaceStore.getState().root
              const pane = findPaneContainingTab(root, `term-${terminalId}`)
              void terminalApi.kill(terminal.ptyId).then(() => {
                closeTerminal(terminalId, activeProjectId)
                if (pane) {
                  useWorkspaceStore.getState().closeTab(pane.id, `term-${terminalId}`)
                }
                handleCreateTerminalInPane(
                  pane?.id ?? useWorkspaceStore.getState().activePaneId ?? '',
                  terminal.shell ?? undefined
                )
              })
            }}
          >
            <PaneDndProvider>
              {/* flex-1 (not h-full): percentage heights against the
                  flex-sized wrapper do not resolve in every engine, which
                  collapses the workspace to 0 height. */}
              <main className="flex min-h-0 flex-1 flex-col overflow-clip bg-background">
                {workspaceMain}
              </main>
            </PaneDndProvider>
          </MobileChatShell>
        </Suspense>

        {/* Mobile-only full-width Git Changes sheet. GitPanel branches on
            useMobileWebShell() internally to render a single-column stacked
            layout (file list → diff + back). Only mounted in the mobile path
            so the desktop two-column GitPanel (a workspace tab) is untouched.
            The `open` prop is gated on `activeProject?.path` in addition to
            `gitSheetOpen` so the sheet can never be open during the
            empty-content race when the active project loses its path; the
            `useEffect` above also closes the store to keep state honest. */}
        <Sheet
          open={gitSheetOpen && Boolean(gitSheetCwd && activeProject?.path)}
          onOpenChange={(next) => !next && closeGitSheet()}
        >
          {/* Story 10 (QA F9/F7): the git sheet is no longer a radius-0
              full-screen takeover — rounded top corners + max-height
              (content scrolls inside; the app stays visible behind the
              overlay). p-0 matches the mobile sheet family; the GitPanel
              block owns its internal p-2 rhythm. Story 7 keeps the
              safe-area-inset-bottom pad so the footer clears the home
              indicator. */}
          <SheetContent
            side="bottom"
            className="flex h-[90vh] max-h-[90vh] flex-col gap-0 rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)]"
            aria-label="Git changes"
            onCloseAutoFocus={sheetCloseAutoFocus('git-sheet')}
          >
            {gitSheetCwd ? (
              <Suspense fallback={<ShellSkeleton />}>
                <GitPanel cwd={gitSheetCwd} isVisible={gitSheetOpen} />
              </Suspense>
            ) : null}
          </SheetContent>
        </Sheet>

        {appModals}
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      <ResizeEdges />
      <div className="flex-1 flex flex-col overflow-hidden min-h-0 h-full">
        <MacOsTitlebarStrip />
        <div className="flex-1 flex overflow-hidden min-h-0">
          <ActivityRail
            isShortcutsOpen={isShortcutMenuOpen}
            onShortcutsOpenChange={setIsShortcutMenuOpen}
            onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
            onOpenGitChanges={() => handleAddGitTab()}
            canOpenGitChanges={Boolean(activeProject?.path)}
            onOpenGitHistory={() => handleAddGitHistoryTab()}
            canOpenGitHistory={Boolean(activeProject?.path)}
            isThemePickerOpen={isThemePickerOpen}
            onToggleThemePicker={handleToggleThemePicker}
            onOpenAgentChat={handleOpenAgentChat}
            canOpenAgentChat={Boolean(activeProject?.path)}
            onOpenCanvas={handleOpenCanvas}
            canOpenCanvas={Boolean(activeProject?.path)}
          />
          <div className="flex-1 flex flex-col min-w-0">
            <TitleBar />

            {/* Shell row: sidebar | main card | explorer. gap-2 between the
                columns, pr-2 on the right edge; the side panels are flat and
                set their own surface, so the wrappers here add no fill. */}
            <div className="flex-1 flex gap-2 overflow-hidden min-h-0 h-full py-2 pr-2">
              {/* Sidebar — width reveal: the motion wrapper tweens 0↔auto and
                  clips overflow; the fixed w-64 aside inside never squishes. */}
              <AnimatePresence initial={false}>
                {isSidebarVisible ? (
                  <motion.div
                    key="project-sidebar"
                    className="flex-shrink-0 h-full overflow-hidden"
                    {...panelRevealMotion(reducedMotion)}
                  >
                    <div className="h-full">
                      <ProjectSidebar
                        projects={projects}
                        activeProjectId={activeProjectId}
                        onSelectProject={handleSelectProject}
                        onNewProject={() => setIsNewProjectModalOpen(true)}
                        onUpdateProject={updateProject}
                        onDeleteProject={deleteProject}
                        onArchiveProject={archiveProject}
                        onRestoreProject={restoreProject}
                        onReorderProjects={reorderProjects}
                        onSSHConnect={handleSSHConnect}
                        onSelectSSHProfile={handleSelectSSHProfile}
                        activeSSHProfileId={activeSSHProfileId}
                      />
                    </div>
                  </motion.div>
                ) : (
                  !isTauriContext() && (
                    // Web-only slim edge toggle so a hidden sidebar stays
                    // re-openable. Desktop re-opens via the TitleBar toggle.
                    // Its enter is deferred until the panel's collapse exits
                    // (edgeToggleMotion) — see the helper's comment.
                    <motion.div
                      key="sidebar-edge-toggle"
                      className="flex items-start pt-0 overflow-hidden"
                      {...edgeToggleMotion(reducedMotion)}
                    >
                      <SidebarToggleButton className={panelEdgeToggleButtonClass} />
                    </motion.div>
                  )
                )}
              </AnimatePresence>

              {/* Main Content and File Explorer Container */}
              <PaneDndProvider>
                <div className="flex-1 flex gap-2 min-h-0 h-full overflow-hidden min-w-0">
                  {/* Main Content Area */}
                  <main className="flex-1 flex flex-col min-w-0 rounded-xl border border-border bg-card overflow-clip">
                    <WorkspaceConflictBanner />
                    {workspaceMain}
                  </main>

                  {/* File Explorer. The whole column (explorer + SSH block)
                      width-reveals together; each inner block also reveals
                      on its own — toggling the explorer or connecting SSH
                      animates instead of shifting layout. */}
                  <AnimatePresence initial={false}>
                    {(isExplorerVisible && activeProject?.path) || activeSSHProfile ? (
                      <motion.div
                        key="explorer-column"
                        className="flex-shrink-0 h-full overflow-hidden"
                        {...panelRevealMotion(reducedMotion)}
                      >
                        <div className="flex h-full flex-col gap-2">
                          <AnimatePresence initial={false}>
                            {isExplorerVisible && activeProject?.path && (
                              <motion.div
                                key="file-explorer-panel"
                                className={cn(
                                  'overflow-hidden',
                                  activeSSHProfile ? 'flex-1 min-h-0' : 'h-full'
                                )}
                                {...panelRevealMotion(reducedMotion)}
                              >
                                <Suspense fallback={<ShellSkeleton />}>
                                  <FileExplorer side="right" />
                                </Suspense>
                              </motion.div>
                            )}
                          </AnimatePresence>
                          <AnimatePresence initial={false}>
                            {activeSSHProfile && (
                              <motion.div
                                key="ssh-explorer-panel"
                                className="flex-1 min-h-0 overflow-hidden"
                                {...panelRevealMotion(reducedMotion)}
                              >
                                <div
                                  className={cn(
                                    'h-full bg-background rounded-xl overflow-hidden flex flex-col border border-border',
                                    !(isExplorerVisible && activeProject?.path) && 'w-64'
                                  )}
                                >
                                  <Suspense fallback={<ShellSkeleton />}>
                                    <SSHFileExplorer
                                      connectionId={sshConn.connectionId ?? ''}
                                      isConnected={sshConn.isConnected}
                                      sftpReady={sshConn.sftpReady}
                                      entries={sshConn.entries}
                                      currentPath={sshConn.currentPath}
                                      expandedDirs={sshConn.expandedDirs}
                                      childEntries={sshConn.childEntries}
                                      loadingDirs={sshConn.loadingDirs}
                                      isLoadingRoot={sshConn.isLoadingRoot}
                                      profileName={activeSSHProfile.name}
                                      onConnect={sshConn.handleConnect}
                                      onBrowseFiles={sshConn.handleBrowseFiles}
                                      onToggleDir={sshConn.toggleDirectory}
                                      onLoadDir={sshConn.loadDirectory}
                                      onMkdir={handleSSHMkdir}
                                      onCreateFile={handleSSHCreateFile}
                                      onDelete={handleSSHDelete}
                                      onRename={handleSSHRename}
                                    />
                                  </Suspense>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </motion.div>
                    ) : (
                      !isExplorerVisible &&
                      activeProject?.path &&
                      !isTauriContext() && (
                        // Web-only slim edge toggle so a hidden file explorer
                        // stays re-openable. Desktop re-opens via the
                        // TitleBar. Its enter is deferred until the column's
                        // collapse exits (edgeToggleMotion).
                        <motion.div
                          key="explorer-edge-toggle"
                          className="flex-shrink-0 flex items-start overflow-hidden"
                          {...edgeToggleMotion(reducedMotion)}
                        >
                          <FileExplorerToggleButton className={panelEdgeToggleButtonClass} />
                        </motion.div>
                      )
                    )}
                  </AnimatePresence>
                </div>
              </PaneDndProvider>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {appModals}
    </div>
  )
}
