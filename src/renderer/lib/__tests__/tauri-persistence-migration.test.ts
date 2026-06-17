import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @tauri-apps/plugin-store BEFORE importing the module under test
const mockData = new Map<string, unknown>()

vi.mock('@tauri-apps/plugin-store', () => {
  return {
    Store: {
      load: vi.fn(async () => ({
        get: vi.fn(async (key: string) => mockData.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
          mockData.set(key, value)
        }),
        delete: vi.fn(async (key: string) => {
          mockData.delete(key)
        }),
        save: vi.fn(async () => undefined)
      }))
    }
  }
})

import {
  _resetStoreInstanceForTesting,
  getCurrentSchemaVersion,
  type Migration,
  registerMigration,
  runMigrations
} from '../tauri-persistence-api'

describe('Store Schema Migration', () => {
  beforeEach(() => {
    mockData.clear()
    _resetStoreInstanceForTesting()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('getCurrentSchemaVersion', () => {
    it('returns version 1 for fresh install with no stored data', async () => {
      const result = await getCurrentSchemaVersion()

      expect(result.success).toBe(true)
      expect(result.data).toBe(1)
    })

    it('returns stored version when data exists', async () => {
      // Simulate existing store with version 2
      mockData.set('_schema_version', 2)

      const result = await getCurrentSchemaVersion()

      expect(result.success).toBe(true)
      expect(result.data).toBe(2)
    })
  })

  describe('registerMigration', () => {
    it('allows registering a migration from v1 to v2', () => {
      const migration: Migration = {
        fromVersion: 1,
        toVersion: 2,
        migrate: async () => ({ success: true, data: undefined })
      }

      const result = registerMigration(migration)

      expect(result.success).toBe(true)
    })

    it('rejects duplicate migration registration', () => {
      const migration: Migration = {
        fromVersion: 1,
        toVersion: 2,
        migrate: async () => ({ success: true, data: undefined })
      }

      registerMigration(migration)
      const result = registerMigration(migration)

      expect(result.success).toBe(false)
      expect(result.error).toContain('already registered')
    })
  })

  describe('runMigrations', () => {
    it('runs no migrations when already at latest version', async () => {
      // Current version is 1, no migrations registered
      const result = await runMigrations()

      expect(result.success).toBe(true)
      expect(result.data).toEqual([]) // No migrations ran
    })

    it('migrates from v1 to v2 when v2 migration is registered', async () => {
      let migrationExecuted = false

      registerMigration({
        fromVersion: 1,
        toVersion: 2,
        migrate: async () => {
          migrationExecuted = true
          return { success: true, data: undefined }
        }
      })

      const result = await runMigrations()

      expect(result.success).toBe(true)
      expect(migrationExecuted).toBe(true)

      // Verify version was updated
      const versionResult = await getCurrentSchemaVersion()
      expect(versionResult.data).toBe(2)
    })

    it('migrates through multiple versions (v1 -> v2 -> v3)', async () => {
      const executionOrder: number[] = []

      registerMigration({
        fromVersion: 1,
        toVersion: 2,
        migrate: async () => {
          executionOrder.push(2)
          return { success: true, data: undefined }
        }
      })

      registerMigration({
        fromVersion: 2,
        toVersion: 3,
        migrate: async () => {
          executionOrder.push(3)
          return { success: true, data: undefined }
        }
      })

      const result = await runMigrations()

      expect(result.success).toBe(true)
      expect(executionOrder).toEqual([2, 3]) // Executed in order

      const versionResult = await getCurrentSchemaVersion()
      expect(versionResult.data).toBe(3)
    })

    it('stops migration chain if one migration fails', async () => {
      const executionOrder: number[] = []

      registerMigration({
        fromVersion: 1,
        toVersion: 2,
        migrate: async () => {
          executionOrder.push(2)
          return { success: false, error: 'Migration failed', code: 'MIGRATION_ERROR' }
        }
      })

      registerMigration({
        fromVersion: 2,
        toVersion: 3,
        migrate: async () => {
          executionOrder.push(3)
          return { success: true, data: undefined }
        }
      })

      const result = await runMigrations()

      expect(result.success).toBe(false)
      expect(executionOrder).toEqual([2]) // Stopped after v2 failure

      // Version should stay at v1 since migration failed
      const versionResult = await getCurrentSchemaVersion()
      expect(versionResult.data).toBe(1)
    })

    it('transforms actual stored data during migration', async () => {
      // Setup: v1 data structure
      mockData.set('acp-sessions', {
        _version: 1,
        data: {
          'session-1': {
            messages: ['old format']
          }
        }
      })

      // Register migration that transforms data structure
      registerMigration({
        fromVersion: 1,
        toVersion: 2,
        migrate: async () => {
          const storeData = mockData.get('acp-sessions') as any
          if (storeData?.data) {
            // Transform data structure
            const sessions = storeData.data
            for (const sessionId in sessions) {
              const session = sessions[sessionId]
              // Transform messages from array to proper ChatMessage objects
              session.messages = session.messages.map((msg: string) => ({
                id: 'msg-1',
                role: 'user',
                content: [{ type: 'text', text: msg }],
                timestamp: Date.now()
              }))
            }

            // Update version
            storeData._version = 2
            mockData.set('acp-sessions', storeData)
          }
          return { success: true, data: undefined }
        }
      })

      const result = await runMigrations()

      expect(result.success).toBe(true)

      // Verify data was transformed
      const transformed = mockData.get('acp-sessions') as any
      expect(transformed._version).toBe(2)
      expect(transformed.data['session-1'].messages[0]).toHaveProperty('id')
      expect(transformed.data['session-1'].messages[0]).toHaveProperty('role')
    })
  })
})
