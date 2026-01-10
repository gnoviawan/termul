import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
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

    // Persist to storage
    try {
      const key = PersistenceKeys.snapshots(projectId)
      const existingResult = await window.api.persistence.read<PersistedSnapshotList>(key)

      const existingSnapshots: PersistedSnapshot[] =
        existingResult.success && existingResult.data ? existingResult.data.snapshots : []

      const persistedSnapshot = snapshotToPersisted(newSnapshot, terminals, activeTerminalId)
      const updatedList: PersistedSnapshotList = {
        snapshots: [persistedSnapshot, ...existingSnapshots],
        updatedAt: new Date().toISOString()
      }

      const writeResult = await window.api.persistence.write(key, updatedList)
      if (!writeResult.success) {
        // Rollback optimistic update on failure
        set((state) => ({
          snapshots: state.snapshots.filter((s) => s.id !== newSnapshot.id)
        }))
        throw new Error(`Failed to persist snapshot: ${writeResult.error}`)
      }
    } catch (error) {
      // Rollback optimistic update on error
      set((state) => ({
        snapshots: state.snapshots.filter((s) => s.id !== newSnapshot.id)
      }))
      throw error
    }

    return newSnapshot
  },

  loadSnapshots: async (projectId: string): Promise<void> => {
    set({ isLoading: true })

    const key = PersistenceKeys.snapshots(projectId)
    const result = await window.api.persistence.read<PersistedSnapshotList>(key)

    if (result.success && result.data) {
      const snapshots = result.data.snapshots.map(persistedToSnapshot)
      set({ snapshots, isLoading: false })
    } else {
      set({ snapshots: [], isLoading: false })
    }
  },

  deleteSnapshot: async (id: string): Promise<void> => {
    const { snapshots } = get()
    const snapshotToDelete = snapshots.find((s) => s.id === id)
    if (!snapshotToDelete) return

    // Remove from local state
    set((state) => ({
      snapshots: state.snapshots.filter((s) => s.id !== id)
    }))

    // Update persistence
    const key = PersistenceKeys.snapshots(snapshotToDelete.projectId)
    const existingResult = await window.api.persistence.read<PersistedSnapshotList>(key)

    if (existingResult.success && existingResult.data) {
      const updatedList: PersistedSnapshotList = {
        snapshots: existingResult.data.snapshots.filter((s) => s.id !== id),
        updatedAt: new Date().toISOString()
      }
      await window.api.persistence.write(key, updatedList)
    }
  },

  getSnapshot: async (id: string): Promise<PersistedSnapshot | null> => {
    const { snapshots } = get()
    const snapshot = snapshots.find((s) => s.id === id)
    if (!snapshot) return null

    // Read from persistence to get full terminal data
    const key = PersistenceKeys.snapshots(snapshot.projectId)
    const result = await window.api.persistence.read<PersistedSnapshotList>(key)

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
  'createSnapshot' | 'loadSnapshots' | 'deleteSnapshot' | 'getSnapshot' | 'clearSnapshots'
> {
  return useSnapshotStore(
    useShallow((state) => ({
      createSnapshot: state.createSnapshot,
      loadSnapshots: state.loadSnapshots,
      deleteSnapshot: state.deleteSnapshot,
      getSnapshot: state.getSnapshot,
      clearSnapshots: state.clearSnapshots
    }))
  )
}

export function useSnapshotLoading(): boolean {
  return useSnapshotStore((state) => state.isLoading)
}
