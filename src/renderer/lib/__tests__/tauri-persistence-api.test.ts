/**
 * Unit tests for tauri-persistence-api.ts
 * Tests the tauriPersistenceApi implementation using Tauri plugin-store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @tauri-apps/plugin-store BEFORE importing the module under test
vi.mock('@tauri-apps/plugin-store', () => {
  const mockData = new Map<string, unknown>()

  return {
    Store: {
      load: vi.fn(async (_path: string, _options?: { autoSave: boolean; defaults: Record<string, unknown> }) => {
        return {
          get: vi.fn(<T>(key: string) => Promise.resolve<T | null>((mockData.get(key) as T) ?? null)),
          set: vi.fn(async (key: string, value: unknown) => {
            mockData.set(key, value)
          }),
          delete: vi.fn(async (key: string) => {
            mockData.delete(key)
          }),
          save: vi.fn(async () => {
            // Mock save
          })
        }
      })
    }
  }
})

import { Store } from '@tauri-apps/plugin-store'
import { tauriPersistenceApi, createTauriPersistenceApi, _resetStoreInstanceForTesting } from '../tauri-persistence-api'

type MockStore = {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
}

const mockStoreLoad = Store.load as ReturnType<typeof vi.fn>

describe('tauriPersistenceApi', () => {
  let currentMockStore: MockStore
  let mockData: Map<string, unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    // Reset the singleton store instance
    _resetStoreInstanceForTesting()

    // Create a fresh mock store for each test
    mockData = new Map<string, unknown>()
    currentMockStore = {
      get: vi.fn(<T>(key: string) => Promise.resolve<T | null>((mockData.get(key) as T) ?? null)),
      set: vi.fn(async (key: string, value: unknown) => {
        mockData.set(key, value)
      }),
      delete: vi.fn(async (key: string) => {
        mockData.delete(key)
      }),
      save: vi.fn(async () => {})
    }

    mockStoreLoad.mockResolvedValue(currentMockStore)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  describe('read', () => {
    it('should successfully read versioned data from store', async () => {
      const testData = { name: 'Test Project', path: '/test/path' }
      const versionedData = { _version: 1, data: testData }

      currentMockStore.get.mockResolvedValue(versionedData)

      const result = await tauriPersistenceApi.read('test-key')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(testData)
      }
    })

    it('should successfully read legacy data without version', async () => {
      const testData = { name: 'Legacy Project' }

      currentMockStore.get.mockResolvedValue(testData)

      const result = await tauriPersistenceApi.read('legacy-key')

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(testData)
      }
    })

    it('should return KEY_NOT_FOUND when key does not exist', async () => {
      currentMockStore.get.mockResolvedValue(null)

      const result = await tauriPersistenceApi.read('non-existent-key')

      expect(result).toEqual({
        success: false,
        error: 'Key not found: non-existent-key',
        code: 'KEY_NOT_FOUND'
      })
    })

    it('should handle errors when reading from store', async () => {
      currentMockStore.get.mockRejectedValue(new Error('Read failed'))

      const result = await tauriPersistenceApi.read('test-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('READ_ERROR')
      }
    })

    it('should handle undefined values', async () => {
      currentMockStore.get.mockResolvedValue(undefined)

      const result = await tauriPersistenceApi.read('test-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('KEY_NOT_FOUND')
      }
    })
  })

  describe('write', () => {
    it('should successfully write data with version to store', async () => {
      const testData = { name: 'Test Project', path: '/test/path' }

      currentMockStore.get.mockResolvedValue(null)

      const result = await tauriPersistenceApi.write('test-key', testData)

      expect(result.success).toBe(true)
      expect(currentMockStore.set).toHaveBeenCalledWith('test-key', {
        _version: 1,
        data: testData
      })
      expect(currentMockStore.save).toHaveBeenCalled()
    })

    it('should handle errors when writing to store', async () => {
      currentMockStore.set.mockRejectedValue(new Error('Write failed'))

      const result = await tauriPersistenceApi.write('test-key', { data: 'test' })

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('WRITE_ERROR')
      }
    })

    it('should handle complex nested data structures', async () => {
      const complexData = {
        nested: {
          array: [1, 2, 3],
          object: { key: 'value' }
        },
        primitives: ['string', 42, true, null]
      }

      currentMockStore.get.mockResolvedValue(null)

      const result = await tauriPersistenceApi.write('complex-key', complexData)

      expect(result.success).toBe(true)
      expect(currentMockStore.set).toHaveBeenCalledWith('complex-key', {
        _version: 1,
        data: complexData
      })
    })
  })

  describe('writeDebounced', () => {
    it('should debounce write operations', async () => {
      const testData = { value: 'test' }

      tauriPersistenceApi.writeDebounced('debounce-key', testData)

      // Should not call write immediately
      expect(currentMockStore.set).not.toHaveBeenCalled()

      // Fast-forward past debounce time
      await vi.advanceTimersByTimeAsync(500)

      // Now write should have been called
      expect(currentMockStore.set).toHaveBeenCalled()
    })

    it('should allow different keys to be debounced independently', async () => {
      const data1 = { value: 'test1' }
      const data2 = { value: 'test2' }

      tauriPersistenceApi.writeDebounced('key1', data1)
      tauriPersistenceApi.writeDebounced('key2', data2)

      await vi.advanceTimersByTimeAsync(500)

      expect(currentMockStore.set).toHaveBeenCalledTimes(2)
    })

    it('should cancel previous debounce for same key', async () => {
      const data1 = { value: 'test1' }
      const data2 = { value: 'test2' }

      tauriPersistenceApi.writeDebounced('same-key', data1)

      // Call again before debounce completes
      tauriPersistenceApi.writeDebounced('same-key', data2)

      await vi.advanceTimersByTimeAsync(500)

      // Should only call once with latest data
      expect(currentMockStore.set).toHaveBeenCalledTimes(1)
      expect(currentMockStore.set).toHaveBeenCalledWith('same-key', {
        _version: 1,
        data: data2
      })
    })
  })

  describe('delete/remove', () => {
    it('should successfully delete data from store', async () => {
      const result = await tauriPersistenceApi.delete('test-key')

      expect(result.success).toBe(true)
      expect(currentMockStore.delete).toHaveBeenCalledWith('test-key')
      expect(currentMockStore.save).toHaveBeenCalled()
    })

    it('should handle errors when deleting from store', async () => {
      currentMockStore.delete.mockRejectedValue(new Error('Delete failed'))

      const result = await tauriPersistenceApi.delete('test-key')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('DELETE_ERROR')
      }
    })

    it('should have alias "remove" that works the same as "delete"', async () => {
      const deleteResult = await tauriPersistenceApi.delete('test-key')
      currentMockStore.delete.mockClear()

      const removeResult = await tauriPersistenceApi.remove('test-key')

      expect(deleteResult.success).toBe(removeResult.success)
    })

    it('should handle deleting non-existent keys', async () => {
      // Deleting non-existent key should still succeed (idempotent)
      const result = await tauriPersistenceApi.delete('non-existent-key')

      expect(result.success).toBe(true)
    })
  })

  describe('flushPendingWrites', () => {
    it('should flush all pending debounced writes', async () => {
      const testData = { value: 'test' }

      // Start a debounced write
      tauriPersistenceApi.writeDebounced('flush-key', testData)

      // Flush before debounce completes
      await tauriPersistenceApi.flushPendingWrites()

      // Should clear pending writes and call save
      expect(currentMockStore.save).toHaveBeenCalled()
    })
  })

  describe('interface consistency', () => {
    it('should maintain consistent IpcResult<T> pattern for all methods', async () => {
      const testKey = 'consistency-key'
      const testData = { value: 'test' }

      // read returns IpcResult<T>
      const readResult = await tauriPersistenceApi.read<typeof testData>(testKey)
      expect(typeof readResult.success).toBe('boolean')
      if (readResult.success) {
        expect(readResult.data).toBeDefined()
      } else {
        expect(readResult.error).toBeDefined()
        expect(readResult.code).toBeDefined()
      }

      // write returns IpcResult<void>
      const writeResult = await tauriPersistenceApi.write(testKey, testData)
      expect(typeof writeResult.success).toBe('boolean')

      // delete returns IpcResult<void>
      const deleteResult = await tauriPersistenceApi.delete(testKey)
      expect(typeof deleteResult.success).toBe('boolean')
    })
  })

  describe('createTauriPersistenceApi factory', () => {
    it('should return the singleton instance', () => {
      const api = createTauriPersistenceApi()

      expect(api).toBe(tauriPersistenceApi)
    })
  })
})
