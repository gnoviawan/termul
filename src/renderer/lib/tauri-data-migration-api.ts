/**
 * Tauri Data Migration API Implementation
 *
 * Implements the canonical MigrationApi contract for Tauri builds.
 * All methods align with the shared IPC contract defined in ipc.types.ts.
 *
 * @see MigrationApi - The canonical interface this implements
 */

import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import type {
  IpcResult,
  MigrationApi,
  MigrationRecord,
  MigrationResult,
  MigrationRunResult,
  SchemaVersion,
  MigrationInfo,
  RollbackRequest
} from '@shared/types/ipc.types'

// Re-export types from the canonical contract for convenience
export type {
  MigrationRecord,
  MigrationResult,
  MigrationRunResult,
  SchemaVersion,
  MigrationInfo,
  RollbackRequest
}

// Migration error codes (aligned with canonical contract)
export const MigrationErrorCodes = {
  MIGRATION_VERSION_INVALID: 'MIGRATION_VERSION_INVALID',
  MIGRATION_HISTORY_CORRUPT: 'MIGRATION_HISTORY_CORRUPT',
  MIGRATION_EXECUTION_FAILED: 'MIGRATION_EXECUTION_FAILED',
  MIGRATION_ALREADY_RUNNING: 'MIGRATION_ALREADY_RUNNING',
  MIGRATION_NOT_FOUND: 'MIGRATION_NOT_FOUND',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED'
} as const

export type MigrationErrorCode =
  (typeof MigrationErrorCodes)[keyof typeof MigrationErrorCodes]

/**
 * IPC Command names for data migration
 *
 * These MUST match the Tauri command definitions in the Rust backend
 * (src-tauri/src/commands.rs). The naming convention is:
 * - Prefix: data_migration_
 * - snake_case for command names (Rust convention)
 */
const IPC_COMMANDS = {
  GET_VERSION: 'data_migration_get_version',
  GET_SCHEMA_INFO: 'data_migration_get_schema_info',
  GET_HISTORY: 'data_migration_get_history',
  GET_REGISTERED: 'data_migration_get_registered',
  RUN_MIGRATIONS: 'data_migration_run_migrations',
  ROLLBACK: 'data_migration_rollback'
} as const

/**
 * Invoke Tauri IPC commands that return IpcResult<T> from Rust.
 *
 * This wrapper handles invoke errors and converts them to IpcResult format.
 */
async function invokeIpc<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR'
    }
  }
}

/**
 * Create a Data Migration API implementation using Tauri IPC
 *
 * This adapter provides data migration operations for the Tauri build.
 * It implements the canonical MigrationApi contract from ipc.types.ts.
 *
 * Usage on app startup:
 * ```ts
 * const migrationApi = createTauriDataMigrationApi()
 *
 * // Get current schema version
 * const versionResult = await migrationApi.getVersion()
 * if (versionResult.success) {
 *   console.log('Current version:', versionResult.data)
 * }
 *
 * // Check if migrations are needed
 * const schemaInfo = await migrationApi.getSchemaInfo()
 * if (schemaInfo.success && schemaInfo.data.current !== schemaInfo.data.target) {
 *   // Run pending migrations
 *   const result = await migrationApi.runMigration()
 *
 *   if (!result.success) {
 *     console.error('Migration failed:', result.error)
 *   }
 * }
 * ```
 *
 * @returns An object implementing the MigrationApi interface
 */
export function createTauriDataMigrationApi(): MigrationApi {
  return {
    /**
     * Get current schema version
     *
     * Returns '0.0.0' for fresh installs (no migrations run yet).
     *
     * @implements MigrationApi.getVersion
     */
    async getVersion(): Promise<IpcResult<string>> {
      return invokeIpc<string>(IPC_COMMANDS.GET_VERSION)
    },

    /**
     * Get schema version info (current and target versions)
     *
     * Useful for checking if migrations are needed.
     * If current !== target, migrations are pending.
     *
     * @implements MigrationApi.getSchemaInfo
     */
    async getSchemaInfo(): Promise<IpcResult<SchemaVersion>> {
      return invokeIpc<SchemaVersion>(IPC_COMMANDS.GET_SCHEMA_INFO)
    },

    /**
     * Get migration history
     *
     * Returns array of all migration records (successful and failed).
     * Useful for debugging and displaying migration status to users.
     *
     * @implements MigrationApi.getHistory
     */
    async getHistory(): Promise<IpcResult<MigrationRecord[]>> {
      return invokeIpc<MigrationRecord[]>(IPC_COMMANDS.GET_HISTORY)
    },

    /**
     * Get all registered migrations
     *
     * Returns info about available migrations without running them.
     * Useful for displaying available/pending migrations to users.
     *
     * @implements MigrationApi.getRegistered
     */
    async getRegistered(): Promise<IpcResult<MigrationInfo[]>> {
      return invokeIpc<MigrationInfo[]>(IPC_COMMANDS.GET_REGISTERED)
    },

    /**
     * Run all pending migrations
     *
     * Executes migrations from current version to latest registered version.
     *
     * Returns:
     * - success: true with array of migration results
     * - success: false with error code and partial results if any migration failed
     *
     * Error codes:
     * - MIGRATION_VERSION_INVALID: Current version is corrupted
     * - MIGRATION_HISTORY_CORRUPT: Migration history is corrupted
     * - MIGRATION_EXECUTION_FAILED: A migration function failed
     * - MIGRATION_ALREADY_RUNNING: Another migration is in progress
     *
     * @implements MigrationApi.runMigration
     */
    async runMigration(): Promise<MigrationRunResult> {
      // Note: Backend returns IpcResult<MigrationResult[]>, but we transform it
      // to MigrationRunResult to preserve partial results on failure
      return invoke<IpcResult<MigrationResult[]>>(IPC_COMMANDS.RUN_MIGRATIONS)
        .then((result): MigrationRunResult => {
          if (result.success) {
            return { success: true, data: result.data ?? [] }
          }
          // Backend may include partialResults on failure
          const extendedResult = result as IpcResult<MigrationResult[]> & {
            partialResults?: MigrationResult[]
          }
          return {
            success: false,
            error: result.error ?? 'Unknown migration error',
            code: result.code ?? MigrationErrorCodes.MIGRATION_EXECUTION_FAILED,
            partialResults: extendedResult.partialResults
          }
        })
        .catch((error): MigrationRunResult => ({
          success: false,
          error: error instanceof Error ? error.message : String(error),
          code: MigrationErrorCodes.MIGRATION_EXECUTION_FAILED
        }))
    },

    /**
     * Rollback to a specific version
     *
     * Requires the migration to have a rollback function registered.
     *
     * IMPORTANT: Tauri command parameter handling:
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
     * With RollbackRequest defined as:
     * ```rust
     * #[derive(Debug, Clone, Deserialize)]
     * #[serde(rename_all = "camelCase")]
     * pub struct RollbackRequest {
     *     pub version: String,
     * }
     * ```
     *
     * Tauri automatically flattens single-struct parameters, so we pass
     * the struct fields directly: { version } rather than { request: { version } }
     *
     * Error codes:
     * - MIGRATION_NOT_FOUND: Requested migration version not found
     * - ROLLBACK_FAILED: Rollback function failed or not available
     *
     * @param version - Version to rollback to (e.g., "1.2.0")
     * @implements MigrationApi.rollback
     */
    async rollback(version: string): Promise<IpcResult<void>> {
      // Tauri flattens single-struct parameters, so we pass fields directly
      return invokeIpc<void>(IPC_COMMANDS.ROLLBACK, { version })
    }
  }
}

/**
 * Type assertion to ensure the implementation matches the canonical contract.
 * This will cause a compile-time error if the implementation drifts.
 */
const _assertImplementation: MigrationApi = createTauriDataMigrationApi()
