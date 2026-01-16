/**
 * Worktree Zustand Store
 *
 * Manages worktree state in the renderer process.
 * Uses Map for O(1) lookups on high-frequency status updates.
 * Subscribes to IPC events to stay in sync with main process.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type {
  WorktreeMetadata,
  WorktreeStatus,
  ArchivedWorktree,
  CreateWorktreeConfig,
  DeleteWorktreeOptions,
  WorktreeStatusFilter
} from '../src/features/worktrees/worktree.types'
import type {
  IpcResult,
  CreateWorktreeDto,
  DeleteWorktreeOptions as IpcDeleteOptions
} from '../../shared/types/ipc.types'

/**
 * Key for persisting worktree metadata
 */
const WORKTREES_STORAGE_KEY = 'worktrees'

/**
 * Cache TTL for status entries (5 minutes)
 */
const STATUS_CACHE_TTL = 5 * 60 * 1000

/**
 * Extract projectId from worktreeId
 * Format: "projectId-branchName-timestamp"
 */
function extractProjectId(worktreeId: string): string {
  const parts = worktreeId.split('-')
  return parts[0]
}

/**
 * Check if status cache entry is stale
 */
function isStatusStale(status: WorktreeStatus): boolean {
  if (!status.updatedAt) return true
  return Date.now() - status.updatedAt > STATUS_CACHE_TTL
}

/**
 * Get worktrees by projectId from Map
 */
function getWorktreesByProject(worktrees: Map<string, WorktreeMetadata>, projectId: string): WorktreeMetadata[] {
  return Array.from(worktrees.values()).filter((w) => w.projectId === projectId)
}

export interface WorktreeStore {
  // State
  worktrees: Map<string, WorktreeMetadata>
  activeWorktreeId: string | null
  statusCache: Map<string, WorktreeStatus>
  filterStatus: WorktreeStatusFilter
  isLoading: boolean
  error: string | null

  // Actions
  createWorktree: (projectId: string, config: CreateWorktreeConfig) => Promise<void>
  deleteWorktree: (worktreeId: string) => Promise<void>
  archiveWorktree: (worktreeId: string) => Promise<void>
  updateWorktreeStatus: (worktreeId: string, status: WorktreeStatus) => void
  setActiveWorktree: (worktreeId: string) => void
  loadWorktrees: (projectId: string) => Promise<void>
  clearError: () => void
  initializeEventListeners: () => () => void
}

export const useWorktreeStore = create<WorktreeStore>((set, get) => ({
  // Initial state
  worktrees: new Map(),
  activeWorktreeId: null,
  statusCache: new Map(),
  filterStatus: 'all',
  isLoading: false,
  error: null,

  // Create a new worktree
  createWorktree: async (projectId: string, config: CreateWorktreeConfig): Promise<void> => {
    set({ isLoading: true, error: null })

    try {
      const dto: CreateWorktreeDto = {
        projectId,
        branchName: config.branchName,
        gitignoreSelections: config.gitignoreSelections
      }

      const result = await window.api.worktree.create(dto)

      if (!result.success) {
        set({ error: result.error, isLoading: false })
        return
      }

      // Add to store
      set((state) => {
        const newWorktrees = new Map(state.worktrees)
        newWorktrees.set(result.data.id, result.data)
        return {
          worktrees: newWorktrees,
          isLoading: false,
          activeWorktreeId: result.data.id
        }
      })

      // Persist metadata
      const worktreesArray = Array.from(get().worktrees.values())
      await window.api.persistence.writeDebounced(WORKTREES_STORAGE_KEY, worktreesArray)
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to create worktree',
        isLoading: false
      })
    }
  },

  // Delete a worktree
  deleteWorktree: async (worktreeId: string): Promise<void> => {
    set({ isLoading: true, error: null })

    try {
      const result = await window.api.worktree.delete(worktreeId)

      if (!result.success) {
        set({ error: result.error, isLoading: false })
        return
      }

      // Remove from store
      set((state) => {
        const newWorktrees = new Map(state.worktrees)
        newWorktrees.delete(worktreeId)
        const newStatusCache = new Map(state.statusCache)
        newStatusCache.delete(worktreeId)

        // Update active worktree if needed
        let newActiveWorktreeId = state.activeWorktreeId
        if (state.activeWorktreeId === worktreeId) {
          newActiveWorktreeId = null
        }

        return {
          worktrees: newWorktrees,
          statusCache: newStatusCache,
          activeWorktreeId: newActiveWorktreeId,
          isLoading: false
        }
      })

      // Persist metadata
      const worktreesArray = Array.from(get().worktrees.values())
      await window.api.persistence.writeDebounced(WORKTREES_STORAGE_KEY, worktreesArray)
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete worktree',
        isLoading: false
      })
    }
  },

  // Archive a worktree (STUB)
  archiveWorktree: async (worktreeId: string): Promise<void> => {
    set({ isLoading: true, error: null })

    try {
      const result = await window.api.worktree.archive(worktreeId)

      if (!result.success) {
        set({ error: result.error, isLoading: false })
        return
      }

      // Mark as archived in store
      set((state) => {
        const worktree = state.worktrees.get(worktreeId)
        if (!worktree) return { isLoading: false }

        const newWorktrees = new Map(state.worktrees)
        newWorktrees.set(worktreeId, { ...worktree, isArchived: true })

        return {
          worktrees: newWorktrees,
          isLoading: false
        }
      })

      // Persist metadata
      const worktreesArray = Array.from(get().worktrees.values())
      await window.api.persistence.writeDebounced(WORKTREES_STORAGE_KEY, worktreesArray)
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to archive worktree',
        isLoading: false
      })
    }
  },

  // Update worktree status in cache
  updateWorktreeStatus: (worktreeId: string, status: WorktreeStatus): void => {
    set((state) => {
      const newStatusCache = new Map(state.statusCache)
      newStatusCache.set(worktreeId, { ...status, updatedAt: Date.now() })
      return { statusCache: newStatusCache }
    })
  },

  // Set active worktree
  setActiveWorktree: (worktreeId: string): void => {
    set({ activeWorktreeId: worktreeId })
  },

  // Load worktrees from persistence or API
  loadWorktrees: async (projectId: string): Promise<void> => {
    set({ isLoading: true, error: null })

    try {
      // Try to load from persistence first
      const persistedResult = await window.api.persistence.read<WorktreeMetadata[]>(WORKTREES_STORAGE_KEY)

      if (persistedResult.success && persistedResult.data) {
        const projectWorktrees = persistedResult.data.filter((w) => w.projectId === projectId)
        const worktreesMap = new Map(projectWorktrees.map((w) => [w.id, w]))

        set({
          worktrees: worktreesMap,
          isLoading: false
        })
      }

      // Fetch fresh data from API
      const apiResult = await window.api.worktree.list(projectId)

      if (!apiResult.success) {
        set({ error: apiResult.error, isLoading: false })
        return
      }

      const worktreesMap = new Map(apiResult.data.map((w) => [w.id, w]))

      set({
        worktrees: worktreesMap,
        isLoading: false
      })

      // Persist fresh data
      await window.api.persistence.writeDebounced(WORKTREES_STORAGE_KEY, apiResult.data)
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load worktrees',
        isLoading: false
      })
    }
  },

  // Clear error state
  clearError: (): void => {
    set({ error: null })
  },

  // Initialize IPC event listeners
  initializeEventListeners: (): (() => void) => {
    const unsubscribers: (() => void)[] = []

    // Status changed event
    unsubscribers.push(
      window.api.worktree.onStatusChanged((worktreeId, status) => {
        get().updateWorktreeStatus(worktreeId, status)
      })
    )

    // Worktree created event
    unsubscribers.push(
      window.api.worktree.onCreated((worktree) => {
        set((state) => {
          const newWorktrees = new Map(state.worktrees)
          newWorktrees.set(worktree.id, worktree)
          return { worktrees: newWorktrees }
        })
      })
    )

    // Worktree deleted event
    unsubscribers.push(
      window.api.worktree.onDeleted((worktreeId) => {
        set((state) => {
          const newWorktrees = new Map(state.worktrees)
          newWorktrees.delete(worktreeId)
          const newStatusCache = new Map(state.statusCache)
          newStatusCache.delete(worktreeId)

          let newActiveWorktreeId = state.activeWorktreeId
          if (state.activeWorktreeId === worktreeId) {
            newActiveWorktreeId = null
          }

          return {
            worktrees: newWorktrees,
            statusCache: newStatusCache,
            activeWorktreeId: newActiveWorktreeId
          }
        })
      })
    )

    // Return cleanup function
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }
}))

// Selectors for performance (selective subscriptions)
export function useWorktrees(projectId?: string): WorktreeMetadata[] {
  return useWorktreeStore(
    useShallow((state) => {
      const worktreesArray = Array.from(state.worktrees.values())
      return projectId ? getWorktreesByProject(state.worktrees, projectId) : worktreesArray
    })
  )
}

export function useActiveWorktree(): WorktreeMetadata | undefined {
  return useWorktreeStore((state) => {
    if (!state.activeWorktreeId) return undefined
    return state.worktrees.get(state.activeWorktreeId)
  })
}

export function useActiveWorktreeId(): string | null {
  return useWorktreeStore((state) => state.activeWorktreeId)
}

export function useWorktreeStatus(worktreeId: string): WorktreeStatus | undefined {
  return useWorktreeStore((state) => {
    const status = state.statusCache.get(worktreeId)
    // Return undefined if stale to trigger refetch
    if (status && isStatusStale(status)) {
      return undefined
    }
    return status
  })
}

export function useWorktreeActions(): Pick<
  WorktreeStore,
  | 'createWorktree'
  | 'deleteWorktree'
  | 'archiveWorktree'
  | 'updateWorktreeStatus'
  | 'setActiveWorktree'
  | 'loadWorktrees'
  | 'clearError'
  | 'initializeEventListeners'
> {
  return useWorktreeStore(
    useShallow((state) => ({
      createWorktree: state.createWorktree,
      deleteWorktree: state.deleteWorktree,
      archiveWorktree: state.archiveWorktree,
      updateWorktreeStatus: state.updateWorktreeStatus,
      setActiveWorktree: state.setActiveWorktree,
      loadWorktrees: state.loadWorktrees,
      clearError: state.clearError,
      initializeEventListeners: state.initializeEventListeners
    }))
  )
}

export function useWorktreeLoading(): boolean {
  return useWorktreeStore((state) => state.isLoading)
}

export function useWorktreeError(): string | null {
  return useWorktreeStore((state) => state.error)
}
