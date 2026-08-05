/**
 * Workspace-manifest sync store (CAP-5 / Story 6).
 *
 * Holds the per-project `basedRevision` the renderer proposes against on each
 * `writeManifest` call, the currently-surfaced conflict body (if any), and a
 * per-project restore-in-progress flag the writer consults to cancel pending
 * writes while a manifest-driven restore is rebuilding the workspace tree.
 *
 * The host owns the manifest's `revision` field; the renderer only ever sets
 * `basedRevision` (and only on a write call). `advanceBasedRevision` is called
 * on a successful `Updated` outcome; on `Conflict` the renderer sets
 * `pendingConflict` and never auto-retries the same `basedRevision`.
 */

import { create } from 'zustand'

/**
 * The conflict body surfaced to the UI. Mirrors the `WriteOutcome.Conflict`
 * variant plus the project id the conflict belongs to. Only one conflict is
 * surfaced at a time (coalesced UI); a second stale write while the first
 * banner is showing is a no-op.
 */
export interface ManifestConflictBody {
  projectId: string
  currentRevision: number
  currentUpdatedAt: number
  currentUpdateIdentity?: string
}

export interface WorkspaceManifestSyncState {
  /** Per-project basedRevision proposed on the next write. null = initial. */
  basedRevisionByProject: Record<string, number | null>
  /** Currently-surfaced conflict, or null when none. */
  pendingConflict: ManifestConflictBody | null
  /** Per-project restore-in-progress flag (writer cancels while true). */
  manifestRestoreInProgressByProject: Record<string, boolean>

  setBasedRevision: (projectId: string, revision: number | null) => void
  advanceBasedRevision: (projectId: string, nextRevision: number) => void
  setPendingConflict: (conflict: ManifestConflictBody | null) => void
  setManifestRestoreInProgress: (projectId: string, inProgress: boolean) => void

  getBasedRevision: (projectId: string) => number | null
  hasPendingConflict: (projectId: string) => boolean
}

export const useWorkspaceManifestSyncStore = create<WorkspaceManifestSyncState>((set, get) => ({
  basedRevisionByProject: {},
  pendingConflict: null,
  manifestRestoreInProgressByProject: {},

  setBasedRevision: (projectId: string, revision: number | null): void => {
    if (!projectId) return
    set((state) => ({
      basedRevisionByProject: {
        ...state.basedRevisionByProject,
        [projectId]: revision
      }
    }))
  },

  advanceBasedRevision: (projectId: string, nextRevision: number): void => {
    if (!projectId) return
    set((state) => ({
      basedRevisionByProject: {
        ...state.basedRevisionByProject,
        [projectId]: nextRevision
      }
    }))
  },

  setPendingConflict: (conflict: ManifestConflictBody | null): void => {
    set({ pendingConflict: conflict })
  },

  setManifestRestoreInProgress: (projectId: string, inProgress: boolean): void => {
    if (!projectId) return
    set((state) => ({
      manifestRestoreInProgressByProject: {
        ...state.manifestRestoreInProgressByProject,
        [projectId]: inProgress
      }
    }))
  },

  getBasedRevision: (projectId: string): number | null => {
    return get().basedRevisionByProject[projectId] ?? null
  },

  hasPendingConflict: (projectId: string): boolean => {
    const conflict = get().pendingConflict
    return conflict?.projectId === projectId
  }
}))

/**
 * Convenience wrapper around the store action, mirroring
 * `setTerminalRestoreInProgress(projectId, bool, ownerId)` from
 * `useTerminalAutoSave`. The caller that kicks off a manifest-driven restore
 * (useEditorPersistence restore, or the conflict "reload" action) wraps the
 * load in `setManifestRestoreInProgress(projectId, true)` / `(... false)` so
 * the writer cancels pending writes while the workspace tree is being
 * rebuilt from the host manifest. `loadWorkspaceManifest` itself does NOT set
 * this — the caller owns the guard window to avoid nested-clear races.
 */
export function setManifestRestoreInProgress(projectId: string, inProgress: boolean): void {
  useWorkspaceManifestSyncStore.getState().setManifestRestoreInProgress(projectId, inProgress)
}

/**
 * Global guard mirroring `isTerminalRestoreInProgress()`. The writer
 * (a non-React store subscriber) consults this to cancel pending writes while
 * ANY project's manifest-driven restore is rebuilding the workspace tree,
 * avoiding clobbering the just-restored state. Reads from the store so both
 * the React-reactive Record and the synchronous guard stay in sync.
 */
export function isManifestRestoreInProgress(): boolean {
  const map = useWorkspaceManifestSyncStore.getState().manifestRestoreInProgressByProject
  for (const value of Object.values(map)) {
    if (value) return true
  }
  return false
}

/**
 * Per-project restore guard. The writer consults this (instead of the global
 * OR) so a restore on project A does NOT block debounced writes for project
 * B, C, … — portable-slice changes on other projects during a single
 * project's restore are still persisted. Kept in addition to the global
 * `isManifestRestoreInProgress()` for any external caller that wants the
 * coarse "is anything restoring" signal.
 */
export function isManifestRestoreInProgressFor(projectId: string): boolean {
  return Boolean(
    useWorkspaceManifestSyncStore.getState().manifestRestoreInProgressByProject[projectId]
  )
}
