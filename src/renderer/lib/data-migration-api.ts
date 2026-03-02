/**
 * Data Migration API - Electron Compatibility Module
 *
 * @deprecated This is a compatibility module for Electron builds.
 * For Tauri builds, use tauri-data-migration-api.ts instead.
 *
 * IMPORTANT: This module should only be used in Electron context.
 * When running in Tauri context, the facade in api.ts will automatically
 * route to createTauriDataMigrationApi(). Using this module directly in
 * Tauri context will result in an explicit error.
 *
 * NOTE: This file uses legacy method names that differ from the canonical
 * MigrationApi contract defined in ipc.types.ts. Use tauri-data-migration-api.ts
 * for the canonical implementation.
 *
 * COMPATIBILITY ALIASES (marked as deprecated):
 * - runMigrations -> use runMigration() (singular) in canonical contract
 * - getVersionInfo -> use getSchemaInfo() in canonical contract
 *
 * Migration Path:
 * - Electron builds: No change needed, api.ts facade handles routing
 * - Tauri builds: Use createTauriDataMigrationApi() (exported via api.ts facade)
 *
 * @see @shared/types/ipc.types.ts - MigrationApi canonical contract
 * @see tauri-data-migration-api.ts - Tauri implementation of canonical contract
 * @see api.ts - Runtime-aware facade that selects the correct adapter
 */

import type { IpcResult } from '@shared/types/ipc.types'

/**
 * Detects if running in Tauri context.
 * Used to prevent accidental usage of Electron module in Tauri context.
 */
function isTauriContext(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
}

/**
 * Check if we're in Electron context (window.api exists)
 */
function isElectronContext(): boolean {
  return typeof window !== 'undefined' && 'api' in window && typeof (window as any).api === 'object'
}

/**
 * Error result for wrong context usage
 */
function wrongContextError(operation: string): IpcResult<never> {
  return {
    success: false,
    error: `Data Migration API operation '${operation}' called in wrong context. This is an Electron compatibility module, but running in Tauri context. Use api.ts facade instead.`,
    code: 'DATA_MIGRATION_API_WRONG_CONTEXT'
  }
}

/**
 * Migration result details
 *
 * @deprecated Use MigrationResult from @shared/types/ipc.types instead
 */
export interface MigrationResult {
  version: string
  success: boolean
  error?: string
  duration: number
}

/**
 * Schema version info
 *
 * @deprecated Use SchemaVersion from @shared/types/ipc.types instead
 */
export interface SchemaVersionInfo {
  current: string
  target: string
}

/**
 * Registered migration entry
 *
 * @deprecated Use MigrationInfo from @shared/types/ipc.types instead
 * Note: This includes hasRollback which is not in the canonical contract
 */
export interface RegisteredMigration {
  version: string
  description: string
  hasRollback: boolean
}

/**
 * Migration history record
 *
 * @deprecated Use MigrationRecord from @shared/types/ipc.types instead
 */
export interface MigrationHistoryRecord {
  version: string
  timestamp: string
  success: boolean
  error?: string
  duration?: number
}

/**
 * Data Migration API for renderer process (Electron compatibility)
 *
 * IMPORTANT: This API uses legacy method names that differ from the
 * canonical MigrationApi contract. New code should use the canonical
 * contract from tauri-data-migration-api.ts instead.
 *
 * All operations return IpcResult<T> for consistent error handling.
 *
 * IMPORTANT: This will fail with explicit error if called in Tauri context.
 * Use the facade in api.ts for runtime-agnostic access.
 *
 * Legacy vs Canonical mapping:
 * - runMigrations() (plural) -> runMigration() (singular)
 * - getVersionInfo() -> getSchemaInfo()
 * - getHistory() -> getHistory() (same)
 * - getRegistered() -> getRegistered() (same)
 * - rollback(version) -> rollback(version) (same)
 *
 * @deprecated Use the canonical MigrationApi contract instead.
 * See @shared/types/ipc.types.ts for the canonical interface.
 */
export const dataMigrationApi = {
  /**
   * Run all pending migrations
   * Migrates from current version to the latest registered version
   *
   * @deprecated Use runMigration() (singular) from canonical MigrationApi instead
   * @returns IpcResult with object containing results array
   */
  runMigrations: async (): Promise<IpcResult<{ results: MigrationResult[] }>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('runMigrations')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.dataMigration.runMigrations()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Data Migration API not available - ensure running in Electron context',
      code: 'DATA_MIGRATION_API_UNAVAILABLE'
    }
  },

  /**
   * Rollback a specific migration
   * Requires the migration to have a rollback function registered
   *
   * @returns IpcResult<void>
   */
  rollback: async (version: string): Promise<IpcResult<void>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('rollback')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.dataMigration.rollback(version)
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Data Migration API not available - ensure running in Electron context',
      code: 'DATA_MIGRATION_API_UNAVAILABLE'
    }
  },

  /**
   * Get migration history
   * @returns IpcResult with array of migration records
   */
  getHistory: async (): Promise<IpcResult<MigrationHistoryRecord[]>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('getHistory')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.dataMigration.getHistory()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Data Migration API not available - ensure running in Electron context',
      code: 'DATA_MIGRATION_API_UNAVAILABLE'
    }
  },

  /**
   * Get all registered migrations
   * @returns IpcResult with array of registered migrations
   */
  getRegistered: async (): Promise<IpcResult<RegisteredMigration[]>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('getRegistered')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.dataMigration.getRegistered()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Data Migration API not available - ensure running in Electron context',
      code: 'DATA_MIGRATION_API_UNAVAILABLE'
    }
  },

  /**
   * Get schema version info (current and target versions)
   *
   * @deprecated Use getSchemaInfo() from canonical MigrationApi instead
   * @returns IpcResult with version info
   */
  getVersionInfo: async (): Promise<IpcResult<SchemaVersionInfo>> => {
    // Error boundary: prevent usage in Tauri context
    if (isTauriContext()) {
      return wrongContextError('getVersionInfo')
    }

    // Check if we're in Electron context
    if (isElectronContext()) {
      return (window as any).api.dataMigration.getVersionInfo()
    }

    // Fallback for development/testing
    return {
      success: false,
      error: 'Data Migration API not available - ensure running in Electron context',
      code: 'DATA_MIGRATION_API_UNAVAILABLE'
    }
  }
} as const

// Type export for use in other modules
/**
 * @deprecated Use MigrationApi from @shared/types/ipc.types instead
 */
export type DataMigrationApi = typeof dataMigrationApi

/**
 * Adapter to convert legacy dataMigrationApi to canonical MigrationApi contract
 *
 * This helper wraps the legacy Electron API to match the canonical contract.
 * Use this when migrating code from the legacy API to the canonical one.
 *
 * @example
 * ```ts
 * import { dataMigrationApi, toCanonicalMigrationApi } from './data-migration-api'
 *
 * const canonicalApi = toCanonicalMigrationApi(dataMigrationApi)
 * const version = await canonicalApi.getVersion()
 * ```
 */
export function toCanonicalMigrationApi(
  legacyApi: typeof dataMigrationApi
): import('@shared/types/ipc.types').MigrationApi {
  return {
    getVersion: async () => {
      const result = await legacyApi.getVersionInfo()
      if (result.success) {
        return { success: true, data: result.data.current }
      }
      return result
    },
    getSchemaInfo: async () => {
      const result = await legacyApi.getVersionInfo()
      return result as IpcResult<{ current: string; target: string }>
    },
    getHistory: legacyApi.getHistory as any,
    getRegistered: async () => {
      const result = await legacyApi.getRegistered()
      if (result.success) {
        // Transform RegisteredMigration to MigrationInfo (drop hasRollback)
        return {
          success: true,
          data: result.data.map(({ version, description }) => ({ version, description }))
        }
      }
      return result as any
    },
    runMigration: async () => {
      const result = await legacyApi.runMigrations()
      if (result.success) {
        return { success: true, data: result.data.results }
      }
      return { success: false, error: result.error, code: result.code }
    },
    rollback: legacyApi.rollback
  }
}
