/**
 * Unit tests for Worktree Store
 *
 * Tests Zustand store state management, selectors, and IPC integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useWorktreeStore } from './worktree-store'
import type {
  WorktreeMetadata,
  WorktreeStatus,
  CreateWorktreeConfig
} from '../src/features/worktrees/worktree.types'
import type { IpcResult, CreateWorktreeDto } from '../../shared/types/ipc.types'

// Mock window.api.worktree
const mockUnsubscribe = vi.fn()

const mockWorktreeApi = {
  list: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  getStatus: vi.fn(),
  onStatusChanged: vi.fn(() => mockUnsubscribe),
  onCreated: vi.fn(() => mockUnsubscribe),
  onDeleted: vi.fn(() => mockUnsubscribe)
}

const mockPersistenceApi = {
  read: vi.fn(),
  write: vi.fn(),
  writeDebounced: vi.fn(),
  delete: vi.fn()
}

// Setup global window.api stub
beforeEach(() => {
  ;(global as any).window = {
    api: {
      worktree: mockWorktreeApi,
      persistence: mockPersistenceApi
    }
  }
})

afterEach(() => {
  delete (global as any).window
})

describe('WorktreeStore', () => {
  const mockWorktree: WorktreeMetadata = {
    id: 'project-123-feature-test-1234567890',
    projectId: 'project-123',
    branchName: 'feature/test',
    worktreePath: '/project/.termul/worktrees/feature-test',
    createdAt: '2026-01-16T00:00:00.000Z',
    lastAccessedAt: '2026-01-16T00:00:00.000Z',
    isArchived: false
  }

  const mockStatus: WorktreeStatus = {
    dirty: false,
    ahead: 0,
    behind: 0,
    conflicted: false,
    currentBranch: 'feature/test'
  }

  beforeEach(() => {
    // Reset store state
    useWorktreeStore.setState({
      worktrees: new Map(),
      activeWorktreeId: null,
      statusCache: new Map(),
      filterStatus: 'all',
      isLoading: false,
      error: null
    })

    // Clear all mocks
    vi.clearAllMocks()
  })

  describe('store initialization', () => {
    it('should initialize with empty state', () => {
      const state = useWorktreeStore.getState()

      expect(state.worktrees).toBeInstanceOf(Map)
      expect(state.worktrees.size).toBe(0)
      expect(state.activeWorktreeId).toBeNull()
      expect(state.statusCache).toBeInstanceOf(Map)
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })
  })

  describe('loadWorktrees', () => {
    it('should load worktrees from API', async () => {
      mockPersistenceApi.read.mockResolvedValue({
        success: true,
        data: []
      })
      mockWorktreeApi.list.mockResolvedValue({
        success: true,
        data: [mockWorktree]
      })

      const { loadWorktrees } = useWorktreeStore.getState()
      await loadWorktrees('project-123')

      const state = useWorktreeStore.getState()
      expect(state.worktrees.size).toBe(1)
      expect(state.worktrees.get(mockWorktree.id)).toEqual(mockWorktree)
      expect(state.isLoading).toBe(false)
    })

    it('should handle API errors', async () => {
      mockPersistenceApi.read.mockResolvedValue({
        success: true,
        data: []
      })
      mockWorktreeApi.list.mockResolvedValue({
        success: false,
        error: 'Failed to load',
        code: 'API_ERROR'
      })

      const { loadWorktrees } = useWorktreeStore.getState()
      await loadWorktrees('project-123')

      const state = useWorktreeStore.getState()
      expect(state.error).toBe('Failed to load')
      expect(state.isLoading).toBe(false)
    })
  })

  describe('createWorktree', () => {
    it('should create worktree and add to store', async () => {
      mockWorktreeApi.create.mockResolvedValue({
        success: true,
        data: mockWorktree
      })

      const config: CreateWorktreeConfig = {
        branchName: 'feature/test',
        gitignoreSelections: []
      }

      const { createWorktree } = useWorktreeStore.getState()
      await createWorktree('project-123', config)

      const state = useWorktreeStore.getState()
      expect(state.worktrees.get(mockWorktree.id)).toEqual(mockWorktree)
      expect(state.activeWorktreeId).toBe(mockWorktree.id)
      expect(state.isLoading).toBe(false)
    })

    it('should handle create errors', async () => {
      mockWorktreeApi.create.mockResolvedValue({
        success: false,
        error: 'Branch not found',
        code: 'BRANCH_NOT_FOUND'
      })

      const config: CreateWorktreeConfig = {
        branchName: 'nonexistent',
        gitignoreSelections: []
      }

      const { createWorktree } = useWorktreeStore.getState()
      await createWorktree('project-123', config)

      const state = useWorktreeStore.getState()
      expect(state.error).toBe('Branch not found')
      expect(state.isLoading).toBe(false)
    })
  })

  describe('deleteWorktree', () => {
    it('should delete worktree from store', async () => {
      // Setup: add worktree to store
      useWorktreeStore.setState({
        worktrees: new Map([[mockWorktree.id, mockWorktree]]),
        activeWorktreeId: mockWorktree.id
      })

      mockWorktreeApi.delete.mockResolvedValue({
        success: true,
        data: undefined
      })

      const { deleteWorktree } = useWorktreeStore.getState()
      await deleteWorktree(mockWorktree.id)

      const state = useWorktreeStore.getState()
      expect(state.worktrees.has(mockWorktree.id)).toBe(false)
      expect(state.activeWorktreeId).toBeNull()
      expect(state.isLoading).toBe(false)
    })

    it('should handle delete errors', async () => {
      useWorktreeStore.setState({
        worktrees: new Map([[mockWorktree.id, mockWorktree]])
      })

      mockWorktreeApi.delete.mockResolvedValue({
        success: false,
        error: 'Worktree not found',
        code: 'WORKTREE_NOT_FOUND'
      })

      const { deleteWorktree } = useWorktreeStore.getState()
      await deleteWorktree(mockWorktree.id)

      const state = useWorktreeStore.getState()
      expect(state.error).toBe('Worktree not found')
    })
  })

  describe('updateWorktreeStatus', () => {
    it('should update status cache', () => {
      const { updateWorktreeStatus } = useWorktreeStore.getState()
      updateWorktreeStatus(mockWorktree.id, mockStatus)

      const state = useWorktreeStore.getState()
      const cachedStatus = state.statusCache.get(mockWorktree.id)

      expect(cachedStatus).toBeDefined()
      expect(cachedStatus?.updatedAt).toBeDefined()
      expect(cachedStatus?.dirty).toBe(mockStatus.dirty)
    })
  })

  describe('setActiveWorktree', () => {
    it('should set active worktree', () => {
      useWorktreeStore.setState({
        worktrees: new Map([[mockWorktree.id, mockWorktree]])
      })

      const { setActiveWorktree } = useWorktreeStore.getState()
      setActiveWorktree(mockWorktree.id)

      const state = useWorktreeStore.getState()
      expect(state.activeWorktreeId).toBe(mockWorktree.id)
    })
  })

  describe('clearError', () => {
    it('should clear error state', () => {
      useWorktreeStore.setState({ error: 'Test error' })

      const { clearError } = useWorktreeStore.getState()
      clearError()

      const state = useWorktreeStore.getState()
      expect(state.error).toBeNull()
    })
  })

  describe('selectors', () => {
    it('useWorktrees should return array', () => {
      useWorktreeStore.setState({
        worktrees: new Map([[mockWorktree.id, mockWorktree]])
      })

      // Get worktrees from store directly
      const worktreesArray = Array.from(useWorktreeStore.getState().worktrees.values())

      expect(Array.isArray(worktreesArray)).toBe(true)
      expect(worktreesArray.length).toBe(1)
    })

    it('useActiveWorktree should return active worktree', () => {
      useWorktreeStore.setState({
        worktrees: new Map([[mockWorktree.id, mockWorktree]]),
        activeWorktreeId: mockWorktree.id
      })

      useWorktreeStore.getState().setActiveWorktree(mockWorktree.id)
      const activeWorktree = useWorktreeStore.getState().worktrees.get(useWorktreeStore.getState().activeWorktreeId!)

      expect(activeWorktree).toEqual(mockWorktree)
    })
  })

  describe('event listeners', () => {
    it('should initialize event listeners', () => {
      const { initializeEventListeners } = useWorktreeStore.getState()
      const cleanup = initializeEventListeners()

      expect(mockWorktreeApi.onStatusChanged).toHaveBeenCalled()
      expect(mockWorktreeApi.onCreated).toHaveBeenCalled()
      expect(mockWorktreeApi.onDeleted).toHaveBeenCalled()

      cleanup()
    })

    it('should cleanup event listeners', () => {
      const { initializeEventListeners } = useWorktreeStore.getState()
      const cleanup = initializeEventListeners()

      cleanup()

      expect(mockUnsubscribe).toHaveBeenCalledTimes(3)
    })
  })
})
