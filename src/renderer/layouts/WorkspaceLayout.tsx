import { useCallback, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { WebTokenGateScreen } from '@/components/WebTokenGateScreen'
import { useEditorPersistence } from '@/hooks/use-editor-persistence'
import { useFileWatcher } from '@/hooks/use-file-watcher'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useProjectSwitch } from '@/hooks/use-project-switch'
import { useWorkspaceManifestSync } from '@/hooks/use-workspace-manifest-sync'
import { useWorktreeShortcuts } from '@/hooks/use-worktree-shortcuts'
import { useWorkspaceOverlayBackStack } from '@/layouts/use-workspace-overlay-back-stack'
import { DesktopWorkspaceShell } from '@/layouts/workspace-layout/DesktopWorkspaceShell'
import { MobileWorkspaceShell } from '@/layouts/workspace-layout/MobileWorkspaceShell'
import { useAppClose } from '@/layouts/workspace-layout/use-app-close'
import { useBulkTabClose } from '@/layouts/workspace-layout/use-bulk-tab-close'
import { useCloseActiveTab } from '@/layouts/workspace-layout/use-close-active-tab'
import { useCommandPaletteData } from '@/layouts/workspace-layout/use-command-palette-data'
import { useEditorTabClose } from '@/layouts/workspace-layout/use-editor-tab-close'
import { useModalBrowserHide } from '@/layouts/workspace-layout/use-modal-browser-hide'
import { useOverlayActions } from '@/layouts/workspace-layout/use-overlay-actions'
import { useProjectRootWatch } from '@/layouts/workspace-layout/use-project-root-watch'
import { useShortcutLabels } from '@/layouts/workspace-layout/use-shortcut-labels'
import { useSSHWorkspace } from '@/layouts/workspace-layout/use-ssh-workspace'
import { useTabOpeners } from '@/layouts/workspace-layout/use-tab-openers'
import { useTerminalClose } from '@/layouts/workspace-layout/use-terminal-close'
import { useTerminalTabSync } from '@/layouts/workspace-layout/use-terminal-tab-sync'
import { useWorkspaceBoot } from '@/layouts/workspace-layout/use-workspace-boot'
import { useWorkspaceKeyboard } from '@/layouts/workspace-layout/use-workspace-keyboard'
import { WorkspaceLoadingScreen } from '@/layouts/workspace-layout/WorkspaceLoadingScreen'
import { WorkspaceMain } from '@/layouts/workspace-layout/WorkspaceMain'
import { WorkspaceModals } from '@/layouts/workspace-layout/WorkspaceModals'
import { useWebAuthGate } from '@/lib/web-auth-gate'
import { isWorkspaceRoutePath } from '@/lib/workspace-route'
import { useGitSheetStore } from '@/stores/git-sheet-store'
import {
  useActiveProject,
  useActiveProjectId,
  useProjectActions,
  useProjects,
  useProjectsLoaded
} from '@/stores/project-store'
import { useTerminals } from '@/stores/terminal-store'
import { useActiveTab, useWorkspaceStore } from '@/stores/workspace-store'

export default function WorkspaceLayout(): React.JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false)

  // Agent chat entry point (moved from the pane tab bar to the Activity Rail).
  // The dialogs are owned here so the rail button can open them globally; the

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false)
  const [isShortcutMenuOpen, setIsShortcutMenuOpen] = useState(false)
  const [isCreateSnapshotModalOpen, setIsCreateSnapshotModalOpen] = useState(false)
  const [isCommandHistoryOpen, setIsCommandHistoryOpen] = useState(false)
  // Mobile-only full-width Sheet rendering GitPanel (single-column mobile
  // branch). Open state + snapshotted cwd live in a store so the chat dock's
  // changed-files bar can open it too.
  const { open: gitSheetOpen, cwd: gitSheetCwd, projectId: gitSheetProjectId } = useGitSheetStore()
  const { openGitSheet, closeGitSheet } = useGitSheetStore.getState()

  const isLoaded = useProjectsLoaded()

  const webAuthGate = useWebAuthGate()

  const projects = useProjects()
  const activeProject = useActiveProject()
  const activeProjectId = useActiveProjectId()
  const { selectProject, addProject } = useProjectActions()

  useWorkspaceBoot({ navigate, activeProjectId })

  const terminals = useTerminals()

  const isMobileWebShell = useMobileWebShell()
  const { switchTo: switchProjectFromPalette } = useProjectSwitch('CommandPalette')

  const ssh = useSSHWorkspace()

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
    isSshPasswordPromptOpen: ssh.sshPasswordPrompt !== null,
    closeSshPasswordPrompt: ssh.closeSshPasswordPrompt,
    locationKey: location.key
  })

  const handleSelectProject = useCallback(
    (id: string) => {
      selectProject(id)
      ssh.selectSSHProfile(null) // Deselect SSH when switching to project
    },
    [selectProject, ssh.selectSSHProfile]
  )
  const activeTab = useActiveTab()
  const isAgentLauncherOpen = useWorkspaceStore((s) => s.agentLauncherPaneId !== null)

  const editorTabClose = useEditorTabClose()
  const { closeActiveTab, handleCloseTerminalRef } = useCloseActiveTab({
    activeTab,
    isAgentLauncherOpen,
    setDirtyCloseFilePath: editorTabClose.setDirtyCloseFilePath
  })

  // File watcher hook
  useFileWatcher()

  // Worktree shortcut handlers
  useWorktreeShortcuts()

  useProjectRootWatch({ activeProject, activeProjectId })

  // Editor state persistence
  useEditorPersistence(activeProjectId)

  // Story 6: cross-client workspace manifest sync (load happens inside
  // useEditorPersistence's restore flow via loadAndRestoreManifest; this hook
  // wires the debounced write side + conflict surfacing).
  useWorkspaceManifestSync(activeProjectId)

  useTerminalTabSync({ terminals, activeProjectId })

  const appClose = useAppClose()

  const paletteData = useCommandPaletteData({ activeProjectId })

  const overlayActions = useOverlayActions({
    setIsCommandPaletteOpen,
    setIsShortcutMenuOpen,
    setIsCreateSnapshotModalOpen,
    setIsCommandHistoryOpen
  })
  const { handleOpenThemePicker, handleToggleThemePicker } = overlayActions

  const shortcutLabels = useShortcutLabels()

  const tabOpeners = useTabOpeners({
    activeProject,
    activeProjectId,
    pathname: location.pathname,
    navigate,
    setIsCommandPaletteOpen,
    gitSheetOpen,
    gitSheetProjectId,
    closeGitSheet
  })
  const { handleNewBrowserTab } = tabOpeners

  // Determine if we should show the terminal area (only on workspace dashboard)
  const isWorkspaceRoute = isWorkspaceRoutePath(location.pathname)

  useWorkspaceKeyboard({
    activeTab,
    activeProjectId,
    projects,
    selectProject,
    isWorkspaceRoute,
    isAgentLauncherOpen,
    closeActiveTab,
    getActiveKey: shortcutLabels.getActiveKey,
    handleNewBrowserTab,
    handleOpenThemePicker,
    setIsCommandPaletteOpen,
    setIsCommandHistoryOpen,
    setIsNewProjectModalOpen
  })

  useModalBrowserHide({ isNewProjectModalOpen, isAgentLauncherOpen, activeTab })

  const terminalClose = useTerminalClose({ activeProjectId, handleCloseTerminalRef })
  const bulkTabClose = useBulkTabClose({
    activeProjectId,
    closingTerminalIds: terminalClose.closingTerminalIds,
    closeTerminalTabByTabId: terminalClose.closeTerminalTabByTabId
  })

  // Show loading state while projects are being loaded
  if (!isLoaded) {
    // #854: a token-gated server refusing our (absent/rotated) token shows
    // the token-entry screen INSTEAD of the Loading state — the missing UX
    // that made the web client hang forever on an installed PWA.
    if (webAuthGate.status === 'unauthorized') {
      return <WebTokenGateScreen />
    }
    return (
      <WorkspaceLoadingScreen
        isMobileWebShell={isMobileWebShell}
        isShortcutMenuOpen={isShortcutMenuOpen}
        setIsShortcutMenuOpen={setIsShortcutMenuOpen}
        setIsCommandPaletteOpen={setIsCommandPaletteOpen}
      />
    )
  }

  const workspaceMain = (
    <WorkspaceMain
      isMobileWebShell={isMobileWebShell}
      isWorkspaceRoute={isWorkspaceRoute}
      projects={projects}
      activeProject={activeProject}
      ssh={ssh}
      setIsNewProjectModalOpen={setIsNewProjectModalOpen}
      handleAddTerminal={tabOpeners.handleAddTerminal}
      handleNewBrowserTab={handleNewBrowserTab}
      handleCloseTerminal={terminalClose.handleCloseTerminal}
      handleCloseEditorTab={editorTabClose.handleCloseEditorTab}
      handleCloseTabs={bulkTabClose.handleCloseTabs}
      closingTerminalIds={terminalClose.closingTerminalIds}
    />
  )

  const appModals = (
    <WorkspaceModals
      isMobileWebShell={isMobileWebShell}
      projects={projects}
      activeProjectId={activeProjectId}
      addProject={addProject}
      selectProject={selectProject}
      switchProjectFromPalette={switchProjectFromPalette}
      isNewProjectModalOpen={isNewProjectModalOpen}
      setIsNewProjectModalOpen={setIsNewProjectModalOpen}
      isCommandPaletteOpen={isCommandPaletteOpen}
      setIsCommandPaletteOpen={setIsCommandPaletteOpen}
      isCreateSnapshotModalOpen={isCreateSnapshotModalOpen}
      setIsCreateSnapshotModalOpen={setIsCreateSnapshotModalOpen}
      isCommandHistoryOpen={isCommandHistoryOpen}
      setIsCommandHistoryOpen={setIsCommandHistoryOpen}
      ssh={ssh}
      overlayActions={overlayActions}
      paletteData={paletteData}
      shortcutLabels={shortcutLabels}
      handleAddTerminal={tabOpeners.handleAddTerminal}
      handleLaunchAgent={tabOpeners.handleLaunchAgent}
      handleNewBrowserTab={handleNewBrowserTab}
      handleOpenCanvas={tabOpeners.handleOpenCanvas}
      terminals={terminals}
      terminalClose={terminalClose}
      editorTabClose={editorTabClose}
      appClose={appClose}
      bulkTabClose={bulkTabClose}
    />
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
      <MobileWorkspaceShell
        activeProject={activeProject}
        activeProjectId={activeProjectId}
        gitSheetOpen={gitSheetOpen}
        gitSheetCwd={gitSheetCwd}
        openGitSheet={openGitSheet}
        closeGitSheet={closeGitSheet}
        handleOpenAgentChat={tabOpeners.handleOpenAgentChat}
        handleAddGitHistoryTab={tabOpeners.handleAddGitHistoryTab}
        handleAddTerminal={tabOpeners.handleAddTerminal}
        handleCloseTerminal={terminalClose.handleCloseTerminal}
        handleCloseEditorTab={editorTabClose.handleCloseEditorTab}
        handleOpenProjectSettings={overlayActions.handleOpenProjectSettings}
        handleOpenCommandHistory={overlayActions.handleOpenCommandHistory}
        handleCreateTerminalInPane={tabOpeners.handleCreateTerminalInPane}
        setIsCommandPaletteOpen={setIsCommandPaletteOpen}
        setIsNewProjectModalOpen={setIsNewProjectModalOpen}
        workspaceMain={workspaceMain}
        appModals={appModals}
      />
    )
  }

  return (
    <DesktopWorkspaceShell
      projects={projects}
      activeProject={activeProject}
      activeProjectId={activeProjectId}
      ssh={ssh}
      isShortcutMenuOpen={isShortcutMenuOpen}
      setIsShortcutMenuOpen={setIsShortcutMenuOpen}
      setIsCommandPaletteOpen={setIsCommandPaletteOpen}
      setIsNewProjectModalOpen={setIsNewProjectModalOpen}
      onSelectProject={handleSelectProject}
      handleAddGitTab={tabOpeners.handleAddGitTab}
      handleAddGitHistoryTab={tabOpeners.handleAddGitHistoryTab}
      handleToggleThemePicker={handleToggleThemePicker}
      handleOpenAgentChat={tabOpeners.handleOpenAgentChat}
      handleOpenCanvas={tabOpeners.handleOpenCanvas}
      workspaceMain={workspaceMain}
      appModals={appModals}
    />
  )
}
