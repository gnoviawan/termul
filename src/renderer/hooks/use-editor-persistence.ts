import { useEffect } from 'react'
import { startChatPanelDetach } from '@/lib/chat-panel-detach'
import { projectSwitch } from '@/lib/project-switch/coordinator'
import { useProjectSwitchStatus } from '@/lib/project-switch/status-store'
import { createProjectSwitchDeps, dropTreesOfDeletedProjects } from '@/lib/project-switch/wiring'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { useEditorStore } from '@/stores/editor-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { persistState } from './editor-persistence/persist'

export { deserializePaneTree, reconcileTerminalTabs } from './editor-persistence/pane-tree'
export { persistState } from './editor-persistence/persist'

/**
 * Editor/pane persistence for the active project. Switching is NOT done here:
 * the effect only reports the chosen project to the project-switch
 * coordinator (one latest-wins slot — see `lib/project-switch`), which flushes
 * and persists the project being left, hydrates the target off-store and
 * commits it atomically. This hook binds the coordinator to the real stores
 * for the lifetime of the workspace and owns the debounced save.
 */
export function useEditorPersistence(projectId: string): void {
  // Bind the coordinator for the workspace's lifetime. Unbinding disposes it:
  // anything still hydrating is dropped and never commits.
  useEffect(() => projectSwitch.bind(createProjectSwitchDeps()), [])

  // Release a chat's payload pin once it is in no tab (any project) and idle.
  useEffect(() => startChatPanelDetach(), [])

  // The project store is the user's intent; the coordinator makes it visible.
  // A repeat of the same pick (effect re-run) is a no-op or joins an open.
  useEffect(() => {
    if (!projectId) return
    void projectSwitch.request({ kind: 'pick', projectId })
  }, [projectId])

  // A deleted project's parked tree is garbage.
  useEffect(() => {
    dropTreesOfDeletedProjects()
    const unsubProjects = useProjectStore.subscribe((state, prevState) => {
      if (state.projects !== prevState.projects) dropTreesOfDeletedProjects()
    })
    const unsubWorkspace = useWorkspaceStore.subscribe((state, prevState) => {
      if (state.parkedTrees !== prevState.parkedTrees) dropTreesOfDeletedProjects()
    })
    return () => {
      unsubProjects()
      unsubWorkspace()
    }
  }, [])

  // Save state on changes (debounced) - coalesced across all store subscriptions.
  // Only the committed project is saved, and never while a switch toward it is
  // still loading (its stores are mid-swap).
  useEffect(() => {
    if (!projectId) return

    let persistTimeoutId: ReturnType<typeof setTimeout> | null = null

    const canPersist = (): boolean =>
      useWorkspaceStore.getState().activeProjectId === projectId &&
      useProjectSwitchStatus.getState().pending?.projectId !== projectId

    const schedulePersist = (): void => {
      if (!canPersist()) return
      if (persistTimeoutId) clearTimeout(persistTimeoutId)
      persistTimeoutId = setTimeout(() => {
        if (canPersist()) persistState(projectId)
      }, 500)
    }

    const unsubEditor = useEditorStore.subscribe(schedulePersist)
    const unsubExplorer = useFileExplorerStore.subscribe((state, prevState) => {
      if (state.expandedDirs !== prevState.expandedDirs) {
        schedulePersist()
      }
    })
    const unsubWorkspace = useWorkspaceStore.subscribe(schedulePersist)
    const unsubBrowserSessions = useBrowserSessionStore.subscribe((state, prevState) => {
      if (state.tabs !== prevState.tabs) {
        schedulePersist()
      }
    })

    return () => {
      unsubEditor()
      unsubExplorer()
      unsubWorkspace()
      unsubBrowserSessions()
      if (persistTimeoutId) clearTimeout(persistTimeoutId)
    }
  }, [projectId])
}
