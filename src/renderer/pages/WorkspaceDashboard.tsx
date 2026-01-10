import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { TerminalTabBar } from '@/components/TerminalTabBar'
import { ConnectedTerminal, TerminalSearchHandle } from '@/components/terminal/ConnectedTerminal'
import { TerminalSearchBar } from '@/components/terminal/TerminalSearchBar'
import { StatusBar } from '@/components/StatusBar'
import { NewProjectModal } from '@/components/NewProjectModal'
import { CreateSnapshotModal } from '@/components/CreateSnapshotModal'
import { CommandPalette } from '@/components/CommandPalette'
import { CommandHistoryModal } from '@/components/CommandHistoryModal'
import { ConfirmDialog } from '@/components/ConfirmDialog'
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
import { useCreateSnapshot, useSnapshotLoader } from '@/hooks/use-snapshots'
import { useRecentCommandsLoader } from '@/hooks/use-recent-commands'
import { useCommandHistoryLoader, useAddCommand, useCommandHistory } from '@/hooks/use-command-history'
import {
  useKeyboardShortcutsStore,
  matchesShortcut
} from '@/stores/keyboard-shortcuts-store'
import { useTerminalFontSize, useDefaultShell, useMaxTerminalsPerProject } from '@/stores/app-settings-store'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
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

export default function WorkspaceDashboard(): React.JSX.Element {
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isCreateSnapshotModalOpen, setIsCreateSnapshotModalOpen] = useState(false)
  const [closeConfirmTerminalId, setCloseConfirmTerminalId] = useState<string | null>(null)
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
  const { selectTerminal, addTerminal, closeTerminal, renameTerminal, reorderTerminals } =
    useTerminalActions()

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Command palette (Ctrl+K)
      if (matchesShortcut(e, getActiveKey('commandPalette'))) {
        e.preventDefault()
        setIsCommandPaletteOpen(true)
        return
      }

      // Command palette alt (Ctrl+Shift+P)
      if (matchesShortcut(e, getActiveKey('commandPaletteAlt'))) {
        e.preventDefault()
        setIsCommandPaletteOpen(true)
        return
      }

      // Terminal search (Ctrl+F)
      if (matchesShortcut(e, getActiveKey('terminalSearch'))) {
        e.preventDefault()
        if (activeTerminal) {
          setIsTerminalSearchOpen(true)
        }
        return
      }

      // Command history (Ctrl+R)
      if (matchesShortcut(e, getActiveKey('commandHistory'))) {
        e.preventDefault()
        if (activeProjectId) {
          setIsCommandHistoryOpen(true)
        }
        return
      }

      // New project (Ctrl+N)
      if (matchesShortcut(e, getActiveKey('newProject'))) {
        e.preventDefault()
        setIsNewProjectModalOpen(true)
        return
      }

      // New terminal (Ctrl+T)
      if (matchesShortcut(e, getActiveKey('newTerminal'))) {
        e.preventDefault()
        if (terminals.length >= maxTerminals) {
          toast.error(`Maximum ${maxTerminals} terminals per project`)
          return
        }
        const shell = activeProject?.defaultShell || appDefaultShell || ''
        const cwd = activeProject?.path
        addTerminal(`Terminal ${terminals.length + 1}`, activeProjectId, shell, cwd)
        return
      }

      // Next terminal (Ctrl+Tab)
      if (matchesShortcut(e, getActiveKey('nextTerminal'))) {
        e.preventDefault()
        if (terminals.length > 1 && activeTerminalId) {
          const currentIndex = terminals.findIndex((t) => t.id === activeTerminalId)
          const nextIndex = (currentIndex + 1) % terminals.length
          selectTerminal(terminals[nextIndex].id)
        }
        return
      }

      // Previous terminal (Ctrl+Shift+Tab)
      if (matchesShortcut(e, getActiveKey('prevTerminal'))) {
        e.preventDefault()
        if (terminals.length > 1 && activeTerminalId) {
          const currentIndex = terminals.findIndex((t) => t.id === activeTerminalId)
          const prevIndex = (currentIndex - 1 + terminals.length) % terminals.length
          selectTerminal(terminals[prevIndex].id)
        }
        return
      }

      // Zoom in (Ctrl+=)
      if (matchesShortcut(e, getActiveKey('zoomIn'))) {
        e.preventDefault()
        const newSize = Math.min(fontSize + 1, 24)
        if (newSize !== fontSize) {
          updateAppSetting('terminalFontSize', newSize)
        }
        return
      }

      // Zoom out (Ctrl+-)
      if (matchesShortcut(e, getActiveKey('zoomOut'))) {
        e.preventDefault()
        const newSize = Math.max(fontSize - 1, 10)
        if (newSize !== fontSize) {
          updateAppSetting('terminalFontSize', newSize)
        }
        return
      }

      // Zoom reset (Ctrl+0)
      if (matchesShortcut(e, getActiveKey('zoomReset'))) {
        e.preventDefault()
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
    maxTerminals
  ])

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

  const handleCloseTerminal = useCallback(
    (id: string) => {
      // Show confirmation dialog - terminal always has a running shell process
      setCloseConfirmTerminalId(id)
    },
    []
  )

  const handleConfirmCloseTerminal = useCallback(() => {
    if (closeConfirmTerminalId) {
      closeTerminal(closeConfirmTerminalId, activeProjectId)
      setCloseConfirmTerminalId(null)
    }
  }, [closeTerminal, activeProjectId, closeConfirmTerminalId])

  const handleCancelCloseTerminal = useCallback(() => {
    setCloseConfirmTerminalId(null)
  }, [])

  // Terminal search handlers
  const handleTerminalSearchClose = useCallback(() => {
    setIsTerminalSearchOpen(false)
  }, [])

  const handleTerminalFindNext = useCallback(
    (term: string) => {
      return terminalSearchRef.current?.findNext(term) ?? false
    },
    []
  )

  const handleTerminalFindPrevious = useCallback(
    (term: string) => {
      return terminalSearchRef.current?.findPrevious(term) ?? false
    },
    []
  )

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

  const handleInsertCommand = useCallback(
    (command: string) => {
      terminalSearchRef.current?.writeText(command)
    },
    []
  )

  const terminalToClose = terminals.find((t) => t.id === closeConfirmTerminalId)

  // Memoize project env vars to avoid unnecessary re-renders
  const projectEnv = useMemo(
    () => envVarsToRecord(activeProject?.envVars),
    [activeProject?.envVars]
  )

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
          <div className="flex-1 flex flex-col items-center justify-center bg-terminal-bg">
            <p className="text-muted-foreground text-sm mb-4">
              No projects yet. Create one to get started.
            </p>
            <button
              onClick={() => setIsNewProjectModalOpen(true)}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              Create Project
            </button>
          </div>
        ) : (
          <>
            {/* Tab Bar */}
            <TerminalTabBar
          terminals={terminals}
          activeTerminalId={activeTerminalId}
          onSelectTerminal={selectTerminal}
          onCloseTerminal={handleCloseTerminal}
          onNewTerminal={handleNewTerminal}
          onNewTerminalWithShell={handleNewTerminalWithShell}
          onRenameTerminal={renameTerminal}
          onReorderTerminals={(orderedIds) => reorderTerminals(activeProjectId, orderedIds)}
          defaultShell={activeProject?.defaultShell}
        />

        {/* Terminal Area */}
        <div className="flex-1 overflow-hidden bg-terminal-bg relative">
          {/* Render ALL terminals to keep PTYs alive across project switches */}
          {allTerminals.map((terminal) => {
            const isActiveTerminal =
              terminal.id === activeTerminalId && terminal.projectId === activeProjectId
            return (
              <div
                key={terminal.id}
                className={
                  isActiveTerminal
                    ? 'w-full h-full'
                    : 'w-full h-full absolute inset-0 invisible'
                }
              >
                <ConnectedTerminal
                  spawnOptions={{
                    shell: terminal.shell,
                    cwd: terminal.cwd
                  }}
                  initialScrollback={terminal.pendingScrollback}
                  className="w-full h-full"
                  searchRef={isActiveTerminal ? terminalSearchRef : undefined}
                  onCommand={isActiveTerminal ? handleCommand : undefined}
                  isVisible={isActiveTerminal}
                />
              </div>
            )
          })}
          {/* Show empty state only when current project has no terminals */}
          {terminals.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <p className="text-muted-foreground text-sm mb-4">
                No terminal open. Create one to get started.
              </p>
              <button
                onClick={handleNewTerminal}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                Create Terminal
              </button>
            </div>
          )}
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
        message={`Are you sure you want to close "${terminalToClose?.name || 'this terminal'}"? Any running processes will be terminated.`}
        confirmLabel="Close"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmCloseTerminal}
        onCancel={handleCancelCloseTerminal}
      />
    </div>
  )
}
