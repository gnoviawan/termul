import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { FolderKanban, Terminal } from 'lucide-react'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { WorkspaceTabBar } from '@/components/workspace/WorkspaceTabBar'
import { ConnectedTerminal, TerminalSearchHandle } from '@/components/terminal/ConnectedTerminal'
import { TerminalSearchBar } from '@/components/terminal/TerminalSearchBar'
import { StatusBar } from '@/components/StatusBar'
import { NewProjectModal } from '@/components/NewProjectModal'
import { CreateSnapshotModal } from '@/components/CreateSnapshotModal'
import { CommandPalette } from '@/components/CommandPalette'
import { CommandHistoryModal } from '@/components/CommandHistoryModal'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FileExplorer } from '@/components/file-explorer/FileExplorer'
import { EditorPanel } from '@/components/editor/EditorPanel'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle
} from '@/components/ui/resizable'
import type { ShellInfo } from '@shared/types/ipc.types'
import type { EnvVariable } from '@/types/project'
import {
  useProjects,
  useActiveProject,
  useActiveProjectId,
  useProjectActions,
  useProjectsLoaded
} from '@/stores/project-store'
import {
  useTerminals,
  useAllTerminals,
  useActiveTerminal,
  useActiveTerminalId,
  useTerminalActions
} from '@/stores/terminal-store'
import { useFileExplorerStore, useFileExplorerVisible } from '@/stores/file-explorer-store'
import { useEditorStore, useOpenFilePaths } from '@/stores/editor-store'
import {
  useWorkspaceStore,
  useActiveTab,
  useActiveTabId,
  editorTabId
} from '@/stores/workspace-store'
import { useCreateSnapshot, useSnapshotLoader } from '@/hooks/use-snapshots'
import { useRecentCommandsLoader } from '@/hooks/use-recent-commands'
import {
  useCommandHistoryLoader,
  useAddCommand,
  useCommandHistory
} from '@/hooks/use-command-history'
import { useKeyboardShortcutsStore, matchesShortcut } from '@/stores/keyboard-shortcuts-store'
import {
  useTerminalFontSize,
  useDefaultShell,
  useMaxTerminalsPerProject
} from '@/stores/app-settings-store'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { useFileWatcher } from '@/hooks/use-file-watcher'
import { useEditorPersistence } from '@/hooks/use-editor-persistence'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { toast } from 'sonner'

function envVarsToRecord(envVars?: EnvVariable[]): Record<string, string> | undefined {
  if (!envVars || envVars.length === 0) return undefined
  const record: Record<string, string> = {}
  for (const { key, value } of envVars) {
    if (key.trim()) {
      record[key] = value
    }
  }
  return Object.keys(record).length > 0 ? record : undefined
}

export default function WorkspaceLayout(): React.JSX.Element {
  const location = useLocation()
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isCreateSnapshotModalOpen, setIsCreateSnapshotModalOpen] = useState(false)
  const [closeConfirmTerminalId, setCloseConfirmTerminalId] = useState<string | null>(null)
  const [dirtyCloseFilePath, setDirtyCloseFilePath] = useState<string | null>(null)
  const [isTerminalSearchOpen, setIsTerminalSearchOpen] = useState(false)
  const [isCommandHistoryOpen, setIsCommandHistoryOpen] = useState(false)

  const terminalSearchRef = useRef<TerminalSearchHandle>(null)

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
  const allTerminals = useAllTerminals()
  const activeTerminal = useActiveTerminal()
  const activeTerminalId = useActiveTerminalId()
  const {
    selectTerminal,
    addTerminal,
    closeTerminal,
    renameTerminal,
    reorderTerminals,
    setTerminalPtyId
  } = useTerminalActions()

  // File explorer & editor state
  const isExplorerVisible = useFileExplorerVisible()
  const openFilePaths = useOpenFilePaths()
  const activeTabId = useActiveTabId()
  const activeTab = useActiveTab()
  const prevProjectIdRef = useRef<string>('')

  // File watcher hook
  useFileWatcher()

  // Editor state persistence
  useEditorPersistence(activeProjectId)

  // Sync file explorer root path and register project root watcher when project changes
  useEffect(() => {
    if (activeProject?.path && activeProjectId !== prevProjectIdRef.current) {
      useFileExplorerStore.getState().setRootPath(activeProject.path)

      // Watch root directory - this also registers it as an allowed root for path validation
      window.api.filesystem.watchDirectory(activeProject.path)

      prevProjectIdRef.current = activeProjectId
    }
  }, [activeProject?.path, activeProjectId])

  // Sync terminal tabs with workspace store
  useEffect(() => {
    const terminalIds = terminals.map((t) => t.id)
    useWorkspaceStore.getState().syncTerminalTabs(terminalIds)
  }, [terminals])

  // Warn before closing if dirty files exist
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): string | undefined => {
      if (useEditorStore.getState().hasDirtyFiles()) {
        e.preventDefault()
        return ''
      }
      return undefined
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Load snapshots when project changes
  useSnapshotLoader()
  // Load recent commands for command palette
  useRecentCommandsLoader()
  // Load command history for current project
  useCommandHistoryLoader(activeProjectId)
  const addCommand = useAddCommand()
  const commandHistory = useCommandHistory(activeProjectId)
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

  // Unified tab cycling - cycles through ALL workspace tabs
  const cycleTab = useCallback(
    (direction: 'next' | 'prev') => {
      if (!isWorkspaceRoute) return
      const nextTabId = useWorkspaceStore.getState().getNextTabId(direction === 'next' ? 1 : -1)
      if (nextTabId) {
        useWorkspaceStore.getState().setActiveTab(nextTabId)
        // If it's a terminal tab, also select the terminal
        const tab = useWorkspaceStore.getState().tabs.find((t) => t.id === nextTabId)
        if (tab?.type === 'terminal') {
          selectTerminal(tab.terminalId)
        } else if (tab?.type === 'editor') {
          useEditorStore.getState().setActiveFilePath(tab.filePath)
        }
      }
    },
    [isWorkspaceRoute, selectTerminal]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in an input/textarea/editable element
      const target = e.target as HTMLElement
      const isInEditor = target.closest('.cm-content') || target.closest('.bn-editor')
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
          setCloseConfirmTerminalId(activeTab.terminalId)
        }
        return
      }

      // Ctrl+B - toggle file explorer (skip when in editor/input so BlockNote bold works)
      if (e.ctrlKey && e.key === 'b' && !e.shiftKey && !e.altKey) {
        if (!isInEditor && !isInInput) {
          e.preventDefault()
          useFileExplorerStore.getState().toggleVisibility()
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

      // Terminal search (Ctrl+F) - only on workspace routes
      if (matchesShortcut(e, getActiveKey('terminalSearch'))) {
        if (isWorkspaceRoute) {
          e.preventDefault()
          e.stopPropagation()
          if (activeTerminal) {
            setIsTerminalSearchOpen(true)
          }
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
        const shell = activeProject?.defaultShell || appDefaultShell || ''
        const cwd = activeProject?.path
        addTerminal(`Terminal ${terminals.length + 1}`, activeProjectId, shell, cwd)
        return
      }

      // Next terminal (Ctrl+Tab) - only on workspace routes
      if (matchesShortcut(e, getActiveKey('nextTerminal'))) {
        e.preventDefault()
        e.stopPropagation()
        cycleTab('next')
        return
      }

      // Previous terminal (Ctrl+Shift+Tab) - only on workspace routes
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
    selectTerminal,
    getActiveKey,
    fontSize,
    updateAppSetting,
    appDefaultShell,
    maxTerminals,
    isWorkspaceRoute,
    cycleTab,
    activeTab
  ])

  // Listen for keyboard shortcuts from main process (Ctrl+Tab, Ctrl+Shift+Tab, zoom shortcuts)
  useEffect(() => {
    return window.api.keyboard.onShortcut((shortcut) => {
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
      }
    })
  }, [cycleTab, fontSize, updateAppSetting])

  const handleNewTerminal = useCallback(() => {
    if (terminals.length >= maxTerminals) {
      toast.error(`Maximum ${maxTerminals} terminals per project`)
      return
    }
    const shell = activeProject?.defaultShell || appDefaultShell || ''
    const cwd = activeProject?.path
    addTerminal(`Terminal ${terminals.length + 1}`, activeProjectId, shell, cwd)
  }, [addTerminal, terminals.length, activeProjectId, activeProject, appDefaultShell, maxTerminals])

  const handleNewTerminalWithShell = useCallback(
    (shell: ShellInfo) => {
      if (terminals.length >= maxTerminals) {
        toast.error(`Maximum ${maxTerminals} terminals per project`)
        return
      }
      const cwd = activeProject?.path
      addTerminal(`Terminal ${terminals.length + 1}`, activeProjectId, shell.name, cwd)
    },
    [addTerminal, terminals.length, activeProjectId, activeProject, maxTerminals]
  )

  const handleCloseTerminal = useCallback((id: string) => {
    setCloseConfirmTerminalId(id)
  }, [])

  const handleConfirmCloseTerminal = useCallback(() => {
    if (closeConfirmTerminalId) {
      closeTerminal(closeConfirmTerminalId, activeProjectId)
      setCloseConfirmTerminalId(null)
    }
  }, [closeTerminal, activeProjectId, closeConfirmTerminalId])

  const handleCancelCloseTerminal = useCallback(() => {
    setCloseConfirmTerminalId(null)
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

  // Handle Escape key for dirty-close dialog
  useEffect(() => {
    if (dirtyCloseFilePath === null) return

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setDirtyCloseFilePath(null)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [dirtyCloseFilePath])

  // Terminal search handlers
  const handleTerminalSearchClose = useCallback(() => {
    setIsTerminalSearchOpen(false)
  }, [])

  const handleTerminalFindNext = useCallback((term: string) => {
    return terminalSearchRef.current?.findNext(term) ?? false
  }, [])

  const handleTerminalFindPrevious = useCallback((term: string) => {
    return terminalSearchRef.current?.findPrevious(term) ?? false
  }, [])

  const handleTerminalClearDecorations = useCallback(() => {
    terminalSearchRef.current?.clearDecorations()
  }, [])

  // Command history handlers
  const handleCommand = useCallback(
    (command: string) => {
      if (activeTerminal && activeProjectId) {
        addCommand(command, activeTerminal.name, activeTerminal.id, activeProjectId)
      }
    },
    [addCommand, activeTerminal, activeProjectId]
  )

  const handleInsertCommand = useCallback((command: string) => {
    terminalSearchRef.current?.writeText(command)
  }, [])

  // Create stable callback factory for terminal spawn handling
  const spawnedHandlersRef = useRef<Map<string, (ptyId: string) => Promise<void>>>(new Map())
  const setTerminalPtyIdRef = useRef(setTerminalPtyId)
  setTerminalPtyIdRef.current = setTerminalPtyId

  const getTerminalSpawnedHandler = useCallback((terminalStoreId: string) => {
    let handler = spawnedHandlersRef.current.get(terminalStoreId)
    if (!handler) {
      handler = async (ptyId: string) => {
        setTerminalPtyIdRef.current(terminalStoreId, ptyId)
        try {
          await Promise.all([
            window.api.terminal.getGitBranch(ptyId),
            window.api.terminal.getGitStatus(ptyId)
          ])
        } catch {
          // Ignore errors
        }
      }
      spawnedHandlersRef.current.set(terminalStoreId, handler)
    }
    return handler
  }, [])

  const terminalToClose = terminals.find((t) => t.id === closeConfirmTerminalId)

  const projectEnv = useMemo(
    () => envVarsToRecord(activeProject?.envVars),
    [activeProject?.envVars]
  )

  // Determine which terminal is active based on workspace tab
  const isTerminalTabActive = activeTab?.type === 'terminal'
  const isEditorTabActive = activeTab?.type === 'editor'
  const activeEditorFilePath = isEditorTabActive ? activeTab.filePath : null
  const activeTerminalTabId = isTerminalTabActive ? activeTab.terminalId : null

  // Show loading state while projects are being loaded
  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    )
  }

  return (
    <div className="h-screen flex overflow-hidden bg-background">
      {/* Sidebar */}
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

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        {projects.length === 0 ? (
          /* No Projects Empty State */
          <div className="flex-1 flex flex-col items-center justify-center bg-terminal-bg px-6">
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
                className="px-6 py-2.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium shadow-sm hover:shadow"
              >
                Create Your First Project
              </button>
            </motion.div>
          </div>
        ) : (
          <>
            {isWorkspaceRoute ? (
              <div className="flex-1 flex min-h-0">
                <ResizablePanelGroup direction="horizontal">
                  {/* Center Panel: TabBar + Content */}
                  <ResizablePanel defaultSize={isExplorerVisible ? 80 : 100}>
                    <div className="flex flex-col h-full">
                      {/* Tab Bar */}
                      <WorkspaceTabBar
                        onNewTerminal={handleNewTerminal}
                        onNewTerminalWithShell={handleNewTerminalWithShell}
                        onCloseTerminal={handleCloseTerminal}
                        onRenameTerminal={renameTerminal}
                        onSelectTerminal={selectTerminal}
                        onCloseEditorTab={handleCloseEditorTab}
                        defaultShell={activeProject?.defaultShell}
                      />

                      {/* Content Area */}
                      <div className="flex-1 overflow-hidden bg-terminal-bg relative">
                        <div className="w-full h-full relative">
                          {/* Render ALL terminals - use CSS to hide/show */}
                          {allTerminals.map((terminal) => {
                            const isVisible =
                              isWorkspaceRoute &&
                              isTerminalTabActive &&
                              activeTerminalTabId === terminal.id &&
                              terminal.projectId === activeProjectId
                            return (
                              <div
                                key={terminal.id}
                                className={
                                  isVisible
                                    ? 'w-full h-full'
                                    : 'w-full h-full absolute inset-0 invisible'
                                }
                              >
                                <ConnectedTerminal
                                  spawnOptions={{
                                    shell: terminal.shell,
                                    cwd: terminal.cwd,
                                    env: projectEnv
                                  }}
                                  initialScrollback={terminal.pendingScrollback}
                                  className="w-full h-full"
                                  searchRef={isVisible ? terminalSearchRef : undefined}
                                  onCommand={isVisible ? handleCommand : undefined}
                                  onSpawned={getTerminalSpawnedHandler(terminal.id)}
                                  isVisible={isVisible}
                                />
                              </div>
                            )
                          })}

                          {/* Render ALL open editor tabs - use CSS to hide/show */}
                          {openFilePaths.map((filePath) => {
                            const isVisible =
                              isEditorTabActive && activeEditorFilePath === filePath
                            return (
                              <div
                                key={filePath}
                                className={
                                  isVisible
                                    ? 'w-full h-full'
                                    : 'w-full h-full absolute inset-0 invisible'
                                }
                              >
                                <EditorPanel
                                  filePath={filePath}
                                  isVisible={isVisible}
                                />
                              </div>
                            )
                          })}

                          {/* Empty state when no terminals and no editors */}
                          {terminals.length === 0 && openFilePaths.length === 0 && (
                            <div className="absolute inset-0 flex items-center justify-center px-6">
                              <motion.div
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                transition={{ duration: 0.4, ease: 'easeOut' }}
                                className="flex flex-col items-center text-center max-w-md"
                              >
                                <div className="mb-6">
                                  <Terminal className="w-24 h-24 text-muted-foreground/50" />
                                </div>
                                <h2 className="text-xl font-semibold text-foreground mb-2">
                                  No Terminals Yet
                                </h2>
                                <p className="text-muted-foreground text-sm mb-6 leading-relaxed">
                                  Create a terminal to start running commands and managing your project
                                </p>
                                <button
                                  onClick={handleNewTerminal}
                                  className="px-6 py-2.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors text-sm font-medium shadow-sm hover:shadow"
                                >
                                  Create Your First Terminal
                                </button>
                              </motion.div>
                            </div>
                          )}

                          {/* Terminal search bar */}
                          {terminals.length > 0 && (
                            <TerminalSearchBar
                              isOpen={isTerminalSearchOpen}
                              onClose={handleTerminalSearchClose}
                              onFindNext={handleTerminalFindNext}
                              onFindPrevious={handleTerminalFindPrevious}
                              onClearDecorations={handleTerminalClearDecorations}
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  </ResizablePanel>

                  {/* File Explorer Panel (Right, full height) */}
                  {isExplorerVisible && (
                    <>
                      <ResizableHandle />
                      <ResizablePanel defaultSize={20} minSize={10} maxSize={40}>
                        <FileExplorer />
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>

                {/* Render child routes as overlay when on workspace route */}
                <div className="hidden">
                  <Outlet />
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-hidden bg-terminal-bg relative">
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
        onSelectCommand={handleInsertCommand}
      />

      {/* Close Terminal Confirmation */}
      <ConfirmDialog
        isOpen={closeConfirmTerminalId !== null}
        title="Close Terminal"
        message={`Are you sure you want to close "${
          terminalToClose?.name || 'this terminal'
        }"? Any running processes will be terminated.`}
        confirmLabel="Close"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmCloseTerminal}
        onCancel={handleCancelCloseTerminal}
      />

      {/* Dirty File Close Confirmation */}
      <AnimatePresence>
        {dirtyCloseFilePath !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
            onClick={handleCancelDirtyClose}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.15 }}
              className="bg-card rounded-lg shadow-2xl w-[400px] border border-border overflow-hidden"
              onClick={(e) => e.stopPropagation()}
              tabIndex={-1}
              ref={(el) => el?.focus()}
            >
              <div className="p-6">
                <h3 className="text-sm font-semibold text-foreground mb-1">Unsaved Changes</h3>
                <p className="text-sm text-muted-foreground">
                  Save changes to &quot;{dirtyCloseFilePath.split(/[\\/]/).pop()}&quot; before closing?
                </p>
              </div>
              <div className="px-6 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
                <button
                  onClick={handleCancelDirtyClose}
                  className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDiscardAndClose}
                  className="px-3 py-1.5 text-xs font-medium rounded transition-all text-red-400 hover:text-red-300 hover:bg-red-500/10"
                >
                  Discard
                </button>
                <button
                  onClick={handleSaveThenClose}
                  className="px-3 py-1.5 text-xs font-medium rounded transition-all bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  Save
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
