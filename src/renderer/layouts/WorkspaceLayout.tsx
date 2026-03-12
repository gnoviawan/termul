import { useState, useCallback, useRef, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { motion } from 'framer-motion'
import { FolderKanban, Terminal } from 'lucide-react'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { PaneRenderer } from '@/components/workspace/PaneRenderer'
import { PaneDndProvider } from '@/hooks/use-pane-dnd'
import { StatusBar } from '@/components/StatusBar'
import { NewProjectModal } from '@/components/NewProjectModal'
import { CreateSnapshotModal } from '@/components/CreateSnapshotModal'
import { CommandPalette } from '@/components/CommandPalette'
import { CommandHistoryModal } from '@/components/CommandHistoryModal'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FileExplorer } from '@/components/file-explorer/FileExplorer'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle
} from '@/components/ui/resizable'
import {
  useProjects,
  useActiveProject,
  useActiveProjectId,
  useProjectActions,
  useProjectsLoaded
} from '@/stores/project-store'
import {
  useTerminals,
  useActiveTerminal,
  useActiveTerminalId,
  useTerminalActions,
  useTerminalStore
} from '@/stores/terminal-store'
import { useFileExplorerStore, useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import { useEditorStore } from '@/stores/editor-store'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import {
  useWorkspaceStore,
  useActiveTab,
  usePaneRoot,
  editorTabId,
  getActiveTerminalIdFromTree,
  getActiveFilePathFromTree,
  findPaneContainingTab
} from '@/stores/workspace-store'
import { useCreateSnapshot, useSnapshotLoader } from '@/hooks/use-snapshots'
import { useRecentCommandsLoader } from '@/hooks/use-recent-commands'
import {
  useCommandHistoryLoader,
  useAddCommand,
  useCommandHistory,
  useAllCommandHistory
} from '@/hooks/use-command-history'
import { filesystemApi, windowApi, keyboardApi, terminalApi, persistenceApi } from '@/lib/api'
import { useKeyboardShortcutsStore, matchesShortcut } from '@/stores/keyboard-shortcuts-store'
import {
  useTerminalFontSize,
  useDefaultShell,
  useMaxTerminalsPerProject
} from '@/stores/app-settings-store'
import {
  useUpdateAppSetting,
  useUpdatePanelVisibility,
  waitForPendingAppSettingsPersistence
} from '@/hooks/use-app-settings'
import { useFileWatcher } from '@/hooks/use-file-watcher'
import { useEditorPersistence } from '@/hooks/use-editor-persistence'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { toast } from 'sonner'
import { TitleBar } from '@/components/TitleBar'
import { resolveEnvForSpawn } from '@/lib/env-parser'

export default function WorkspaceLayout(): React.JSX.Element {
  const location = useLocation()
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isCreateSnapshotModalOpen, setIsCreateSnapshotModalOpen] = useState(false)
  const [closeConfirmTerminal, setCloseConfirmTerminal] = useState<{
    terminalId: string
    tabId: string
  } | null>(null)
  const [dirtyCloseFilePath, setDirtyCloseFilePath] = useState<string | null>(null)
  const [isCommandHistoryOpen, setIsCommandHistoryOpen] = useState(false)
  const [isAppCloseDialogOpen, setIsAppCloseDialogOpen] = useState(false)
  const [appCloseDirtyCount, setAppCloseDirtyCount] = useState(0)

  const isLoaded = useProjectsLoaded()
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
  const {
    addTerminal,
    closeTerminal,
    renameTerminal
  } = useTerminalActions()

  // File explorer & editor state
  const isExplorerVisible = useFileExplorerVisible()
  const isSidebarVisible = useSidebarVisible()
  const activeTab = useActiveTab()
  const paneRoot = usePaneRoot()
  const prevProjectIdRef = useRef<string>('')
  const watchedRootPathRef = useRef<string | null>(null)
  const projectSwitchRequestIdRef = useRef(0)

  // File watcher hook
  useFileWatcher()

  // Sync file explorer root path and register project root watcher when project changes
  useEffect(() => {
    const nextRootPathCandidate = activeProject?.path
    if (typeof nextRootPathCandidate !== 'string' || activeProjectId === prevProjectIdRef.current) {
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

  useEffect(() => {
    return () => {
      if (watchedRootPathRef.current) {
        filesystemApi.unwatchDirectory(watchedRootPathRef.current)
      }
    }
  }, [])

  // Ensure tabs exist for currently visible project terminals.
  // Project workspace loading/removal is owned by persistence + restore flows.
  const ensureCallCountRef = useRef(0)
  const lastEnsuredTerminalIdsRef = useRef<string[]>([])

  useEffect(() => {
    const terminalIds = terminals.map((terminal) => terminal.id)

    const prevIds = lastEnsuredTerminalIdsRef.current
    if (terminalIds.length === prevIds.length && terminalIds.every((id, i) => id === prevIds[i])) {
      return
    }

    const ensureId = `ensure-${ensureCallCountRef.current++}-${Date.now().toString().slice(-6)}`

    console.log(`[WorkspaceLayout] ensureTerminalTabs CALL [${ensureId}]`, {
      terminalCount: terminalIds.length,
      terminalIds,
      prevCount: prevIds.length,
      callCount: ensureCallCountRef.current
    })

    lastEnsuredTerminalIdsRef.current = terminalIds
    const workspaceStore = useWorkspaceStore.getState()
    for (const terminalId of terminalIds) {
      workspaceStore.ensureTerminalTab(terminalId)
    }
  }, [terminals])

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
      const [pendingAppSettingsResult, pendingPersistenceResult] = await Promise.allSettled([
        waitForPendingAppSettingsPersistence(),
        persistenceApi.flushPendingWrites()
      ])

      if (pendingAppSettingsResult.status === 'rejected') {
        console.error(
          'Failed to wait for app settings persistence before close:',
          pendingAppSettingsResult.reason
        )
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

  // Load snapshots when project changes
  useSnapshotLoader()
  // Load recent commands for command palette
  useRecentCommandsLoader()
  // Load command history for current project
  useCommandHistoryLoader(activeProjectId)
  const addCommand = useAddCommand()
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

  // Keyboard shortcuts
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  const fontSize = useTerminalFontSize()
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

  // Determine if we should show the terminal area (only on workspace dashboard)
  const isWorkspaceRoute = location.pathname === '/'

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
      if (terminals.length >= maxTerminals) {
        toast.error(`Maximum ${maxTerminals} terminals per project`)
        return
      }

      const shell = shellName || activeProject?.defaultShell || appDefaultShell || undefined
      const cwd = activeProject?.path

      // Resolve project env vars for spawn
      // TODO: Pass actual system env from backend for variable expansion
      const { env, hasProjectEnv } = resolveEnvForSpawn(activeProject?.envVars, {})

      const spawnResult = await terminalApi.spawn({
        shell,
        cwd,
        ...(hasProjectEnv ? { env } : {})
      })
      if (!spawnResult.success) {
        toast.error(spawnResult.error || 'Failed to create terminal')
        return
      }

      const terminal = addTerminal(`Terminal ${terminals.length + 1}`, activeProjectId, shell, cwd)
      useTerminalStore.getState().setTerminalPtyId(terminal.id, spawnResult.data.id)

      useWorkspaceStore.getState().addTabToPane(paneId, {
        type: 'terminal',
        id: `term-${terminal.id}`,
        terminalId: terminal.id
      })
    },
    [activeProject?.defaultShell, activeProject?.path, activeProject?.envVars, activeProjectId, addTerminal, appDefaultShell, maxTerminals, terminals.length]
  )

  const handleNewTerminal = useCallback(() => {
    const paneId = useWorkspaceStore.getState().activePaneId
    handleCreateTerminalInPane(paneId)
  }, [handleCreateTerminalInPane])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in an input/textarea/editable element
      const target = e.target instanceof HTMLElement ? e.target : document.body
      const isInEditor = target.closest('.cm-content') || target.closest('.bn-editor') || target.closest('.xterm')
      const isInInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.closest('[contenteditable="true"]')

      // Ctrl+S should work even in editors
      if (e.ctrlKey && e.key === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (activeTab?.type === 'editor') {
          useEditorStore.getState().saveFile(activeTab.filePath)
        }
        return
      }

      // Ctrl+W - close tab
      if (e.ctrlKey && e.key === 'w' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        if (activeTab?.type === 'editor') {
          const fileState = useEditorStore.getState().openFiles.get(activeTab.filePath)
          if (fileState?.isDirty) {
            setDirtyCloseFilePath(activeTab.filePath)
          } else {
            useEditorStore.getState().closeFile(activeTab.filePath)
            useWorkspaceStore.getState().removeTab(activeTab.id)
          }
        } else if (activeTab?.type === 'terminal') {
          setCloseConfirmTerminal({ terminalId: activeTab.terminalId, tabId: activeTab.id })
        }
        return
      }

      // Ctrl+B - toggle file explorer (skip when in editor/input so BlockNote bold works)
      if (e.ctrlKey && e.key === 'b' && !e.shiftKey && !e.altKey) {
        if (!isInEditor && !isInInput) {
          e.preventDefault()
          void updatePanelVisibility('fileExplorerVisible', !isExplorerVisible).catch((error) => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Failed to update file explorer visibility'
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

      // Skip other shortcuts if typing in input or editor
      if (isInInput || isInEditor) {
        return
      }

      // Command palette (Ctrl+K)
      if (matchesShortcut(e, getActiveKey('commandPalette'))) {
        e.preventDefault()
        e.stopPropagation()
        setIsCommandPaletteOpen(true)
        return
      }

      // Command palette alt (Ctrl+Shift+P)
      if (matchesShortcut(e, getActiveKey('commandPaletteAlt'))) {
        e.preventDefault()
        e.stopPropagation()
        setIsCommandPaletteOpen(true)
        return
      }

      // Terminal search (Ctrl+F) - handled at pane level now
      if (matchesShortcut(e, getActiveKey('terminalSearch'))) {
        if (isWorkspaceRoute) {
          e.preventDefault()
          e.stopPropagation()
          // Terminal search is now handled per-pane
        }
        return
      }

      // Command history (Ctrl+R)
      if (matchesShortcut(e, getActiveKey('commandHistory'))) {
        e.preventDefault()
        e.stopPropagation()
        if (activeProjectId) {
          setIsCommandHistoryOpen(true)
        }
        return
      }

      // New project (Ctrl+N)
      if (matchesShortcut(e, getActiveKey('newProject'))) {
        e.preventDefault()
        e.stopPropagation()
        setIsNewProjectModalOpen(true)
        return
      }

      // New terminal (Ctrl+T) - only on workspace routes
      if (matchesShortcut(e, getActiveKey('newTerminal'))) {
        if (!isWorkspaceRoute) return
        e.preventDefault()
        e.stopPropagation()
        if (terminals.length >= maxTerminals) {
          toast.error(`Maximum ${maxTerminals} terminals per project`)
          return
        }
        const paneId = useWorkspaceStore.getState().activePaneId
        handleCreateTerminalInPane(paneId)
        return
      }

      // Next terminal/tab (default: Ctrl+PageDown)
      if (matchesShortcut(e, getActiveKey('nextTerminal'))) {
        e.preventDefault()
        e.stopPropagation()
        cycleTab('next')
        return
      }

      // Previous terminal/tab (default: Ctrl+PageUp)
      if (matchesShortcut(e, getActiveKey('prevTerminal'))) {
        e.preventDefault()
        e.stopPropagation()
        cycleTab('prev')
        return
      }

      // Zoom in (Ctrl+=)
      if (matchesShortcut(e, getActiveKey('zoomIn'))) {
        e.preventDefault()
        e.stopPropagation()
        const newSize = Math.min(fontSize + 1, 24)
        if (newSize !== fontSize) {
          updateAppSetting('terminalFontSize', newSize)
        }
        return
      }

      // Zoom out (Ctrl+-)
      if (matchesShortcut(e, getActiveKey('zoomOut'))) {
        e.preventDefault()
        e.stopPropagation()
        const newSize = Math.max(fontSize - 1, 10)
        if (newSize !== fontSize) {
          updateAppSetting('terminalFontSize', newSize)
        }
        return
      }

      // Zoom reset (Ctrl+0)
      if (matchesShortcut(e, getActiveKey('zoomReset'))) {
        e.preventDefault()
        e.stopPropagation()
        if (fontSize !== DEFAULT_APP_SETTINGS.terminalFontSize) {
          updateAppSetting('terminalFontSize', DEFAULT_APP_SETTINGS.terminalFontSize)
        }
        return
      }

      // Cmd/Ctrl + 1-9 for project switching (keep hardcoded - not customizable)
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault()
        const index = parseInt(e.key) - 1
        if (projects[index]) {
          selectProject(projects[index].id)
        }
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
    fontSize,
    updateAppSetting,
    appDefaultShell,
    maxTerminals,
    isWorkspaceRoute,
    cycleTab,
    activeTab,
    handleCreateTerminalInPane,
    updatePanelVisibility,
    isExplorerVisible,
    isSidebarVisible
  ])

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
        case 'zoomIn': {
          const newSize = Math.min(fontSize + 1, 24)
          if (newSize !== fontSize) {
            updateAppSetting('terminalFontSize', newSize)
          }
          break
        }
        case 'zoomOut': {
          const newSize = Math.max(fontSize - 1, 10)
          if (newSize !== fontSize) {
            updateAppSetting('terminalFontSize', newSize)
          }
          break
        }
        case 'zoomReset':
          if (fontSize !== DEFAULT_APP_SETTINGS.terminalFontSize) {
            updateAppSetting('terminalFontSize', DEFAULT_APP_SETTINGS.terminalFontSize)
          }
          break
        case 'sidebarToggle':
          void updatePanelVisibility('sidebarVisible', !isSidebarVisible).catch((error) => {
            toast.error(error instanceof Error ? error.message : 'Failed to update sidebar visibility')
          })
          break
      }
    })
  }, [cycleTab, fontSize, updateAppSetting, updatePanelVisibility, isSidebarVisible])

  const handleCloseTerminal = useCallback((id: string, tabId: string) => {
    setCloseConfirmTerminal({ terminalId: id, tabId })
  }, [])

  const closeTerminalByRecordId = useCallback(
    async (terminalRecordId: string) => {
      const terminalToClose = useTerminalStore
        .getState()
        .terminals.find((t) => t.id === terminalRecordId)

      if (!terminalToClose) {
        return
      }

      if (terminalToClose.ptyId) {
        try {
          await Promise.race([
            terminalApi.kill(terminalToClose.ptyId),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Kill timeout')), 300))
          ])
        } catch {
          // Continue close flow even if PTY termination fails
        }
      }

      closeTerminal(terminalRecordId, activeProjectId)
    },
    [activeProjectId, closeTerminal]
  )

  const closeTerminalTabByTabId = useCallback(
    async (tabId: string) => {
      const root = useWorkspaceStore.getState().root
      const containingPane = findPaneContainingTab(root, tabId)
      if (!containingPane) {
        return
      }

      const tab = containingPane.tabs.find((t) => t.id === tabId)
      if (!tab || tab.type !== 'terminal') {
        return
      }

      await closeTerminalByRecordId(tab.terminalId)
      useWorkspaceStore.getState().closeTab(containingPane.id, tabId)
    },
    [closeTerminalByRecordId]
  )

  const handleConfirmCloseTerminal = useCallback(async () => {
    if (!closeConfirmTerminal) {
      return
    }

    await closeTerminalTabByTabId(closeConfirmTerminal.tabId)
    setCloseConfirmTerminal(null)
  }, [closeConfirmTerminal, closeTerminalTabByTabId])

  const handleCancelCloseTerminal = useCallback(() => {
    setCloseConfirmTerminal(null)
  }, [])

  // Dirty file close handlers
  const handleCloseEditorTab = useCallback((filePath: string) => {
    const fileState = useEditorStore.getState().openFiles.get(filePath)
    if (fileState?.isDirty) {
      setDirtyCloseFilePath(filePath)
    } else {
      useEditorStore.getState().closeFile(filePath)
      useWorkspaceStore.getState().removeTab(editorTabId(filePath))
    }
  }, [])

  const handleSaveThenClose = useCallback(async () => {
    if (dirtyCloseFilePath) {
      const saved = await useEditorStore.getState().saveFile(dirtyCloseFilePath)
      if (!saved) {
        toast.error('Failed to save file. Changes were not discarded.')
        setDirtyCloseFilePath(null)
        return
      }
      useEditorStore.getState().closeFile(dirtyCloseFilePath)
      useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath))
      setDirtyCloseFilePath(null)
    }
  }, [dirtyCloseFilePath])

  const handleDiscardAndClose = useCallback(() => {
    if (dirtyCloseFilePath) {
      useEditorStore.getState().closeFile(dirtyCloseFilePath)
      useWorkspaceStore.getState().removeTab(editorTabId(dirtyCloseFilePath))
      setDirtyCloseFilePath(null)
    }
  }, [dirtyCloseFilePath])

  const handleCancelDirtyClose = useCallback(() => {
    setDirtyCloseFilePath(null)
  }, [])

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
  const handleInsertCommand = useCallback((command: string) => {
    // TODO: Route to active terminal pane via context
    if (activeTerminal?.ptyId) {
      terminalApi.write(activeTerminal.ptyId, command)
    }
  }, [activeTerminal])

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
    return (
      <div className="h-screen flex flex-col overflow-hidden bg-background">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-muted-foreground text-sm">Loading...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      <TitleBar />

      <div className="flex-1 flex overflow-hidden min-h-0 h-full p-2 gap-0">
        {/* Sidebar */}
        {isSidebarVisible && (
          <div className="mr-2">
            <ProjectSidebar
              projects={projects}
              activeProjectId={activeProjectId}
              onSelectProject={selectProject}
              onNewProject={() => setIsNewProjectModalOpen(true)}
              onUpdateProject={updateProject}
              onDeleteProject={deleteProject}
              onArchiveProject={archiveProject}
              onRestoreProject={restoreProject}
              onReorderProjects={reorderProjects}
            />
          </div>
        )}

        {/* Main Content and File Explorer Container */}
        <div className="flex-1 flex min-h-0 h-full gap-0 overflow-hidden min-w-0">
          {/* Main Content Area */}
          <main className="flex-1 flex flex-col min-w-0 rounded-xl bg-card overflow-hidden">
            {projects.length === 0 ? (
              /* No Projects Empty State */
              <div className="flex-1 flex flex-col items-center justify-center bg-background px-6 rounded-xl">
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.4, ease: 'easeOut' }}
                  className="flex flex-col items-center text-center max-w-md"
                >
                  <div className="mb-6">
                    <FolderKanban className="w-24 h-24 text-muted-foreground/50" />
                  </div>
                  <h2 className="text-xl font-semibold text-foreground mb-2">
                    No Projects Yet
                  </h2>
                  <p className="text-muted-foreground text-sm mb-6 leading-relaxed">
                    Create your first project to organize your terminals, snapshots, and commands
                  </p>
                  <button
                    onClick={() => setIsNewProjectModalOpen(true)}
                    className="px-6 py-2.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors text-sm font-medium shadow-sm hover:shadow"
                  >
                    Create Your First Project
                  </button>
                </motion.div>
              </div>
            ) : (
              <>
                {isWorkspaceRoute ? (
                  <div className="flex-1 min-h-0 h-full overflow-hidden">
                    <PaneDndProvider>
                      <PaneRenderer
                        node={paneRoot}
                        onNewTerminal={(paneId) => {
                          handleCreateTerminalInPane(paneId)
                        }}
                        onNewTerminalWithShell={(paneId, shell) => {
                          handleCreateTerminalInPane(paneId, shell.path)
                        }}
                        onCloseTerminal={handleCloseTerminal}
                        onRenameTerminal={renameTerminal}
                        onCloseEditorTab={handleCloseEditorTab}
                        defaultShell={activeProject?.defaultShell || appDefaultShell}
                      />
                    </PaneDndProvider>
                  </div>
                ) : (
                  <div className="flex-1 overflow-hidden bg-background relative rounded-xl">
                    <div className="w-full h-full">
                      <Outlet />
                    </div>
                  </div>
                )}

                {/* Status Bar */}
                <StatusBar project={activeProject} />
              </>
            )}
          </main>

          {/* File Explorer - separate floating panel */}
          {isExplorerVisible && (
            <div className="flex-shrink-0 ml-2">
              <PaneDndProvider>
                <FileExplorer />
              </PaneDndProvider>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      <NewProjectModal
        isOpen={isNewProjectModalOpen}
        onClose={() => setIsNewProjectModalOpen(false)}
        onCreateProject={addProject}
      />

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        projects={projects}
        onSwitchProject={selectProject}
        onNewTerminal={handleNewTerminal}
        onSaveSnapshot={handleOpenSnapshotModal}
      />

      <CreateSnapshotModal
        isOpen={isCreateSnapshotModalOpen}
        onClose={() => setIsCreateSnapshotModalOpen(false)}
        onCreateSnapshot={handleCreateSnapshot}
      />

      <CommandHistoryModal
        isOpen={isCommandHistoryOpen}
        onClose={() => setIsCommandHistoryOpen(false)}
        entries={commandHistory}
        allEntries={allCommandHistory}
        onSelectCommand={handleInsertCommand}
        onClearHistory={handleClearCommandHistory}
      />

      {/* Close Terminal Confirmation */}
      <ConfirmDialog
        isOpen={closeConfirmTerminal !== null}
        title="Close Terminal"
        message={`Are you sure you want to close "${terminalToClose?.name || 'this terminal'
          }"? Any running processes will be terminated.`}
        confirmLabel="Close"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmCloseTerminal}
        onCancel={handleCancelCloseTerminal}
      />

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
        secondaryAction={{ label: "Don't Save", onClick: handleDiscardAllAndClose }}
        onConfirm={handleSaveAllAndClose}
        onCancel={handleCancelAppClose}
      />
    </div>
  )
}
