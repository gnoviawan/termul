/**
 * Real-store wiring of the project-switch coordinator's dependencies.
 */

import { retainVisibleAgentChats } from '@/hooks/editor-persistence/chat-restore'
import { commitStagedProject } from '@/hooks/editor-persistence/commit'
import { hydrateProject } from '@/hooks/editor-persistence/hydrate'
import { persistState } from '@/hooks/editor-persistence/persist'
import { flushPendingAutoSaves } from '@/lib/editor-auto-save'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useProjectSwitchStatus } from './status-store'
import type { SwitchDeps } from './types'

export function createProjectSwitchDeps(): SwitchDeps {
  return {
    getCommittedProjectId: () => useWorkspaceStore.getState().activeProjectId,
    getActiveProjectId: () => useProjectStore.getState().activeProjectId,
    getFocusedPaneId: () => useWorkspaceStore.getState().activePaneId,
    hasTree: (projectId) => useWorkspaceStore.getState().hasProjectTree(projectId),
    leave: async (fromProjectId) => {
      // Best effort: a failing file stays unsaved and its draft is persisted. Awaited
      // so no debounced save is still in flight when the leaving project's files clear.
      await flushPendingAutoSaves()
      // A newer request may have committed while the flush was pending: the
      // stores then describe another project and must not be saved as this one.
      if (useWorkspaceStore.getState().activeProjectId !== fromProjectId) return
      retainVisibleAgentChats(fromProjectId)
      persistState(fromProjectId)
    },
    hydrate: (projectId, isCurrent) => hydrateProject(projectId, isCurrent),
    hydrateEditor: (projectId, isCurrent) =>
      hydrateProject(projectId, isCurrent, { withTree: false }),
    commit: commitStagedProject,
    landingProjectId: () =>
      useProjectStore.getState().projects.find((project) => !project.isArchived)?.id ?? '',
    revertTo: (projectId) => useProjectStore.getState().selectProject(projectId),
    setStatus: (status) => useProjectSwitchStatus.getState().apply(status)
  }
}

/** Drop parked trees of projects that no longer exist (deleted). */
export function dropTreesOfDeletedProjects(): void {
  const { parkedTrees, dropProjectTree } = useWorkspaceStore.getState()
  const known = new Set(useProjectStore.getState().projects.map((project) => project.id))
  for (const projectId of Object.keys(parkedTrees)) {
    if (!known.has(projectId)) dropProjectTree(projectId)
  }
}
