import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  DataMigrationService,
  getDataMigrationService,
  resetDataMigrationService
} from '../services/data-migration'
import type { IpcResult } from '../../shared/types/ipc.types'

// Re-export types from data-migration service for convenience
export type {
  MigrationResult,
  MigrationRunResult,
  MigrationRecord,
  MigrationEntry,
  SchemaVersion
} from '../services/data-migration'

export {
  MigrationErrorCodes,
  type MigrationErrorCode
} from '../services/data-migration'

/**
 * Register IPC handlers for data migration
 *
 * Channels:
 * - dataMigration:runMigrations - Run all pending migrations
 * - dataMigration:rollback - Rollback a specific migration
 * - dataMigration:getHistory - Get migration history
 * - dataMigration:getRegistered - Get all registered migrations
 * - dataMigration:getVersionInfo - Get current and target schema versions
 * - dataMigration:register - Register a new migration (for main process use)
 */
export function registerDataMigrationIpc(): void {
  const migrationService = getDataMigrationService()

  // Run all pending migrations
  ipcMain.handle('dataMigration:runMigrations', async (_event: IpcMainInvokeEvent): Promise<IpcResult<{
    results: Array<{ version: string; success: boolean; error?: string; duration: number }>
  }>> => {
    const result = await migrationService.runMigrations()

    if (result.success) {
      return {
        success: true,
        data: { results: result.data }
      }
    }

    return {
      success: false,
      error: result.error,
      code: result.code
    }
  })

  // Rollback a specific migration
  ipcMain.handle(
    'dataMigration:rollback',
    async (_event: IpcMainInvokeEvent, version: string): Promise<IpcResult<void>> => {
      return migrationService.rollbackMigration(version)
    }
  )

  // Get migration history
  ipcMain.handle('dataMigration:getHistory', async (_event: IpcMainInvokeEvent): Promise<IpcResult<
    Array<{ version: string; timestamp: string; success: boolean; error?: string; duration?: number }>
  >> => {
    return migrationService.getMigrationHistory()
  })

  // Get all registered migrations
  ipcMain.handle('dataMigration:getRegistered', async (_event: IpcMainInvokeEvent): Promise<IpcResult<
    Array<{ version: string; description: string; hasRollback: boolean }>
  >> => {
    try {
      const migrations = migrationService.getRegisteredMigrations()
      return {
        success: true,
        data: migrations.map((m) => ({
          version: m.version,
          description: m.description,
          hasRollback: !!m.rollbackFn
        }))
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get registered migrations',
        code: 'MIGRATION_GET_REGISTERED_FAILED'
      }
    }
  })

  // Get schema version info
  ipcMain.handle('dataMigration:getVersionInfo', async (_event: IpcMainInvokeEvent): Promise<IpcResult<{
    current: string
    target: string
  }>> => {
    return migrationService.getSchemaVersionInfo()
  })
}

/**
 * Reset data migration IPC service (useful for testing)
 */
export function resetDataMigrationIpc(): void {
  resetDataMigrationService()
}

/**
 * Get the migration service instance for main process use
 * (e.g., registering migrations on app startup)
 */
export function getMigrationServiceForRegistration(): DataMigrationService {
  return getDataMigrationService()
}
