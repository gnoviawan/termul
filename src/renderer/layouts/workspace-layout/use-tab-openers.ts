import type { ShellInfo } from '@shared/types/ipc.types'
import { useCallback, useEffect } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { toast } from 'sonner'
import { WORKTREE_EVENTS } from '@/hooks/use-worktree-shortcuts'
import { getActiveWorkingCopy, reportUnresolvedWorkingCopy } from '@/lib/active-working-copy'
import { launchAgentInPane } from '@/lib/agent-launch'
import { BUILT_IN_AGENTS } from '@/lib/agents/agent-registry'
import { openProjectCanvas } from '@/lib/open-project-canvas'
import { openTerminalAtCwd, spawnTerminalInPane } from '@/lib/terminal-spawn'
import { randomUUID } from '@/lib/uuid'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useDefaultShell } from '@/stores/app-settings-store'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
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

/**
 * The cwd a new terminal / git tab opens at: the active working copy (active
 * tab, else the switcher pick, else the project folder), or `null` after a
 * toast when it is unresolved (a worktree no longer listed). Unresolved never
 * falls back to the project folder; it triggers one worktree reconcile.
 */
function resolveWorkingCopyCwd(projectId: string, action: string): string | null {
  const wc = getActiveWorkingCopy(projectId)
  if (wc?.state === 'unresolved') {
    reportUnresolvedWorkingCopy(projectId, wc)
    toast.error('This worktree is no longer available', {
      description: `${action} is blocked while Termul refreshes the worktree list.`
    })
    return null
  }
  return wc?.path ?? getDefaultCwdForProject(projectId)
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
    void openProjectCanvas(activeProjectId, projectPath)
  }, [activeProjectId, activeProject?.path, setIsCommandPaletteOpen])

  // Terminal creation callbacks - defined before keyboard shortcut useEffect
  const handleCreateTerminalInPane = useCallback(
    async (paneId: string, shellName?: string, explicitCwd?: string) => {
      const cwd = explicitCwd ?? resolveWorkingCopyCwd(activeProjectId, 'Opening a terminal')
      if (cwd === null) return

      const result = await spawnTerminalInPane(paneId, activeProjectId, cwd, {
        shell: shellName || activeProject?.defaultShell || appDefaultShell || undefined,
        envVars: activeProject?.envVars
      })
      if (!result.success) {
        toast.error(result.error || 'Failed to create terminal')
      }
    },
    [activeProject?.defaultShell, activeProject?.envVars, activeProjectId, appDefaultShell]
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
        envVars: activeProject?.envVars
      }
    )
    if (!result.success) {
      toast.error(result.error || 'Failed to launch agent')
    }
  }, [activeProjectId, activeProject?.envVars])

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
        const cwd = resolveWorkingCopyCwd(activeProjectId, 'Opening Git')
        if (!cwd) return
        // Reuse-by-(type, cwd): activating the existing tab instead of
        // minting `git-${randomUUID()}` per click (QA: 4 clicks → 4 tabs).
        useWorkspaceStore.getState().addGitTab(cwd, resolvedPaneId)
      }
    },
    [activeProject?.path, activeProjectId]
  )

  // Ctrl+Shift+Alt+T: open a default-shell terminal in the active pane at the
  // active working copy. It never writes the switcher pick.
  useEffect(() => {
    if (!activeProjectId) return
    const onOpenTerminal = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId?: string } | undefined>).detail
      if (detail?.projectId && detail.projectId !== activeProjectId) return
      const cwd = resolveWorkingCopyCwd(activeProjectId, 'Opening a terminal')
      if (!cwd) return
      const paneId = useWorkspaceStore.getState().activePaneId
      if (!paneId) {
        toast.error('No active pane', {
          description: 'Cannot open terminal without an active workspace pane.'
        })
        return
      }
      // Same path as the New terminal action: project/app default shell + env.
      void handleCreateTerminalInPane(paneId, undefined, cwd)
    }
    window.addEventListener(WORKTREE_EVENTS.OPEN_TERMINAL, onOpenTerminal)
    return () => window.removeEventListener(WORKTREE_EVENTS.OPEN_TERMINAL, onOpenTerminal)
  }, [activeProjectId, handleCreateTerminalInPane])

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
