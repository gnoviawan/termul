import type { ShellInfo } from '@shared/types/ipc.types'
import { useCallback, useEffect } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { toast } from 'sonner'
import { launchAgentInPane } from '@/lib/agent-launch'
import { BUILT_IN_AGENTS } from '@/lib/agents/agent-registry'
import { filesystemApi } from '@/lib/api'
import { pickCanvasDoc } from '@/lib/canvas-doc'
import { spawnTerminalInPane } from '@/lib/terminal-spawn'
import { randomUUID } from '@/lib/uuid'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useDefaultShell, useMaxTerminalsPerProject } from '@/stores/app-settings-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'

interface UseTabOpenersOptions {
  activeProject: Project | undefined
  activeProjectId: string
  pathname: string
  navigate: NavigateFunction
  setIsCommandPaletteOpen: (open: boolean) => void
  gitSheetOpen: boolean
  gitSheetProjectId: string | null
  closeGitSheet: () => void
}

/** Handlers that open terminals, agents, browser/git/canvas tabs, plus the git-sheet close effects. */
export function useTabOpeners({
  activeProject,
  activeProjectId,
  pathname,
  navigate,
  setIsCommandPaletteOpen,
  gitSheetOpen,
  gitSheetProjectId,
  closeGitSheet
}: UseTabOpenersOptions) {
  const appDefaultShell = useDefaultShell()
  const maxTerminals = useMaxTerminalsPerProject()

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
  }, [activeProjectId, activeProject?.path, setIsCommandPaletteOpen])

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
    if (pathname !== '/') {
      navigate('/')
      requestAnimationFrame(open)
    } else {
      open()
    }
  }, [activeProject?.path, pathname, navigate])

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

  return {
    handleOpenCanvas,
    handleCreateTerminalInPane,
    handleLaunchAgent,
    handleAddTerminal,
    handleNewBrowserTab,
    handleOpenAgentChat,
    handleAddGitTab,
    handleAddGitHistoryTab
  }
}
