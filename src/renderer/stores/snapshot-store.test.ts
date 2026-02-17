import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  useSnapshotStore,
  useSnapshots,
  useSnapshotActions,
  useSnapshotLoading
} from './snapshot-store'
import type { PersistedSnapshotList } from '../../shared/types/persistence.types'

// Mock window.api.persistence
const mockPersistence = {
  read: vi.fn(),
  write: vi.fn()
}

// Mock the project store
vi.mock('./project-store', () => ({
  useProjectStore: vi.fn((selector) => {
    const state = { activeProjectId: 'test-project-1' }
    return selector(state)
  })
}))

beforeEach(() => {
  // Reset the store state before each test
  const { result } = renderHook(() => useSnapshotStore.getState())
  act(() => {
    result.current.clearSnapshots()
  })

  // Setup window.api mock
  ;(window as unknown as { api: { persistence: typeof mockPersistence } }).api = {
    persistence: mockPersistence
  }

  // Reset mocks
  vi.clearAllMocks()
})

describe('snapshot-store', () => {
  describe('useSnapshotStore', () => {
    it('should initialize with empty snapshots and loading false', () => {
      const { result } = renderHook(() => useSnapshotStore())
      expect(result.current.snapshots).toEqual([])
      expect(result.current.isLoading).toBe(false)
    })

    it('should clear snapshots', () => {
      const { result } = renderHook(() => useSnapshotStore())

      act(() => {
        result.current.clearSnapshots()
      })

      expect(result.current.snapshots).toEqual([])
      expect(result.current.isLoading).toBe(false)
    })
  })

  describe('createSnapshot', () => {
    it('should create a snapshot with correct structure', async () => {
      mockPersistence.read.mockResolvedValue({
        success: true,
        data: { snapshots: [], updatedAt: new Date().toISOString() }
      })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useSnapshotActions())

      let snapshot: Awaited<ReturnType<typeof result.current.createSnapshot>>

      await act(async () => {
        snapshot = await result.current.createSnapshot(
          'Test Snapshot',
          'A test description',
          'project-123',
          [
            { id: 'term-1', name: 'Terminal 1', shell: 'powershell', cwd: '/home' }
          ],
          'term-1'
        )
      })

      expect(snapshot!).toBeDefined()
      expect(snapshot!.name).toBe('Test Snapshot')
      expect(snapshot!.description).toBe('A test description')
      expect(snapshot!.projectId).toBe('project-123')
      expect(snapshot!.paneCount).toBe(1)
      expect(snapshot!.createdAt).toBeInstanceOf(Date)
      expect(snapshot!.id).toMatch(/^\d+-[a-z0-9]+$/)
    })

    it('should add snapshot to local state optimistically', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: storeResult } = renderHook(() => useSnapshotStore())

      await act(async () => {
        await actionsResult.current.createSnapshot(
          'Optimistic Snapshot',
          undefined,
          'project-123',
          [],
          null
        )
      })

      expect(storeResult.current.snapshots).toHaveLength(1)
      expect(storeResult.current.snapshots[0].name).toBe('Optimistic Snapshot')
    })

    it('should rollback on persistence failure', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })
      mockPersistence.write.mockResolvedValue({
        success: false,
        error: 'Disk full'
      })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: storeResult } = renderHook(() => useSnapshotStore())

      await expect(
        act(async () => {
          await actionsResult.current.createSnapshot(
            'Failed Snapshot',
            undefined,
            'project-123',
            [],
            null
          )
        })
      ).rejects.toThrow('Failed to persist snapshot: Disk full')

      // Snapshot should be rolled back
      expect(storeResult.current.snapshots).toHaveLength(0)
    })

    it('should persist snapshot to storage', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useSnapshotActions())

      await act(async () => {
        await result.current.createSnapshot(
          'Persisted Snapshot',
          'desc',
          'project-456',
          [{ id: 't1', name: 'T1', shell: 'bash' }],
          't1'
        )
      })

      expect(mockPersistence.write).toHaveBeenCalledTimes(1)
      expect(mockPersistence.write).toHaveBeenCalledWith(
        'snapshots/project-456',
        expect.objectContaining({
          snapshots: expect.arrayContaining([
            expect.objectContaining({
              name: 'Persisted Snapshot',
              description: 'desc',
              projectId: 'project-456',
              terminals: [{ id: 't1', name: 'T1', shell: 'bash' }],
              activeTerminalId: 't1'
            })
          ]),
          updatedAt: expect.any(String)
        })
      )
    })

    it('should append to existing snapshots', async () => {
      const existingSnapshot = {
        id: 'existing-1',
        projectId: 'project-789',
        name: 'Existing',
        createdAt: '2026-01-01T00:00:00.000Z',
        terminals: [],
        activeTerminalId: null
      }

      mockPersistence.read.mockResolvedValue({
        success: true,
        data: {
          snapshots: [existingSnapshot],
          updatedAt: '2026-01-01T00:00:00.000Z'
        } as PersistedSnapshotList
      })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useSnapshotActions())

      await act(async () => {
        await result.current.createSnapshot(
          'New Snapshot',
          undefined,
          'project-789',
          [],
          null
        )
      })

      expect(mockPersistence.write).toHaveBeenCalledWith(
        'snapshots/project-789',
        expect.objectContaining({
          snapshots: expect.arrayContaining([
            expect.objectContaining({ name: 'New Snapshot' }),
            expect.objectContaining({ name: 'Existing' })
          ])
        })
      )
    })
  })

  describe('loadSnapshots', () => {
    it('should set isLoading to true during load', async () => {
      let resolvePromise: (value: unknown) => void
      const slowRead = new Promise((resolve) => {
        resolvePromise = resolve
      })
      mockPersistence.read.mockReturnValue(slowRead)

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: loadingResult } = renderHook(() => useSnapshotLoading())

      // Start loading
      let loadPromise: Promise<void>
      act(() => {
        loadPromise = actionsResult.current.loadSnapshots('project-1')
      })

      expect(loadingResult.current).toBe(true)

      // Resolve and complete
      await act(async () => {
        resolvePromise!({ success: false })
        await loadPromise
      })

      expect(loadingResult.current).toBe(false)
    })

    it('should populate snapshots from persistence', async () => {
      const persistedData: PersistedSnapshotList = {
        snapshots: [
          {
            id: 'snap-1',
            projectId: 'project-1',
            name: 'Loaded Snapshot',
            createdAt: '2026-01-10T12:00:00.000Z',
            terminals: [{ id: 't1', name: 'T1', shell: 'zsh' }],
            activeTerminalId: 't1',
            tag: 'stable'
          }
        ],
        updatedAt: '2026-01-10T12:00:00.000Z'
      }

      mockPersistence.read.mockResolvedValue({
        success: true,
        data: persistedData
      })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: storeResult } = renderHook(() => useSnapshotStore())

      await act(async () => {
        await actionsResult.current.loadSnapshots('project-1')
      })

      expect(storeResult.current.snapshots).toHaveLength(1)
      expect(storeResult.current.snapshots[0].name).toBe('Loaded Snapshot')
      expect(storeResult.current.snapshots[0].paneCount).toBe(1)
      expect(storeResult.current.snapshots[0].tag).toBe('stable')
      expect(storeResult.current.snapshots[0].createdAt).toBeInstanceOf(Date)
    })

    it('should clear snapshots when no data exists', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: storeResult } = renderHook(() => useSnapshotStore())

      await act(async () => {
        await actionsResult.current.loadSnapshots('empty-project')
      })

      expect(storeResult.current.snapshots).toEqual([])
    })
  })

  describe('deleteSnapshot', () => {
    it('should remove snapshot from local state', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: storeResult } = renderHook(() => useSnapshotStore())

      // Create a snapshot first
      let snapshotId: string
      await act(async () => {
        const snapshot = await actionsResult.current.createSnapshot(
          'To Delete',
          undefined,
          'project-del',
          [],
          null
        )
        snapshotId = snapshot.id
      })

      expect(storeResult.current.snapshots).toHaveLength(1)

      // Mock read for delete operation
      mockPersistence.read.mockResolvedValue({
        success: true,
        data: {
          snapshots: [
            {
              id: snapshotId!,
              projectId: 'project-del',
              name: 'To Delete',
              createdAt: new Date().toISOString(),
              terminals: [],
              activeTerminalId: null
            }
          ],
          updatedAt: new Date().toISOString()
        }
      })

      // Delete it
      await act(async () => {
        await actionsResult.current.deleteSnapshot(snapshotId!)
      })

      expect(storeResult.current.snapshots).toHaveLength(0)
    })

    it('should do nothing if snapshot not found', async () => {
      const { result } = renderHook(() => useSnapshotActions())

      // Should not throw
      await act(async () => {
        await result.current.deleteSnapshot('non-existent-id')
      })

      expect(mockPersistence.read).not.toHaveBeenCalled()
    })
  })

  describe('useSnapshots selector', () => {
    it('should filter snapshots by active project', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())

      // Create snapshots for different projects
      await act(async () => {
        await actionsResult.current.createSnapshot(
          'Project 1 Snap',
          undefined,
          'test-project-1',
          [],
          null
        )
        await actionsResult.current.createSnapshot(
          'Other Project Snap',
          undefined,
          'other-project',
          [],
          null
        )
      })

      // useSnapshots filters by activeProjectId which is mocked to 'test-project-1'
      const { result: filteredResult } = renderHook(() => useSnapshots())

      expect(filteredResult.current).toHaveLength(1)
      expect(filteredResult.current[0].name).toBe('Project 1 Snap')
    })
  })

  describe('getSnapshot', () => {
    it('should return full snapshot data from persistence', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())

      // Create a snapshot first
      let snapshotId: string
      await act(async () => {
        const snapshot = await actionsResult.current.createSnapshot(
          'Test Snapshot',
          'Description',
          'project-get',
          [{ id: 't1', name: 'Terminal 1', shell: 'bash', cwd: '/home' }],
          't1'
        )
        snapshotId = snapshot.id
      })

      // Mock persistence for getSnapshot
      mockPersistence.read.mockResolvedValue({
        success: true,
        data: {
          snapshots: [
            {
              id: snapshotId!,
              projectId: 'project-get',
              name: 'Test Snapshot',
              description: 'Description',
              createdAt: new Date().toISOString(),
              terminals: [{ id: 't1', name: 'Terminal 1', shell: 'bash', cwd: '/home' }],
              activeTerminalId: 't1'
            }
          ],
          updatedAt: new Date().toISOString()
        }
      })

      // Get the full snapshot
      let fullSnapshot: Awaited<ReturnType<typeof actionsResult.current.getSnapshot>> = null
      await act(async () => {
        fullSnapshot = await actionsResult.current.getSnapshot(snapshotId!)
      })

      expect(fullSnapshot).not.toBeNull()
      expect(fullSnapshot!.name).toBe('Test Snapshot')
      expect(fullSnapshot!.terminals).toHaveLength(1)
      expect(fullSnapshot!.terminals[0].cwd).toBe('/home')
      expect(fullSnapshot!.activeTerminalId).toBe('t1')
    })

    it('should return null if snapshot not found in store', async () => {
      const { result } = renderHook(() => useSnapshotActions())

      let fullSnapshot: Awaited<ReturnType<typeof result.current.getSnapshot>> = null
      await act(async () => {
        fullSnapshot = await result.current.getSnapshot('non-existent-id')
      })

      expect(fullSnapshot).toBeNull()
    })

    it('should return null if snapshot not found in persistence', async () => {
      mockPersistence.read.mockResolvedValue({ success: false })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())

      // Create a snapshot first
      let snapshotId: string
      await act(async () => {
        const snapshot = await actionsResult.current.createSnapshot(
          'Missing Snapshot',
          undefined,
          'project-missing',
          [],
          null
        )
        snapshotId = snapshot.id
      })

      // Mock persistence to return empty
      mockPersistence.read.mockResolvedValue({ success: false })

      let fullSnapshot: Awaited<ReturnType<typeof actionsResult.current.getSnapshot>> = null
      await act(async () => {
        fullSnapshot = await actionsResult.current.getSnapshot(snapshotId!)
      })

      expect(fullSnapshot).toBeNull()
    })
  })
})
