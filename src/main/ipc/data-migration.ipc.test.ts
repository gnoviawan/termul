/**
 * Unit tests for data-migration.ipc.ts
 * Tests Electron IPC data-migration handlers still work (compatibility path validation)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerDataMigrationIpc,
  resetDataMigrationIpc,
  getMigrationServiceForRegistration
} from './data-migration.ipc'
import type { IpcResult } from '../../shared/types/ipc.types'

// Mock electron
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

// Mock data-migration service
const mockMigrationService = {
  runMigrations: vi.fn(),
  rollbackMigration: vi.fn(),
  getMigrationHistory: vi.fn(),
  getRegisteredMigrations: vi.fn(),
  getSchemaVersionInfo: vi.fn(),
  registerMigration: vi.fn()
}

vi.mock('../services/data-migration', () => ({
  DataMigrationService: vi.fn(),
  getDataMigrationService: () => mockMigrationService,
  resetDataMigrationService: vi.fn(),
  MigrationErrorCodes: {
    MIGRATION_VERSION_INVALID: 'MIGRATION_VERSION_INVALID',
    MIGRATION_HISTORY_CORRUPT: 'MIGRATION_HISTORY_CORRUPT',
    MIGRATION_EXECUTION_FAILED: 'MIGRATION_EXECUTION_FAILED',
    MIGRATION_ALREADY_RUNNING: 'MIGRATION_ALREADY_RUNNING',
    MIGRATION_NOT_FOUND: 'MIGRATION_NOT_FOUND',
    ROLLBACK_FAILED: 'ROLLBACK_FAILED'
  }
}))

describe('data-migration.ipc (Electron compatibility)', () => {
  let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>

  beforeEach(() => {
    vi.clearAllMocks()

    handlers = new Map()

    // Capture handlers when registered
    vi.mocked(ipcMain.handle).mockImplementation(
      (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>)
        return undefined as unknown as Electron.IpcMain
      }
    )

    // Setup default mock responses
    mockMigrationService.runMigrations.mockResolvedValue({
      success: true,
      data: [
        { version: '1.1.0', success: true, duration: 100 },
        { version: '1.2.0', success: true, duration: 150 }
      ]
    })
    mockMigrationService.rollbackMigration.mockResolvedValue({
      success: true,
      data: undefined
    })
    mockMigrationService.getMigrationHistory.mockResolvedValue({
      success: true,
      data: []
    })
    mockMigrationService.getRegisteredMigrations.mockReturnValue([
      {
        version: '1.0.0',
        description: 'Initial schema',
        migrateFn: vi.fn(),
        rollbackFn: vi.fn()
      }
    ])
    mockMigrationService.getSchemaVersionInfo.mockResolvedValue({
      success: true,
      data: { current: '1.0.0', target: '1.5.0' }
    })
  })

  afterEach(() => {
    // Reset IPC handlers after each test
    resetDataMigrationIpc()
  })

  describe('registerDataMigrationIpc', () => {
    it('should register all data migration IPC handlers', () => {
      registerDataMigrationIpc()

      expect(ipcMain.handle).toHaveBeenCalledWith('dataMigration:runMigrations', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('dataMigration:rollback', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('dataMigration:getHistory', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('dataMigration:getRegistered', expect.any(Function))
      expect(ipcMain.handle).toHaveBeenCalledWith('dataMigration:getVersionInfo', expect.any(Function))
    })

    it('should use the default data migration service', () => {
      registerDataMigrationIpc()

      // The handlers should be registered
      expect(handlers.size).toBe(5)
    })
  })

  describe('dataMigration:runMigrations handler', () => {
    it('should run migrations and return results', async () => {
      const mockResults = [
        { version: '1.1.0', success: true, duration: 100 },
        { version: '1.2.0', success: true, duration: 150 }
      ]
      mockMigrationService.runMigrations.mockResolvedValue({
        success: true,
        data: mockResults
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:runMigrations')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({
        success: true,
        data: { results: mockResults }
      })
    })

    it('should propagate migration errors', async () => {
      mockMigrationService.runMigrations.mockResolvedValue({
        success: false,
        error: 'Migration failed: Duplicate column',
        code: 'MIGRATION_EXECUTION_FAILED'
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:runMigrations')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<{ results: unknown[] }>

      expect(result.success).toBe(false)
      expect(result.error).toContain('Migration failed')
      expect(result.code).toBe('MIGRATION_EXECUTION_FAILED')
    })

    it('should return empty results when no migrations needed', async () => {
      mockMigrationService.runMigrations.mockResolvedValue({
        success: true,
        data: []
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:runMigrations')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({
        success: true,
        data: { results: [] }
      })
    })
  })

  describe('dataMigration:rollback handler', () => {
    it('should rollback to specified version', async () => {
      mockMigrationService.rollbackMigration.mockResolvedValue({
        success: true,
        data: undefined
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:rollback')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, '1.2.0')

      expect(mockMigrationService.rollbackMigration).toHaveBeenCalledWith('1.2.0')
      expect(result).toEqual({ success: true, data: undefined })
    })

    it('should handle version not found error', async () => {
      mockMigrationService.rollbackMigration.mockResolvedValue({
        success: false,
        error: 'Version 1.2.0 not found in migration history',
        code: 'MIGRATION_NOT_FOUND'
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:rollback')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, '1.2.0') as IpcResult<void>

      expect(result.success).toBe(false)
      expect(result.code).toBe('MIGRATION_NOT_FOUND')
      expect(result.error).toContain('not found')
    })

    it('should handle rollback failure', async () => {
      mockMigrationService.rollbackMigration.mockResolvedValue({
        success: false,
        error: 'Rollback function not defined for this version',
        code: 'ROLLBACK_FAILED'
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:rollback')
      const result = await handler!({} as Electron.IpcMainInvokeEvent, '1.5.0') as IpcResult<void>

      expect(result.success).toBe(false)
      expect(result.code).toBe('ROLLBACK_FAILED')
    })
  })

  describe('dataMigration:getHistory handler', () => {
    it('should return migration history', async () => {
      const mockHistory = [
        {
          version: '1.0.0',
          timestamp: '2024-01-01T00:00:00Z',
          success: true,
          duration: 100
        },
        {
          version: '1.1.0',
          timestamp: '2024-02-01T00:00:00Z',
          success: true,
          duration: 150
        },
        {
          version: '1.2.0',
          timestamp: '2024-03-01T00:00:00Z',
          success: false,
          error: 'Migration failed: column already exists',
          duration: 50
        }
      ]
      mockMigrationService.getMigrationHistory.mockResolvedValue({
        success: true,
        data: mockHistory
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:getHistory')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({
        success: true,
        data: mockHistory
      })
    })

    it('should handle corrupted history', async () => {
      mockMigrationService.getMigrationHistory.mockResolvedValue({
        success: false,
        error: 'History file is corrupted',
        code: 'MIGRATION_HISTORY_CORRUPT'
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:getHistory')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<unknown[]>

      expect(result.success).toBe(false)
      expect(result.code).toBe('MIGRATION_HISTORY_CORRUPT')
    })
  })

  describe('dataMigration:getRegistered handler', () => {
    it('should return list of registered migrations', async () => {
      const mockMigrations = [
        {
          version: '1.0.0',
          description: 'Initial schema',
          migrateFn: vi.fn(),
          rollbackFn: vi.fn()
        },
        {
          version: '1.1.0',
          description: 'Add user preferences',
          migrateFn: vi.fn(),
          rollbackFn: null
        },
        {
          version: '1.2.0',
          description: 'Add workspace history',
          migrateFn: vi.fn(),
          rollbackFn: vi.fn()
        }
      ]
      mockMigrationService.getRegisteredMigrations.mockReturnValue(mockMigrations)

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:getRegistered')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({
        success: true,
        data: [
          { version: '1.0.0', description: 'Initial schema', hasRollback: true },
          { version: '1.1.0', description: 'Add user preferences', hasRollback: false },
          { version: '1.2.0', description: 'Add workspace history', hasRollback: true }
        ]
      })
    })

    it('should return empty array when no migrations registered', async () => {
      mockMigrationService.getRegisteredMigrations.mockReturnValue([])

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:getRegistered')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({
        success: true,
        data: []
      })
    })

    it('should handle get registered errors', async () => {
      mockMigrationService.getRegisteredMigrations.mockImplementation(() => {
        throw new Error('Failed to get registered migrations')
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:getRegistered')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<unknown[]>

      expect(result.success).toBe(false)
      expect(result.code).toBe('MIGRATION_GET_REGISTERED_FAILED')
      expect(result.error).toContain('Failed to get registered migrations')
    })
  })

  describe('dataMigration:getVersionInfo handler', () => {
    it('should return schema version info', async () => {
      const mockVersionInfo = {
        current: '1.0.0',
        target: '1.5.0'
      }
      mockMigrationService.getSchemaVersionInfo.mockResolvedValue({
        success: true,
        data: mockVersionInfo
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:getVersionInfo')
      const result = await handler!({} as Electron.IpcMainInvokeEvent)

      expect(result).toEqual({
        success: true,
        data: mockVersionInfo
      })
    })

    it('should handle version info errors', async () => {
      mockMigrationService.getSchemaVersionInfo.mockResolvedValue({
        success: false,
        error: 'Version file corrupted',
        code: 'MIGRATION_VERSION_INVALID'
      })

      registerDataMigrationIpc()

      const handler = handlers.get('dataMigration:getVersionInfo')
      const result = await handler!({} as Electron.IpcMainInvokeEvent) as IpcResult<{ current: string; target: string }>

      expect(result.success).toBe(false)
      expect(result.code).toBe('MIGRATION_VERSION_INVALID')
    })
  })

  describe('getMigrationServiceForRegistration', () => {
    it('should return the migration service instance', () => {
      const service = getMigrationServiceForRegistration()

      expect(service).toBe(mockMigrationService)
      expect(typeof service.registerMigration).toBe('function')
      expect(typeof service.runMigrations).toBe('function')
    })
  })

  describe('Regression: Compatibility with Tauri data-migration-api.ts', () => {
    /**
     * REGRESSION TEST: Ensure Electron IPC handlers maintain compatibility
     * with the legacy data-migration-api.ts that uses window.api.dataMigration
     *
     * Note: The Electron API uses legacy method names (plural runMigrations,
     * getVersionInfo) vs the canonical Tauri contract (singular runMigration,
     * getSchemaInfo).
     *
     * This validates that the Electron compatibility path still works
     * when running in Electron context.
     */

    it('should maintain IpcResult<T> pattern for all handlers', async () => {
      // Setup all handlers to return success
      mockMigrationService.runMigrations.mockResolvedValue({
        success: true,
        data: []
      })
      mockMigrationService.rollbackMigration.mockResolvedValue({
        success: true,
        data: undefined
      })
      mockMigrationService.getMigrationHistory.mockResolvedValue({
        success: true,
        data: []
      })
      mockMigrationService.getSchemaVersionInfo.mockResolvedValue({
        success: true,
        data: { current: '1.0.0', target: '1.0.0' }
      })
      mockMigrationService.getRegisteredMigrations.mockReturnValue([])

      registerDataMigrationIpc()

      // dataMigration:runMigrations returns IpcResult with { results: [] }
      const runHandler = handlers.get('dataMigration:runMigrations')
      const runResult = await runHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (runResult as IpcResult<{ results: unknown[] }>).success).toBe('boolean')

      // dataMigration:rollback returns IpcResult<void>
      const rollbackHandler = handlers.get('dataMigration:rollback')
      const rollbackResult = await rollbackHandler!({} as Electron.IpcMainInvokeEvent, '1.0.0')
      expect(typeof (rollbackResult as IpcResult<void>).success).toBe('boolean')

      // dataMigration:getHistory returns IpcResult<MigrationHistoryRecord[]>
      const historyHandler = handlers.get('dataMigration:getHistory')
      const historyResult = await historyHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (historyResult as IpcResult<unknown[]>).success).toBe('boolean')

      // dataMigration:getRegistered returns IpcResult<RegisteredMigration[]>
      const registeredHandler = handlers.get('dataMigration:getRegistered')
      const registeredResult = await registeredHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (registeredResult as IpcResult<unknown[]>).success).toBe('boolean')

      // dataMigration:getVersionInfo returns IpcResult<SchemaVersionInfo>
      const versionInfoHandler = handlers.get('dataMigration:getVersionInfo')
      const versionInfoResult = await versionInfoHandler!({} as Electron.IpcMainInvokeEvent)
      expect(typeof (versionInfoResult as IpcResult<{ current: string; target: string }>).success).toBe('boolean')
    })

    it('should use legacy method names from data-migration-api.ts', () => {
      registerDataMigrationIpc()

      // Verify the channel names match the legacy facade method names
      const expectedChannels = [
        'dataMigration:runMigrations', // Legacy: plural "runMigrations"
        'dataMigration:rollback',
        'dataMigration:getHistory',
        'dataMigration:getRegistered',
        'dataMigration:getVersionInfo' // Legacy: "getVersionInfo"
      ]

      expectedChannels.forEach(channel => {
        expect(handlers.has(channel)).toBe(true)
      })

      // Note: Canonical Tauri contract uses:
      // - runMigration (singular) instead of runMigrations (plural)
      // - getSchemaInfo instead of getVersionInfo
    })
  })

  describe('Regression: Error code consistency', () => {
    /**
     * REGRESSION TEST: Verify error codes match between Electron and Tauri
     * implementations for consistent error handling across platforms.
     */

    it('should use same error codes as Tauri implementation', async () => {
      // Test all standard error codes
      const errorTests = [
        {
          mock: {
            success: false,
            error: 'Version file corrupted',
            code: 'MIGRATION_VERSION_INVALID'
          },
          expectedCode: 'MIGRATION_VERSION_INVALID'
        },
        {
          mock: {
            success: false,
            error: 'History file is corrupted',
            code: 'MIGRATION_HISTORY_CORRUPT'
          },
          expectedCode: 'MIGRATION_HISTORY_CORRUPT'
        },
        {
          mock: {
            success: false,
            error: 'Migration execution failed',
            code: 'MIGRATION_EXECUTION_FAILED'
          },
          expectedCode: 'MIGRATION_EXECUTION_FAILED'
        },
        {
          mock: {
            success: false,
            error: 'Migration not found',
            code: 'MIGRATION_NOT_FOUND'
          },
          expectedCode: 'MIGRATION_NOT_FOUND'
        },
        {
          mock: {
            success: false,
            error: 'Rollback failed',
            code: 'ROLLBACK_FAILED'
          },
          expectedCode: 'ROLLBACK_FAILED'
        }
      ]

      for (const test of errorTests) {
        mockMigrationService.rollbackMigration.mockResolvedValue(test.mock)

        registerDataMigrationIpc()

        const handler = handlers.get('dataMigration:rollback')
        const result = await handler!({} as Electron.IpcMainInvokeEvent, '1.0.0') as IpcResult<void>

        expect(result.code).toBe(test.expectedCode)
        expect(result.error).toBe(test.mock.error)
      }
    })
  })
})
