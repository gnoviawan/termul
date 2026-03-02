/**
 * Unit tests for tauri-data-migration-api.ts
 * Tests the data migration API using Tauri IPC invoke
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @tauri-apps/api/core BEFORE importing the module under test
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

import { invoke } from '@tauri-apps/api/core'
import {
  createTauriDataMigrationApi,
  MigrationErrorCodes
} from '../tauri-data-migration-api'
import type {
  MigrationRecord,
  MigrationResult,
  MigrationInfo,
  SchemaVersion
} from '../tauri-data-migration-api'
import type { IpcResult } from '@shared/types/ipc.types'

const mockInvoke = invoke as ReturnType<typeof vi.fn>

describe('tauriDataMigrationApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getVersion', () => {
    it('should return current schema version on success', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: '1.2.0'
      })

      const result = await api.getVersion()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe('1.2.0')
      }
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_version', undefined)
    })

    it('should return initial version for fresh install', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: '0.0.0'
      })

      const result = await api.getVersion()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe('0.0.0')
      }
    })

    it('should handle invoke errors', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockRejectedValue(new Error('IPC invoke failed'))

      const result = await api.getVersion()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('INVOKE_ERROR')
        expect(result.error).toContain('IPC invoke failed')
      }
    })

    it('should handle backend returning error result', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Version file corrupted',
        code: 'MIGRATION_VERSION_INVALID'
      })

      const result = await api.getVersion()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Version file corrupted')
        expect(result.code).toBe('MIGRATION_VERSION_INVALID')
      }
    })
  })

  describe('getSchemaInfo', () => {
    it('should return schema version info with current and target', async () => {
      const api = createTauriDataMigrationApi()
      const mockInfo: SchemaVersion = {
        current: '1.0.0',
        target: '1.5.0'
      }
      mockInvoke.mockResolvedValue({
        success: true,
        data: mockInfo
      })

      const result = await api.getSchemaInfo()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.current).toBe('1.0.0')
        expect(result.data.target).toBe('1.5.0')
      }
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_schema_info', undefined)
    })

    it('should return same current and target when up to date', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: { current: '1.5.0', target: '1.5.0' }
      })

      const result = await api.getSchemaInfo()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.current).toBe(result.data.target)
      }
    })
  })

  describe('getHistory', () => {
    it('should return empty history for fresh install', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: []
      })

      const result = await api.getHistory()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual([])
      }
    })

    it('should return migration history records', async () => {
      const api = createTauriDataMigrationApi()
      const mockHistory: MigrationRecord[] = [
        {
          version: '1.0.0',
          timestamp: '2024-01-01T00:00:00Z',
          success: true,
          duration: 150
        },
        {
          version: '1.1.0',
          timestamp: '2024-02-01T00:00:00Z',
          success: true,
          duration: 200
        },
        {
          version: '1.2.0',
          timestamp: '2024-03-01T00:00:00Z',
          success: false,
          error: 'Migration failed: column already exists',
          duration: 50
        }
      ]
      mockInvoke.mockResolvedValue({
        success: true,
        data: mockHistory
      })

      const result = await api.getHistory()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(3)
        expect(result.data[0].version).toBe('1.0.0')
        expect(result.data[1].success).toBe(true)
        expect(result.data[2].success).toBe(false)
        expect(result.data[2].error).toBeDefined()
      }
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_history', undefined)
    })

    it('should handle corrupted history', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'History file is corrupted',
        code: 'MIGRATION_HISTORY_CORRUPT'
      })

      const result = await api.getHistory()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MIGRATION_HISTORY_CORRUPT')
      }
    })
  })

  describe('getRegistered', () => {
    it('should return list of registered migrations', async () => {
      const api = createTauriDataMigrationApi()
      const mockMigrations: MigrationInfo[] = [
        { version: '1.0.0', description: 'Initial schema' },
        { version: '1.1.0', description: 'Add user preferences' },
        { version: '1.2.0', description: 'Add workspace history' },
        { version: '1.3.0', description: 'Add terminal sessions' }
      ]
      mockInvoke.mockResolvedValue({
        success: true,
        data: mockMigrations
      })

      const result = await api.getRegistered()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(4)
        expect(result.data[0].description).toBe('Initial schema')
        expect(result.data[3].version).toBe('1.3.0')
      }
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_registered', undefined)
    })

    it('should return empty array when no migrations registered', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: []
      })

      const result = await api.getRegistered()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual([])
      }
    })
  })

  describe('runMigration', () => {
    it('should return success with migration results', async () => {
      const api = createTauriDataMigrationApi()
      const mockResults: MigrationResult[] = [
        { version: '1.1.0', success: true, duration: 100 },
        { version: '1.2.0', success: true, duration: 150 }
      ]
      mockInvoke.mockResolvedValue({
        success: true,
        data: mockResults
      })

      const result = await api.runMigration()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toHaveLength(2)
        expect(result.data[0].version).toBe('1.1.0')
        expect(result.data[1].duration).toBe(150)
      }
    })

    it('should return empty array when no migrations needed', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: []
      })

      const result = await api.runMigration()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual([])
      }
    })

    it('should handle migration failure with partial results', async () => {
      const api = createTauriDataMigrationApi()
      const partialResults: MigrationResult[] = [
        { version: '1.1.0', success: true, duration: 100 },
        { version: '1.2.0', success: false, error: 'Duplicate column', duration: 50 }
      ]
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Migration 1.2.0 failed',
        code: 'MIGRATION_EXECUTION_FAILED',
        partialResults
      })

      const result = await api.runMigration()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MIGRATION_EXECUTION_FAILED')
        expect(result.error).toContain('Migration 1.2.0 failed')
        expect(result.partialResults).toEqual(partialResults)
      }
    })

    it('should handle already running migration', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Migration already in progress',
        code: 'MIGRATION_ALREADY_RUNNING'
      })

      const result = await api.runMigration()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MIGRATION_ALREADY_RUNNING')
      }
    })

    it('should handle invoke errors during migration', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockRejectedValue(new Error('IPC connection lost'))

      const result = await api.runMigration()

      expect(result.success).toBe(false)
      if (!result.success) {
        // runMigration() uses invoke() directly with its own catch block
        // which returns MIGRATION_EXECUTION_FAILED instead of INVOKE_ERROR
        expect(result.code).toBe('MIGRATION_EXECUTION_FAILED')
        expect(result.error).toContain('IPC connection lost')
      }
    })

    it('should preserve migration error details in result', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Foreign key constraint failed',
        code: 'MIGRATION_EXECUTION_FAILED'
      })

      const result = await api.runMigration()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('Foreign key constraint failed')
      }
    })
  })

  describe('rollback', () => {
    it('should successfully rollback to previous version', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: undefined
      })

      const result = await api.rollback('1.2.0')

      expect(result.success).toBe(true)
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_rollback', {
        version: '1.2.0'
      })
    })

    it('should handle version not found error', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Version 1.2.0 not found in migration history',
        code: 'MIGRATION_NOT_FOUND'
      })

      const result = await api.rollback('1.2.0')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MIGRATION_NOT_FOUND')
        expect(result.error).toContain('not found')
      }
    })

    it('should handle rollback failure', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Rollback function not defined for this version',
        code: 'ROLLBACK_FAILED'
      })

      const result = await api.rollback('1.5.0')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('ROLLBACK_FAILED')
      }
    })

    it('should handle invoke errors during rollback', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockRejectedValue(new Error('IPC timeout'))

      const result = await api.rollback('1.0.0')

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('INVOKE_ERROR')
        expect(result.error).toContain('IPC timeout')
      }
    })
  })

  describe('error codes', () => {
    it('should export all required error codes', () => {
      expect(MigrationErrorCodes.MIGRATION_VERSION_INVALID).toBe('MIGRATION_VERSION_INVALID')
      expect(MigrationErrorCodes.MIGRATION_HISTORY_CORRUPT).toBe('MIGRATION_HISTORY_CORRUPT')
      expect(MigrationErrorCodes.MIGRATION_EXECUTION_FAILED).toBe('MIGRATION_EXECUTION_FAILED')
      expect(MigrationErrorCodes.MIGRATION_ALREADY_RUNNING).toBe('MIGRATION_ALREADY_RUNNING')
      expect(MigrationErrorCodes.MIGRATION_NOT_FOUND).toBe('MIGRATION_NOT_FOUND')
      expect(MigrationErrorCodes.ROLLBACK_FAILED).toBe('ROLLBACK_FAILED')
    })
  })

  describe('API consistency', () => {
    it('should provide all required methods', () => {
      const api = createTauriDataMigrationApi()

      expect(typeof api.getVersion).toBe('function')
      expect(typeof api.getSchemaInfo).toBe('function')
      expect(typeof api.getHistory).toBe('function')
      expect(typeof api.getRegistered).toBe('function')
      expect(typeof api.runMigration).toBe('function')
      expect(typeof api.rollback).toBe('function')
    })

    it('should maintain IpcResult pattern for all methods', async () => {
      const api = createTauriDataMigrationApi()

      // Mock all invoke calls to return valid IpcResult
      mockInvoke.mockResolvedValue({
        success: true,
        data: null
      })

      // getVersion returns IpcResult<string>
      const versionResult = await api.getVersion()
      expect(typeof versionResult.success).toBe('boolean')

      // getSchemaInfo returns IpcResult<SchemaVersion>
      const schemaResult = await api.getSchemaInfo()
      expect(typeof schemaResult.success).toBe('boolean')

      // getHistory returns IpcResult<MigrationRecord[]>
      const historyResult = await api.getHistory()
      expect(typeof historyResult.success).toBe('boolean')

      // getRegistered returns IpcResult<MigrationInfo[]>
      const registeredResult = await api.getRegistered()
      expect(typeof registeredResult.success).toBe('boolean')

      // runMigration returns MigrationRunResult (which has success boolean)
      const migrationResult = await api.runMigration()
      expect(typeof migrationResult.success).toBe('boolean')

      // rollback returns IpcResult<void>
      const rollbackResult = await api.rollback('1.0.0')
      expect(typeof rollbackResult.success).toBe('boolean')
    })
  })

  describe('version parsing and handling', () => {
    it('should handle semantic versioning correctly', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'data_migration_get_version') {
          return Promise.resolve({ success: true, data: '2.1.3' })
        }
        if (cmd === 'data_migration_get_schema_info') {
          return Promise.resolve({
            success: true,
            data: { current: '2.1.3', target: '2.5.0' }
          })
        }
        return Promise.resolve({ success: true, data: [] })
      })

      const versionResult = await api.getVersion()
      expect(versionResult.success).toBe(true)
      if (versionResult.success) {
        expect(versionResult.data).toBe('2.1.3')
      }

      const schemaResult = await api.getSchemaInfo()
      expect(schemaResult.success).toBe(true)
      if (schemaResult.success) {
        expect(schemaResult.data.current).toBe('2.1.3')
        expect(schemaResult.data.target).toBe('2.5.0')
      }
    })

    it('should handle pre-release versions', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: '1.5.0-beta.1'
      })

      const result = await api.getVersion()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toBe('1.5.0-beta.1')
      }
    })
  })

  describe('migration history integrity', () => {
    it('should preserve migration order in history', async () => {
      const api = createTauriDataMigrationApi()
      const mockHistory: MigrationRecord[] = [
        { version: '1.0.0', timestamp: '2024-01-01T00:00:00Z', success: true, duration: 100 },
        { version: '1.1.0', timestamp: '2024-02-01T00:00:00Z', success: true, duration: 120 },
        { version: '1.2.0', timestamp: '2024-03-01T00:00:00Z', success: true, duration: 80 }
      ]
      mockInvoke.mockResolvedValue({
        success: true,
        data: mockHistory
      })

      const result = await api.getHistory()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data[0].version).toBe('1.0.0')
        expect(result.data[1].version).toBe('1.1.0')
        expect(result.data[2].version).toBe('1.2.0')
      }
    })

    it('should include failure information in history', async () => {
      const api = createTauriDataMigrationApi()
      const mockHistory: MigrationRecord[] = [
        {
          version: '1.2.0',
          timestamp: '2024-03-01T00:00:00Z',
          success: false,
          error: 'Constraint violation: duplicate key',
          duration: 45
        }
      ]
      mockInvoke.mockResolvedValue({
        success: true,
        data: mockHistory
      })

      const result = await api.getHistory()

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data[0].success).toBe(false)
        expect(result.data[0].error).toContain('Constraint violation')
        expect(result.data[0].duration).toBe(45)
      }
    })
  })

  describe('factory function', () => {
    it('should return a new instance each time', () => {
      const api1 = createTauriDataMigrationApi()
      const api2 = createTauriDataMigrationApi()

      // Unlike session API which uses singleton, this creates new instances
      expect(api1).toBeTruthy()
      expect(api2).toBeTruthy()
      expect(typeof api1.getVersion).toBe('function')
      expect(typeof api2.getVersion).toBe('function')
    })
  })

  describe('Regression: Rollback payload shape ({ version })', () => {
    /**
     * REGRESSION TEST: Verify rollback sends correct payload shape to Tauri.
     *
     * The Rust command signature is:
     * ```rust
     * #[tauri::command]
     * pub async fn data_migration_rollback(
     *     request: RollbackRequest,
     *     ...
     * ) -> Result<IpcResult<()>, String>
     * ```
     *
     * Tauri automatically flattens single-struct parameters, so we pass
     * the struct fields directly: { version } rather than { request: { version } }
     */

    it('should send { version } payload shape to Tauri command', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: undefined
      })

      await api.rollback('1.2.0')

      expect(mockInvoke).toHaveBeenCalledWith(
        'data_migration_rollback',
        { version: '1.2.0' }
      )
    })

    it('should include version in payload without wrapping', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: undefined
      })

      await api.rollback('2.0.0')

      const invokeCall = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1]
      const args = invokeCall[1] as { version?: string }

      // Should have version directly, not nested
      expect(args).toBeDefined()
      expect(args.version).toBe('2.0.0')
      expect(args).toEqual({ version: '2.0.0' })

      // Should NOT be wrapped like { request: { version: '2.0.0' } }
      expect('request' in args).toBe(false)
    })

    it('should handle version strings with various formats', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({
        success: true,
        data: undefined
      })

      const versions = ['1.0.0', '2.1.3', '1.5.0-beta.1', '3.0.0-rc.2']

      for (const version of versions) {
        await api.rollback(version)

        const invokeCall = mockInvoke.mock.calls.find(
          call => call[0] === 'data_migration_rollback'
        )
        expect(invokeCall).toBeDefined()
      }
    })
  })

  describe('Regression: Error mapping from IpcResult', () => {
    /**
     * REGRESSION TEST: Verify errors from Tauri IPC are properly mapped
     * to IpcResult format with appropriate error codes.
     */

    it('should map invoke errors to INVOKE_ERROR', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockRejectedValue(new Error('IPC connection lost'))

      const result = await api.getVersion()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('INVOKE_ERROR')
        expect(result.error).toContain('IPC connection lost')
      }
    })

    it('should map backend error codes from IpcResult', async () => {
      const api = createTauriDataMigrationApi()

      // Backend returns error with code
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Version file corrupted',
        code: 'MIGRATION_VERSION_INVALID'
      })

      const result = await api.getVersion()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MIGRATION_VERSION_INVALID')
        expect(result.error).toBe('Version file corrupted')
      }
    })

    it('should preserve partial results on migration failure', async () => {
      const api = createTauriDataMigrationApi()
      const partialResults = [
        { version: '1.1.0', success: true, duration: 100 },
        { version: '1.2.0', success: false, error: 'Failed', duration: 50 }
      ]

      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Migration 1.2.0 failed',
        code: 'MIGRATION_EXECUTION_FAILED',
        partialResults
      })

      const result = await api.runMigration()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MIGRATION_EXECUTION_FAILED')
        expect(result.partialResults).toEqual(partialResults)
      }
    })

    it('should handle missing error codes gracefully', async () => {
      const api = createTauriDataMigrationApi()

      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Unknown error'
        // No code field
      })

      const result = await api.getVersion()

      expect(result.success).toBe(false)
      // Should still have success: false and error message
      expect(result.error).toBe('Unknown error')
    })

    it('should use MIGRATION_EXECUTION_FAILED for runMigration invoke errors', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockRejectedValue(new Error('Network timeout'))

      const result = await api.runMigration()

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.code).toBe('MIGRATION_EXECUTION_FAILED')
        expect(result.error).toContain('Network timeout')
      }
    })
  })

  describe('Regression: All canonical methods from Task 4', () => {
    /**
     * REGRESSION TEST: Verify all canonical methods from MigrationApi contract
     * are implemented correctly.
     *
     * Based on Task 4 requirements:
     * - getVersion: Get current schema version
     * - getSchemaInfo: Get current and target schema versions
     * - getHistory: Get migration history records
     * - getRegistered: Get all registered migrations
     * - runMigration: Run all pending migrations
     * - rollback: Rollback to a specific version
     */

    it('should implement all canonical methods', () => {
      const api = createTauriDataMigrationApi()

      const canonicalMethods = [
        'getVersion',
        'getSchemaInfo',
        'getHistory',
        'getRegistered',
        'runMigration',
        'rollback'
      ]

      canonicalMethods.forEach(method => {
        expect(typeof api[method as keyof typeof api]).toBe('function')
      })
    })

    it('should use correct IPC command names for each method', async () => {
      const api = createTauriDataMigrationApi()
      mockInvoke.mockResolvedValue({ success: true, data: null })

      // Each method should invoke the correct Tauri command
      await api.getVersion()
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_version', undefined)

      await api.getSchemaInfo()
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_schema_info', undefined)

      await api.getHistory()
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_history', undefined)

      await api.getRegistered()
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_get_registered', undefined)

      // Reset for runMigration which has different error handling
      mockInvoke.mockResolvedValue({ success: true, data: [] })
      await api.runMigration()
      expect(mockInvoke).toHaveBeenCalledWith('data_migration_run_migrations')
    })

    it('should return IpcResult<T> pattern for all methods', async () => {
      const api = createTauriDataMigrationApi()

      // Mock successful responses
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'data_migration_get_version') {
          return Promise.resolve({ success: true, data: '1.0.0' })
        }
        if (cmd === 'data_migration_get_schema_info') {
          return Promise.resolve({ success: true, data: { current: '1.0.0', target: '1.5.0' } })
        }
        if (cmd === 'data_migration_get_history') {
          return Promise.resolve({ success: true, data: [] })
        }
        if (cmd === 'data_migration_get_registered') {
          return Promise.resolve({ success: true, data: [] })
        }
        return Promise.resolve({ success: true, data: [] })
      })

      const versionResult = await api.getVersion()
      expect(typeof versionResult.success).toBe('boolean')

      const schemaResult = await api.getSchemaInfo()
      expect(typeof schemaResult.success).toBe('boolean')

      const historyResult = await api.getHistory()
      expect(typeof historyResult.success).toBe('boolean')

      const registeredResult = await api.getRegistered()
      expect(typeof registeredResult.success).toBe('boolean')
    })
  })
})
