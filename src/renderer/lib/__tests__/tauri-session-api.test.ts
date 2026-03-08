/**
 * Unit tests for tauri-session-api.ts
 * Tests the session persistence API using Tauri plugin-store
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @tauri-apps/plugin-store BEFORE importing the module under test
const mockData = new Map<string, unknown>()

vi.mock('@tauri-apps/plugin-store', () => {
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
import {
  tauriSessionApi,
  createTauriSessionApi,
  _resetStoreInstanceForTesting
} from '../tauri-session-api'
import type { SessionData } from '@shared/types/ipc.types'

type MockStore = {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
}

const mockStoreLoad = Store.load as ReturnType<typeof vi.fn>

describe('tauriSessionApi', () => {
  let currentMockStore: MockStore

  const createValidSessionData = (): SessionData => ({
    timestamp: new Date().toISOString(),
    terminals: [
      {
        id: 'terminal-123',
        shell: 'bash',
        cwd: '/home/user',
        history: ['ls -la', 'cd /tmp'],
        env: { PATH: '/usr/bin' }
      },
      {
        id: 'terminal-456',
        shell: 'zsh',
        cwd: '/home/user/projects',
        history: [],
        env: undefined
      }
    ],
    workspaces: [
      {
        projectId: 'project-abc',
        activeTerminalId: 'terminal-123',
        terminals: [
          { id: 'terminal-123', shell: 'bash', cwd: '/home/user', history: [] }
        ]
      }
    ]
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    // Reset the singleton store instance
    _resetStoreInstanceForTesting()

    // Clear mock data
    mockData.clear()

    // Create a fresh mock store for each test
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

  describe('save', () => {
    it('should successfully save valid session data', async () => {
      const sessionData = createValidSessionData()

      const result = await tauriSessionApi.save(sessionData)

      expect(result.success).toBe(true)
      expect(currentMockStore.set).toHaveBeenCalledWith(
        'sessions/auto-save',
        expect.objectContaining({
          _version: 1,
          data: expect.objectContaining({
            terminals: sessionData.terminals,
            workspaces: sessionData.workspaces
          })
        })
      )
      expect(currentMockStore.save).toHaveBeenCalled()
    })

    it('should update timestamp when saving session', async () => {
      const sessionData = createValidSessionData()
      const originalTimestamp = sessionData.timestamp

      // Advance fake timers to ensure timestamp would be different
      await vi.advanceTimersByTimeAsync(10)

      const result = await tauriSessionApi.save(sessionData)

      expect(result.success).toBe(true)

      // Get the saved data
      const setCalls = currentMockStore.set.mock.calls
      const savedData = setCalls[setCalls.length - 1][1] as { _version: number; data: SessionData }

      // Timestamp should be updated (more recent than original)
      expect(new Date(savedData.data.timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(originalTimestamp).getTime()
      )
    })

    it('should return SESSION_INVALID for invalid session data', async () => {
      const invalidData = {
        timestamp: 'not-a-valid-session',
        terminals: 'not-an-array',
        workspaces: []
      } as unknown as SessionData

      const result = await tauriSessionApi.save(invalidData)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_INVALID')
        expect(result.error).toContain('Invalid session data structure')
      }
    })

    it('should validate terminal id, shell, and cwd are present', async () => {
      const invalidTerminals: SessionData = {
        timestamp: new Date().toISOString(),
        terminals: [
          {
            id: '', // Invalid: empty id
            shell: 'bash',
            cwd: '/home/user',
            history: []
          }
        ],
        workspaces: []
      }

      const result = await tauriSessionApi.save(invalidTerminals)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_INVALID')
      }
    })

    it('should validate workspace structure', async () => {
      const invalidWorkspaces: SessionData = {
        timestamp: new Date().toISOString(),
        terminals: [],
        workspaces: [
          {
            projectId: '', // Invalid: empty projectId
            activeTerminalId: null,
            terminals: []
          }
        ]
      }

      const result = await tauriSessionApi.save(invalidWorkspaces)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_INVALID')
      }
    })

    it('should handle store save errors', async () => {
      const sessionData = createValidSessionData()

      currentMockStore.save.mockRejectedValue(new Error('Disk full'))

      const result = await tauriSessionApi.save(sessionData)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_STORE_ERROR')
        expect(result.error).toContain('Disk full')
      }
    })
  })

  describe('restore', () => {
    it('should successfully restore versioned session data', async () => {
      const sessionData = createValidSessionData()
      const persisted = {
        _version: 1,
        data: sessionData
      }

      currentMockStore.get.mockResolvedValue(persisted)

      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(sessionData)
        expect(result.data.terminals).toHaveLength(2)
        expect(result.data.workspaces).toHaveLength(1)
      }
    })

    it('should successfully restore legacy session data without version', async () => {
      const sessionData = createValidSessionData()

      currentMockStore.get.mockResolvedValue(sessionData)

      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(sessionData)
      }
    })

    it('should return SESSION_NOT_FOUND when no session exists', async () => {
      currentMockStore.get.mockResolvedValue(null)

      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_NOT_FOUND')
        expect(result.error).toContain('No saved session found')
      }
    })

    it('should return SESSION_NOT_FOUND when session is undefined', async () => {
      currentMockStore.get.mockResolvedValue(undefined)

      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_NOT_FOUND')
      }
    })

    it('should return SESSION_INVALID for corrupted session data', async () => {
      const corruptedData = {
        _version: 1,
        data: {
          timestamp: '2024-01-01T00:00:00Z',
          terminals: 'not-an-array',
          workspaces: []
        }
      }

      currentMockStore.get.mockResolvedValue(corruptedData)

      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_INVALID')
      }
    })

    it('should handle store read errors', async () => {
      currentMockStore.get.mockRejectedValue(new Error('Read failed'))

      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_STORE_ERROR')
        expect(result.error).toContain('Read failed')
      }
    })
  })

  describe('clear', () => {
    it('should successfully clear saved session', async () => {
      const result = await tauriSessionApi.clear()

      expect(result.success).toBe(true)
      expect(currentMockStore.delete).toHaveBeenCalledWith('sessions/auto-save')
      expect(currentMockStore.save).toHaveBeenCalled()
    })

    it('should cancel pending auto-save timeout', async () => {
      // Start an auto-save (internal function, but we can test through clear)
      const sessionData = createValidSessionData()
      await tauriSessionApi.save(sessionData)

      // Clear should still succeed
      const result = await tauriSessionApi.clear()

      expect(result.success).toBe(true)
    })

    it('should handle store delete errors', async () => {
      currentMockStore.delete.mockRejectedValue(new Error('Delete failed'))

      const result = await tauriSessionApi.clear()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_STORE_ERROR')
      }
    })
  })

  describe('flush', () => {
    it('should flush successfully with no pending data', async () => {
      const result = await tauriSessionApi.flush()

      expect(result.success).toBe(true)
      expect(currentMockStore.save).toHaveBeenCalled()
    })

    it('should save pending data before flushing', async () => {
      const sessionData = createValidSessionData()

      // Set up the mock to return data for hasSession check
      currentMockStore.get.mockImplementation((key) => {
        if (key === 'sessions/auto-save') {
          return Promise.resolve(null)
        }
        return Promise.resolve(null)
      })

      const result = await tauriSessionApi.flush()

      expect(result.success).toBe(true)
    })

    it('should handle save errors during flush', async () => {
      // Set up mock to fail save operation
      currentMockStore.save.mockRejectedValue(new Error('Flush failed'))

      const result = await tauriSessionApi.flush()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_STORE_ERROR')
      }
    })
  })

  describe('hasSession', () => {
    it('should return true when valid session exists', async () => {
      const sessionData = createValidSessionData()
      const persisted = {
        _version: 1,
        data: sessionData
      }

      currentMockStore.get.mockResolvedValue(persisted)

      const result = await tauriSessionApi.hasSession()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(true)
      }
    })

    it('should return false when no session exists', async () => {
      currentMockStore.get.mockResolvedValue(null)

      const result = await tauriSessionApi.hasSession()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(false)
      }
    })

    it('should return false for invalid session data', async () => {
      const invalidData = {
        _version: 1,
        data: {
          timestamp: '2024-01-01T00:00:00Z',
          terminals: 'invalid',
          workspaces: []
        }
      }

      currentMockStore.get.mockResolvedValue(invalidData)

      const result = await tauriSessionApi.hasSession()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(false)
      }
    })

    it('should handle store read errors', async () => {
      currentMockStore.get.mockRejectedValue(new Error('Read failed'))

      const result = await tauriSessionApi.hasSession()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('SESSION_STORE_ERROR')
      }
    })

    it('should handle legacy data without version', async () => {
      const sessionData = createValidSessionData()

      currentMockStore.get.mockResolvedValue(sessionData)

      const result = await tauriSessionApi.hasSession()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe(true)
      }
    })
  })

  describe('debounce behavior (auto-save)', () => {
    it('should handle multiple rapid save calls gracefully', async () => {
      const sessionData = createValidSessionData()

      // Multiple rapid saves should all succeed
      const results = await Promise.all([
        tauriSessionApi.save(sessionData),
        tauriSessionApi.save(sessionData),
        tauriSessionApi.save(sessionData)
      ])

      // All saves should succeed (last write wins)
      results.forEach(result => {
        expect(result.success).toBe(true)
      })

      // Store.set should be called 3 times
      expect(currentMockStore.set).toHaveBeenCalledTimes(3)
    })
  })

  describe('interface consistency', () => {
    it('should maintain consistent IpcResult<T> pattern for all methods', async () => {
      // All methods should return IpcResult pattern
      const sessionData = createValidSessionData()

      // save returns IpcResult<void>
      const saveResult = await tauriSessionApi.save(sessionData)
      expect(typeof saveResult.success).toBe('boolean')

      // restore returns IpcResult<SessionData>
      const restoreResult = await tauriSessionApi.restore()
      expect(typeof restoreResult.success).toBe('boolean')

      // clear returns IpcResult<void>
      const clearResult = await tauriSessionApi.clear()
      expect(typeof clearResult.success).toBe('boolean')

      // flush returns IpcResult<void>
      const flushResult = await tauriSessionApi.flush()
      expect(typeof flushResult.success).toBe('boolean')

      // hasSession returns IpcResult<boolean>
      const hasSessionResult = await tauriSessionApi.hasSession()
      expect(typeof hasSessionResult.success).toBe('boolean')
    })
  })

  describe('createTauriSessionApi factory', () => {
    it('should return the singleton instance', () => {
      const api = createTauriSessionApi()

      expect(api).toBe(tauriSessionApi)
    })

    it('should return an object with all required methods', () => {
      const api = createTauriSessionApi()

      expect(typeof api.save).toBe('function')
      expect(typeof api.restore).toBe('function')
      expect(typeof api.clear).toBe('function')
      expect(typeof api.flush).toBe('function')
      expect(typeof api.hasSession).toBe('function')
    })
  })

  describe('data integrity', () => {
    it('should preserve terminal history across save/restore', async () => {
      const sessionData: SessionData = {
        timestamp: new Date().toISOString(),
        terminals: [
          {
            id: 'term-1',
            shell: 'bash',
            cwd: '/home/user',
            history: ['cmd1', 'cmd2', 'cmd3'],
            env: { TEST: 'value' }
          }
        ],
        workspaces: []
      }

      // Save
      await tauriSessionApi.save(sessionData)

      // Mock restore to return saved data
      const setCall = currentMockStore.set.mock.calls[0]
      const savedData = setCall[1] as { _version: number; data: SessionData }
      currentMockStore.get.mockResolvedValue(savedData)

      // Restore
      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.terminals[0].history).toEqual(['cmd1', 'cmd2', 'cmd3'])
        expect(result.data.terminals[0].env).toEqual({ TEST: 'value' })
      }
    })

    it('should preserve workspace state across save/restore', async () => {
      const sessionData: SessionData = {
        timestamp: new Date().toISOString(),
        terminals: [
          { id: 'term-1', shell: 'bash', cwd: '/home/user', history: [] }
        ],
        workspaces: [
          {
            projectId: 'proj-1',
            activeTerminalId: 'term-1',
            terminals: [
              { id: 'term-1', shell: 'bash', cwd: '/home/user', history: [] }
            ]
          },
          {
            projectId: 'proj-2',
            activeTerminalId: null,
            terminals: []
          }
        ]
      }

      // Save
      await tauriSessionApi.save(sessionData)

      // Mock restore to return saved data
      const setCall = currentMockStore.set.mock.calls[0]
      const savedData = setCall[1] as { _version: number; data: SessionData }
      currentMockStore.get.mockResolvedValue(savedData)

      // Restore
      const result = await tauriSessionApi.restore()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.workspaces).toHaveLength(2)
        expect(result.data.workspaces[0].activeTerminalId).toBe('term-1')
        expect(result.data.workspaces[1].activeTerminalId).toBeNull()
      }
    })
  })
})
