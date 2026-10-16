import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedSnapshotList } from '../../shared/types/persistence.types'

const { mockPersistence, mockToastWarning } = vi.hoisted(() => ({
  mockPersistence: {
    read: vi.fn(),
    write: vi.fn()
  },
  mockToastWarning: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { warning: mockToastWarning } }))

vi.mock('@/lib/api', () => ({
  persistenceApi: mockPersistence
}))

// Mock the project store
vi.mock('./project-store', () => ({
  useProjectStore: vi.fn((selector) => {
    const state = { activeProjectId: 'test-project-1' }
    return selector(state)
  })
}))

import { STORE_VALUE_MAX_BYTES, storedValueBytes } from '@/lib/persistence-trim'
import { mockPersistedTerminal } from '@/lib/test-utils/terminal'
import {
  useSnapshotActions,
  useSnapshotLoading,
  useSnapshotStore,
  useSnapshots
} from './snapshot-store'

beforeEach(() => {
  // Reset the store state before each test
  const { result } = renderHook(() => useSnapshotStore.getState())
  act(() => {
    result.current.clearSnapshots()
  })

  mockPersistence.read.mockReset()
  mockPersistence.write.mockReset()
  mockToastWarning.mockReset()
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
          [mockPersistedTerminal({ id: 'term-1', shell: 'powershell', cwd: '/home' })],
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
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })
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
      // KEY_NOT_FOUND = empty list (the intended precondition); the write
      // below is the failure under test. Operational read errors are a
      // distinct failure mode (CodeRabbit) — covered by the dedicated test.
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })
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

    it('CodeRabbit: operational read failure (not KEY_NOT_FOUND) rolls back instead of overwriting the list', async () => {
      // A read that fails for an OPERATIONAL reason (I/O error, not a
      // missing key) must not be treated as "no snapshots" — create would
      // overwrite the persisted list with only the new snapshot. The
      // mutation throws and the optimistic snapshot rolls back.
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Storage backend offline',
        code: 'READ_ERROR'
      })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: storeResult } = renderHook(() => useSnapshotStore())

      await expect(
        act(async () => {
          await actionsResult.current.createSnapshot(
            'Must Not Overwrite',
            undefined,
            'project-123',
            [],
            null
          )
        })
      ).rejects.toThrow('Failed to read persisted snapshots')

      // Rolled back AND no write attempted against the unknown list.
      expect(storeResult.current.snapshots).toHaveLength(0)
      expect(mockPersistence.write).not.toHaveBeenCalled()
    })

    it('CodeRabbit minor: malformed success without data does not overwrite the list', async () => {
      // A successful read whose data is undefined (versioned record with
      // _version but no data) must not be treated as an empty list — the
      // create must fail rather than persist a list with only the new
      // snapshot.
      mockPersistence.read.mockResolvedValue({ success: true })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      const { result: storeResult } = renderHook(() => useSnapshotStore())

      await expect(
        act(async () => {
          await actionsResult.current.createSnapshot(
            'Must Not Overwrite',
            undefined,
            'project-123',
            [],
            null
          )
        })
      ).rejects.toThrow('success reply carried no data')
      expect(storeResult.current.snapshots).toHaveLength(0)
      expect(mockPersistence.write).not.toHaveBeenCalled()
    })

    it('should persist snapshot to storage', async () => {
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useSnapshotActions())

      await act(async () => {
        await result.current.createSnapshot(
          'Persisted Snapshot',
          'desc',
          'project-456',
          [mockPersistedTerminal({ id: 't1', name: 'T1' })],
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
              terminals: [mockPersistedTerminal({ id: 't1', name: 'T1' })],
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
        await result.current.createSnapshot('New Snapshot', undefined, 'project-789', [], null)
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

    describe('host value cap', () => {
      // About 100 KB of terminal output per snapshot: two fit under the 256 KiB
      // cap, three do not.
      const output = (id: string): string[] =>
        Array.from(
          { length: 1050 },
          (_, i) => `${id} line ${String(i).padStart(5, '0')} ${'.'.repeat(80)}`
        )
      const persisted = (id: string, name = id) => ({
        id,
        projectId: 'project-cap',
        name,
        createdAt: '2026-01-01T00:00:00.000Z',
        terminals: [mockPersistedTerminal({ id: `${id}-t`, scrollback: output(id) })],
        activeTerminalId: `${id}-t`
      })
      const asSnapshot = (id: string, name = id) => ({
        id,
        projectId: 'project-cap',
        name,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        paneCount: 1,
        processCount: 0
      })

      it('keeps every snapshot but cuts the output of the oldest to fit, and tells the user', async () => {
        mockPersistence.read.mockResolvedValue({
          success: true,
          data: {
            snapshots: [persisted('e2'), persisted('e1')],
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as PersistedSnapshotList
        })
        mockPersistence.write.mockResolvedValue({ success: true })
        const { result } = renderHook(() => useSnapshotActions())
        const { result: storeResult } = renderHook(() => useSnapshotStore())

        let created: Awaited<ReturnType<typeof result.current.createSnapshot>>
        await act(async () => {
          created = await result.current.createSnapshot(
            'New',
            undefined,
            'project-cap',
            [mockPersistedTerminal({ id: 'new-t', scrollback: output('new') })],
            'new-t'
          )
        })

        const [key, written] = mockPersistence.write.mock.calls[0]
        const list = written as PersistedSnapshotList
        expect(key).toBe('snapshots/project-cap')
        expect(storedValueBytes(list)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
        expect(list.snapshots.map((snap) => snap.id)).toEqual([created!.id, 'e2', 'e1'])
        // Newest first: the newest two keep their output, the oldest lost it.
        expect(list.snapshots[0].terminals[0].scrollback).toEqual(output('new'))
        expect(list.snapshots[1].terminals[0].scrollback).toEqual(output('e2'))
        expect(list.snapshots[2].terminals[0].scrollback).toBeUndefined()
        expect(list.snapshots[2].terminals).toHaveLength(1)
        expect(mockToastWarning).toHaveBeenCalledTimes(1)
        expect(mockToastWarning.mock.calls[0][0]).toContain(
          '1 snapshot(s) lost older terminal output'
        )
        expect(storeResult.current.snapshots).toHaveLength(1)
      })

      it('writes a list that fits as it is, without a warning', async () => {
        mockPersistence.read.mockResolvedValue({
          success: true,
          data: {
            snapshots: [persisted('e1')],
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as PersistedSnapshotList
        })
        mockPersistence.write.mockResolvedValue({ success: true })
        const { result } = renderHook(() => useSnapshotActions())

        await act(async () => {
          await result.current.createSnapshot('New', undefined, 'project-cap', [], null)
        })

        const list = mockPersistence.write.mock.calls[0][1] as PersistedSnapshotList
        expect(list.snapshots[1].terminals[0].scrollback).toEqual(output('e1'))
        expect(mockToastWarning).not.toHaveBeenCalled()
      })

      it('removes the oldest snapshots from memory when only removing them makes room', async () => {
        const named = (id: string): string => `${id}-${'n'.repeat(100_000)}`
        useSnapshotStore.setState({
          snapshots: [
            asSnapshot('e1', named('e1')),
            asSnapshot('e2', named('e2')),
            asSnapshot('e3', named('e3'))
          ]
        })
        mockPersistence.read.mockResolvedValue({
          success: true,
          data: {
            snapshots: [
              { ...persisted('e1', named('e1')), terminals: [] },
              { ...persisted('e2', named('e2')), terminals: [] },
              { ...persisted('e3', named('e3')), terminals: [] }
            ],
            updatedAt: '2026-01-01T00:00:00.000Z'
          } as PersistedSnapshotList
        })
        mockPersistence.write.mockResolvedValue({ success: true })
        const { result } = renderHook(() => useSnapshotActions())
        const { result: storeResult } = renderHook(() => useSnapshotStore())

        await act(async () => {
          await result.current.createSnapshot('New', undefined, 'project-cap', [], null)
        })

        const list = mockPersistence.write.mock.calls[0][1] as PersistedSnapshotList
        expect(storedValueBytes(list)).toBeLessThanOrEqual(STORE_VALUE_MAX_BYTES)
        expect(list.snapshots.map((snap) => snap.id).slice(1)).toEqual(['e1', 'e2'])
        expect(storeResult.current.snapshots.map((snap) => snap.id).slice(1)).toEqual(['e1', 'e2'])
        expect(mockToastWarning.mock.calls[0][0]).toContain('1 oldest snapshot(s) were removed')
      })
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
            terminals: [mockPersistedTerminal({ id: 't1', name: 'T1', shell: 'zsh' })],
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
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })

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
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })
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

    it('trims a list that is already over the cap when it deletes', async () => {
      const snap = (id: string) => ({
        id,
        projectId: 'project-big',
        name: id,
        createdAt: new Date().toISOString(),
        terminals: [
          {
            id: `t-${id}`,
            name: 'T',
            shell: 'bash',
            cwd: '/',
            scrollback: Array.from({ length: 1500 }, (_, i) => `${id} ${i} ${'x'.repeat(100)}`)
          }
        ],
        activeTerminalId: null
      })
      const list = { snapshots: [snap('a'), snap('b'), snap('c')], updatedAt: 'x' }
      useSnapshotStore.setState({ snapshots: list.snapshots as never })
      mockPersistence.read.mockResolvedValue({ success: true, data: list })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result } = renderHook(() => useSnapshotActions())
      await act(async () => {
        await result.current.deleteSnapshot('c')
      })

      const written = mockPersistence.write.mock.calls.at(-1)?.[1] as typeof list
      expect(JSON.stringify({ _version: 1, data: written }).length).toBeLessThanOrEqual(256 * 1024)
      expect(written.snapshots.some((s) => s.id === 'c')).toBe(false)
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

  describe('renameSnapshot', () => {
    const buildSnapshot = (id: string, name: string) => ({
      id,
      projectId: 'project-rename',
      name,
      description: 'keep me',
      createdAt: '2026-01-01T00:00:00.000Z',
      terminals: [mockPersistedTerminal({ id: 't1', name: 'T1', scrollback: ['keep'] })],
      activeTerminalId: 't1',
      tag: 'base' as const
    })

    it('renames in local state optimistically and persists via read-modify-write', async () => {
      const snap = buildSnapshot('snap-rename-1', 'Old Name')
      mockPersistence.read.mockResolvedValue({
        success: true,
        data: { snapshots: [snap], updatedAt: snap.createdAt } as PersistedSnapshotList
      })
      mockPersistence.write.mockResolvedValue({ success: true })

      // Seed local state through the public load path.
      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      await act(async () => {
        await actionsResult.current.loadSnapshots('project-rename')
      })

      await act(async () => {
        await actionsResult.current.renameSnapshot('snap-rename-1', 'New Name')
      })

      const { result: storeResult } = renderHook(() => useSnapshotStore())
      expect(storeResult.current.snapshots[0].name).toBe('New Name')

      // Read-modify-write: same key, list rewritten with the renamed entry,
      // every other field byte-identical.
      expect(mockPersistence.read).toHaveBeenCalledWith('snapshots/project-rename')
      expect(mockPersistence.write).toHaveBeenCalledWith(
        'snapshots/project-rename',
        expect.objectContaining({
          snapshots: [expect.objectContaining({ id: 'snap-rename-1', name: 'New Name' })],
          updatedAt: expect.any(String)
        })
      )
      const written = mockPersistence.write.mock.calls[0]?.[1] as PersistedSnapshotList
      expect(written.snapshots[0]).toEqual({ ...snap, name: 'New Name' })
    })

    it('keeps other snapshots untouched in the persisted list', async () => {
      const snap = buildSnapshot('snap-a', 'A')
      const other = buildSnapshot('snap-b', 'B')
      mockPersistence.read.mockResolvedValue({
        success: true,
        data: { snapshots: [snap, other], updatedAt: snap.createdAt } as PersistedSnapshotList
      })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      await act(async () => {
        await actionsResult.current.loadSnapshots('project-rename')
      })
      await act(async () => {
        await actionsResult.current.renameSnapshot('snap-a', 'A2')
      })

      const written = mockPersistence.write.mock.calls.at(-1)?.[1] as PersistedSnapshotList
      expect(written.snapshots).toHaveLength(2)
      expect(written.snapshots[1]).toEqual(other)
      expect(written.snapshots[0]).toEqual({ ...snap, name: 'A2' })
    })

    it('rolls back the optimistic rename and throws when the write fails', async () => {
      const snap = buildSnapshot('snap-fail', 'Original')
      mockPersistence.read.mockResolvedValue({
        success: true,
        data: { snapshots: [snap], updatedAt: snap.createdAt } as PersistedSnapshotList
      })
      mockPersistence.write.mockResolvedValue({ success: false, error: 'Disk full' })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())
      await act(async () => {
        await actionsResult.current.loadSnapshots('project-rename')
      })

      await expect(
        act(async () => {
          await actionsResult.current.renameSnapshot('snap-fail', 'Doomed Name')
        })
      ).rejects.toThrow('Failed to persist snapshot rename: Disk full')

      const { result: storeResult } = renderHook(() => useSnapshotStore())
      expect(storeResult.current.snapshots[0].name).toBe('Original')
    })

    it('does nothing when the snapshot does not exist', async () => {
      const { result: actionsResult } = renderHook(() => useSnapshotActions())

      await act(async () => {
        await actionsResult.current.renameSnapshot('nonexistent', 'Whatever')
      })

      expect(mockPersistence.read).not.toHaveBeenCalled()
      expect(mockPersistence.write).not.toHaveBeenCalled()
    })
  })

  describe('useSnapshots selector', () => {
    it('should filter snapshots by active project', async () => {
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })
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
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })
      mockPersistence.write.mockResolvedValue({ success: true })

      const { result: actionsResult } = renderHook(() => useSnapshotActions())

      // Create a snapshot first
      let snapshotId: string
      await act(async () => {
        const snapshot = await actionsResult.current.createSnapshot(
          'Test Snapshot',
          'Description',
          'project-get',
          [mockPersistedTerminal({ id: 't1', cwd: '/home' })],
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
              terminals: [mockPersistedTerminal({ id: 't1', cwd: '/home' })],
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
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })
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
      mockPersistence.read.mockResolvedValue({
        success: false,
        error: 'Key not found',
        code: 'KEY_NOT_FOUND'
      })

      let fullSnapshot: Awaited<ReturnType<typeof actionsResult.current.getSnapshot>> = null
      await act(async () => {
        fullSnapshot = await actionsResult.current.getSnapshot(snapshotId!)
      })

      expect(fullSnapshot).toBeNull()
    })
  })
})
