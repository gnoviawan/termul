import { useEffect, useRef } from 'react'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { persistenceApi } from '@/lib/api'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import type { PersistedWorkspaceLayout } from '../../shared/types/persistence.types'
import type { PaneNode } from '@/types/workspace.types'

// ---------------------------------------------------------------------------
// Per-project workspace layout ready signal
//
// restoreFromLayout() in use-terminal-restore.ts calls remapTerminalTabs()
// after spawning PTYs. That remap only works correctly if the pane tree has
// already been loaded from disk (useWorkspaceLayoutLoader). Because both
// operations are async and start concurrently on project switch, we expose a
// per-project Promise here that restoreFromLayout can await before remapping.
// ---------------------------------------------------------------------------

type Resolver = () => void

const layoutReadyResolvers = new Map<string, Resolver[]>()
const layoutReadyProjects = new Set<string>()

/**
 * Returns a Promise that resolves once the workspace layout for the given
 * projectId has been loaded (or reset) from disk. If it is already loaded,
 * resolves immediately.
 */
export function waitForWorkspaceLayoutReady(projectId: string): Promise<void> {
  if (layoutReadyProjects.has(projectId)) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const existing = layoutReadyResolvers.get(projectId) ?? []
    existing.push(resolve)
    layoutReadyResolvers.set(projectId, existing)
  })
}

function markLayoutReady(projectId: string): void {
  layoutReadyProjects.add(projectId)
  const resolvers = layoutReadyResolvers.get(projectId)
  if (resolvers) {
    for (const resolve of resolvers) resolve()
    layoutReadyResolvers.delete(projectId)
  }
}

function resetLayoutReady(projectId: string): void {
  layoutReadyProjects.delete(projectId)
  // Pending waiters from a previous cycle should not be left hanging —
  // resolve them immediately so restore is not blocked on a stale promise.
  const resolvers = layoutReadyResolvers.get(projectId)
  if (resolvers) {
    for (const resolve of resolvers) resolve()
    layoutReadyResolvers.delete(projectId)
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Load persisted workspace layout for the given project on mount / project
 * switch. Calls loadProjectWorkspace() which normalizes the tree and sets
 * activePaneId. Signals waitForWorkspaceLayoutReady() when done so that
 * restoreFromLayout() can safely call remapTerminalTabs() afterwards.
 */
export function useWorkspaceLayoutLoader(projectId: string | undefined): void {
  const loadProjectWorkspace = useWorkspaceStore((state) => state.loadProjectWorkspace)
  const resetLayout = useWorkspaceStore((state) => state.resetLayout)

  useEffect(() => {
    if (!projectId) return

    // Mark as not-ready for this project so waiters will queue up.
    resetLayoutReady(projectId)

    async function load(): Promise<void> {
      const result = await persistenceApi.read<PersistedWorkspaceLayout>(
        PersistenceKeys.workspace(projectId!)
      )

      if (result.success && result.data?.root) {
        try {
          loadProjectWorkspace(result.data.root as PaneNode, result.data.activePaneId)
        } catch (err) {
          // Corrupted layout — fall back to a clean single-pane layout
          console.warn('[WorkspacePersistence] Failed to restore layout, resetting:', err)
          resetLayout()
        }
      } else {
        // No saved layout for this project — reset to a clean state so we
        // don't carry over the previous project's pane tree.
        resetLayout()
      }

      // Signal that the pane tree is ready for this project.
      markLayoutReady(projectId!)
    }

    load()
  // loadProjectWorkspace and resetLayout are stable store actions — safe to omit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
}

/**
 * Auto-save workspace layout whenever the pane tree or active pane changes.
 * Scoped to the current project — writes to workspace/{projectId}.
 * Skips the first emission to avoid overwriting a just-loaded layout.
 */
export function useWorkspaceLayoutAutoSave(projectId: string | undefined): void {
  const hasInitialized = useRef(false)
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId

  useEffect(() => {
    // Reset init flag when project changes so we skip the first emission
    // (which is the load, not a user change).
    hasInitialized.current = false
  }, [projectId])

  useEffect(() => {
    const unsubscribe = useWorkspaceStore.subscribe((state, prevState) => {
      // Skip first emission after mount / project switch
      if (!hasInitialized.current) {
        hasInitialized.current = true
        return
      }

      const currentProjectId = projectIdRef.current
      if (!currentProjectId) return

      // Only save when the pane tree or active pane actually changed
      if (state.root === prevState.root && state.activePaneId === prevState.activePaneId) {
        return
      }

      const data: PersistedWorkspaceLayout = {
        root: state.root,
        activePaneId: state.activePaneId,
        updatedAt: new Date().toISOString(),
      }

      persistenceApi
        .writeDebounced(PersistenceKeys.workspace(currentProjectId), data)
        .catch((err: unknown) => {
          console.error('[WorkspacePersistence] Failed to auto-save layout:', err)
        })
    })

    return () => {
      unsubscribe()
    }
  }, [])
}

/**
 * Save workspace layout immediately (e.g. before page unload).
 */
export async function saveWorkspaceLayout(projectId: string): Promise<void> {
  const { root, activePaneId } = useWorkspaceStore.getState()
  const data: PersistedWorkspaceLayout = {
    root,
    activePaneId,
    updatedAt: new Date().toISOString(),
  }
  await persistenceApi.write(PersistenceKeys.workspace(projectId), data)
}
