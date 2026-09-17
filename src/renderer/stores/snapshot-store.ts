import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import type { Snapshot } from '@/types/project'
import type {
  PersistedSnapshot,
  PersistedSnapshotList,
  PersistedTerminal
} from '../../shared/types/persistence.types'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import { useProjectStore } from './project-store'

export interface SnapshotState {
  // State
  snapshots: Snapshot[]
  isLoading: boolean

  // Actions
  createSnapshot: (
    name: string,
    description: string | undefined,
    projectId: string,
    terminals: PersistedTerminal[],
    activeTerminalId: string | null
  ) => Promise<Snapshot>
  loadSnapshots: (projectId: string) => Promise<void>
  deleteSnapshot: (id: string) => Promise<void>
  renameSnapshot: (id: string, name: string) => Promise<void>
  getSnapshot: (id: string) => Promise<PersistedSnapshot | null>
  clearSnapshots: () => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

function persistedToSnapshot(persisted: PersistedSnapshot): Snapshot {
  return {
    id: persisted.id,
    projectId: persisted.projectId,
    name: persisted.name,
    description: persisted.description,
    createdAt: new Date(persisted.createdAt),
    paneCount: persisted.terminals.length,
    processCount: 0, // We don't track active processes in snapshots
    tag: persisted.tag
  }
}

function snapshotToPersisted(
  snapshot: Snapshot,
  terminals: PersistedTerminal[],
  activeTerminalId: string | null
): PersistedSnapshot {
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    name: snapshot.name,
    description: snapshot.description,
    createdAt: snapshot.createdAt.toISOString(),
    terminals,
    activeTerminalId,
    tag: snapshot.tag
  }
}

/**
 * Per-project mutation queue (CodeRabbit: serialize snapshot-list
 * read-modify-write sequences). createSnapshot / renameSnapshot /
 * deleteSnapshot each read the persisted list and overwrite it; overlapping
 * mutations can interleave (rename reading the pre-delete list, then
 * rewriting it — resurrecting the deleted snapshot). Chaining every
 * mutation through a per-project promise tail serializes them; a failed
 * mutation still advances the chain (the next one runs; the error
 * propagates to ITS caller only).
 */
const snapshotMutationQueues = new Map<string, Promise<unknown>>()

function enqueueSnapshotMutation<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  const tail = snapshotMutationQueues.get(projectId) ?? Promise.resolve()
  const next = tail.then(run, run)
  // Keep the chain alive on rejection: the failure propagates to the caller
  // of `run`, but the NEXT enqueued mutation must still execute.
  snapshotMutationQueues.set(
    projectId,
    next.catch(() => undefined)
  )
  return next
}

/** Durable boundary log for snapshot list mutations (metadata only). */
function logSnapshotBoundary(
  operation: 'create' | 'rename' | 'delete',
  projectId: string,
  outcome: 'ok' | 'failed',
  detail?: string
): void {
  void logFrontendError({
    level: outcome === 'ok' ? 'info' : 'error',
    source: `snapshot-store.${operation}Snapshot`,
    message: `snapshot ${operation} ${outcome} project=${projectId}${detail ? ` ${detail}` : ''}`
  })
}

export const useSnapshotStore = create<SnapshotState>((set, get) => ({
  snapshots: [],
  isLoading: false,

  createSnapshot: async (
    name: string,
    description: string | undefined,
    projectId: string,
    terminals: PersistedTerminal[],
    activeTerminalId: string | null
  ): Promise<Snapshot> => {
    const newSnapshot: Snapshot = {
      id: generateId(),
      projectId,
      name,
      description: description || undefined,
      createdAt: new Date(),
      paneCount: terminals.length,
      processCount: 0
    }

    // Add to local state first (optimistic update)
    set((state) => ({
      snapshots: [newSnapshot, ...state.snapshots]
    }))

    // Persist to storage — serialized per project (CodeRabbit: overlapping
    // list mutations must not interleave) with a durable boundary log.
    try {
      await enqueueSnapshotMutation(projectId, async () => {
        const key = PersistenceKeys.snapshots(projectId)
        const existingResult = await persistenceApi.read<PersistedSnapshotList>(key)

        const existingSnapshots: PersistedSnapshot[] =
          existingResult.success && existingResult.data ? existingResult.data.snapshots : []

        const persistedSnapshot = snapshotToPersisted(newSnapshot, terminals, activeTerminalId)
        const updatedList: PersistedSnapshotList = {
          snapshots: [persistedSnapshot, ...existingSnapshots],
          updatedAt: new Date().toISOString()
        }

        const writeResult = await persistenceApi.write(key, updatedList)
        if (!writeResult.success) {
          throw new Error(`Failed to persist snapshot: ${writeResult.error}`)
        }
        logSnapshotBoundary('create', projectId, 'ok')
      })
    } catch (error) {
      // Rollback optimistic update on failure (incl. a rejected read).
      set((state) => ({
        snapshots: state.snapshots.filter((s) => s.id !== newSnapshot.id)
      }))
      logSnapshotBoundary(
        'create',
        projectId,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }

    return newSnapshot
  },

  loadSnapshots: async (projectId: string): Promise<void> => {
    set({ isLoading: true })

    const key = PersistenceKeys.snapshots(projectId)
    const result = await persistenceApi.read<PersistedSnapshotList>(key)

    if (result.success && result.data) {
      const snapshots = result.data.snapshots.map(persistedToSnapshot)
      set({ snapshots, isLoading: false })
    } else {
      set({ snapshots: [], isLoading: false })
    }
  },
  // Story 9: rename mirrors deleteSnapshot's read-modify-write persistence —
  // optimistic local rename, then rewrite the persisted list with the new name
  // (all other fields byte-identical), rolling back if the write fails.
  // CodeRabbit hardening: the read-modify-write is serialized per project;
  // a list that cannot be READ rolls back (previously skipped the write and
  // silently kept the optimistic name); failures get durable logs.
  renameSnapshot: async (id: string, name: string): Promise<void> => {
    const { snapshots } = get()
    const snapshotToRename = snapshots.find((s) => s.id === id)
    if (!snapshotToRename) return
    const projectId = snapshotToRename.projectId

    // Update local state first (optimistic)
    set((state) => ({
      snapshots: state.snapshots.map((s) => (s.id === id ? { ...s, name } : s))
    }))

    try {
      await enqueueSnapshotMutation(projectId, async () => {
        const key = PersistenceKeys.snapshots(projectId)
        const existingResult = await persistenceApi.read<PersistedSnapshotList>(key)

        // An unreadable/missing list is an ERROR for a rename: the snapshot
        // exists locally, so the persisted copy must exist too — treating it
        // as "nothing to do" would leave the optimistic name un-persisted
        // (it reverts after reload). Roll back via the catch below.
        if (!existingResult.success || !existingResult.data) {
          const reason =
            !existingResult.success && 'error' in existingResult
              ? String(existingResult.error)
              : 'missing data'
          throw new Error(`snapshot list unreadable for rename: ${reason}`)
        }

        const updatedList: PersistedSnapshotList = {
          snapshots: existingResult.data.snapshots.map((s) => (s.id === id ? { ...s, name } : s)),
          updatedAt: new Date().toISOString()
        }
        const writeResult = await persistenceApi.write(key, updatedList)
        if (!writeResult.success) {
          throw new Error(`Failed to persist snapshot rename: ${writeResult.error}`)
        }
        logSnapshotBoundary('rename', projectId, 'ok')
      })
    } catch (error) {
      // Rollback optimistic update on any failure
      set((state) => ({
        snapshots: state.snapshots.map((s) =>
          s.id === id ? { ...s, name: snapshotToRename.name } : s
        )
      }))
      logSnapshotBoundary(
        'rename',
        projectId,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  },
  deleteSnapshot: async (id: string): Promise<void> => {
    const { snapshots } = get()
    const snapshotToDelete = snapshots.find((s) => s.id === id)
    if (!snapshotToDelete) return
    const projectId = snapshotToDelete.projectId

    // Remove from local state
    set((state) => ({
      snapshots: state.snapshots.filter((s) => s.id !== id)
    }))

    // Serialized per project so a concurrent rename cannot resurrect this
    // snapshot by rewriting a pre-delete list (CodeRabbit).
    try {
      await enqueueSnapshotMutation(projectId, async () => {
        const key = PersistenceKeys.snapshots(projectId)
        const existingResult = await persistenceApi.read<PersistedSnapshotList>(key)

        if (existingResult.success && existingResult.data) {
          const updatedList: PersistedSnapshotList = {
            snapshots: existingResult.data.snapshots.filter((s) => s.id !== id),
            updatedAt: new Date().toISOString()
          }
          const writeResult = await persistenceApi.write(key, updatedList)
          if (!writeResult.success) {
            throw new Error(`Failed to persist snapshot delete: ${writeResult.error}`)
          }
        }
        // A missing/unreadable list for delete is benign (the list is gone —
        // the delete's end state already holds); no throw, log ok.
        logSnapshotBoundary('delete', projectId, 'ok')
      })
    } catch (error) {
      logSnapshotBoundary(
        'delete',
        projectId,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
      // Keep the local removal (the list state is unknown; a reload
      // reconciles) but surface the failure.
      throw error
    }
  },

  getSnapshot: async (id: string): Promise<PersistedSnapshot | null> => {
    const { snapshots } = get()
    const snapshot = snapshots.find((s) => s.id === id)
    if (!snapshot) return null

    // Read from persistence to get full terminal data
    const key = PersistenceKeys.snapshots(snapshot.projectId)
    const result = await persistenceApi.read<PersistedSnapshotList>(key)

    if (result.success && result.data) {
      return result.data.snapshots.find((s) => s.id === id) || null
    }
    return null
  },

  clearSnapshots: (): void => {
    set({ snapshots: [], isLoading: false })
  }
}))

// Selectors for performance
export function useSnapshots(): Snapshot[] {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  return useSnapshotStore(
    useShallow((state) => state.snapshots.filter((s) => s.projectId === activeProjectId))
  )
}

export function useSnapshotActions(): Pick<
  SnapshotState,
  | 'createSnapshot'
  | 'loadSnapshots'
  | 'deleteSnapshot'
  | 'renameSnapshot'
  | 'getSnapshot'
  | 'clearSnapshots'
> {
  return useSnapshotStore(
    useShallow((state) => ({
      createSnapshot: state.createSnapshot,
      loadSnapshots: state.loadSnapshots,
      deleteSnapshot: state.deleteSnapshot,
      renameSnapshot: state.renameSnapshot,
      getSnapshot: state.getSnapshot,
      clearSnapshots: state.clearSnapshots
    }))
  )
}

export function useSnapshotLoading(): boolean {
  return useSnapshotStore((state) => state.isLoading)
}
