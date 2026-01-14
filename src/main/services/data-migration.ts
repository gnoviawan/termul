import { read, write } from './persistence-service'
import type { IpcResult } from '../../shared/types/ipc.types'

// Migration error codes
export const MigrationErrorCodes = {
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',
  VERSION_READ_FAILED: 'VERSION_READ_FAILED',
  VERSION_WRITE_FAILED: 'VERSION_WRITE_FAILED',
  INVALID_VERSION: 'INVALID_VERSION',
  ALREADY_MIGRATED: 'ALREADY_MIGRATED',
  MIGRATION_NOT_FOUND: 'MIGRATION_NOT_FOUND',
  HISTORY_READ_FAILED: 'HISTORY_READ_FAILED',
  HISTORY_WRITE_FAILED: 'HISTORY_WRITE_FAILED'
} as const

export type MigrationErrorCode =
  (typeof MigrationErrorCodes)[keyof typeof MigrationErrorCodes]

// Migration function signature
export type MigrationFunction = () => Promise<IpcResult<void>>

// Migration record in history
export interface MigrationRecord {
  version: string
  timestamp: string
  success: boolean
  error?: string
  duration?: number // in milliseconds
}

// Migration registry entry
export interface MigrationEntry {
  version: string
  description: string
  migrationFn: MigrationFunction
  rollbackFn?: () => Promise<IpcResult<void>>
}

// Migration result
export interface MigrationResult {
  version: string
  success: boolean
  error?: string
  duration: number
}

// Migration run result (can include partial results on failure)
export type MigrationRunResult = IpcResult<MigrationResult[]> & {
  data?: MigrationResult[]
}

// Schema version info
export interface SchemaVersion {
  current: string
  target: string
}

// Storage keys
const SCHEMA_VERSION_KEY = 'settings/schema-version'
const MIGRATION_HISTORY_KEY = 'settings/migration-history.json'

// Initial schema version (when no migrations have been run)
const INITIAL_SCHEMA_VERSION = '0.0.0'

// Singleton instance
let migrationServiceInstance: DataMigrationService | null = null

/**
 * Data Migration Service - Manages data schema migrations
 *
 * Features:
 * - Versioned schema support
 * - Migration function registry
 * - Automatic migration on update
 * - Rollback capability
 * - Migration history tracking
 * - Transaction-safe migrations
 *
 * Usage:
 * 1. Register migrations with registerMigration()
 * 2. Call runMigrations() on app startup
 * 3. Migrations run automatically based on version comparison
 */
export class DataMigrationService {
  private migrations: Map<string, MigrationEntry> = new Map()
  private history: MigrationRecord[] = []
  private isRunning = false
  private initialized = false

  constructor() {
    // Load history asynchronously - initialization completes in the background
    this.initialize().catch((error) => {
      console.warn('Failed to initialize migration service:', error)
    })
  }

  /**
   * Initialize the service by loading migration history
   * Called automatically in constructor, but can be called explicitly
   * to ensure initialization is complete before operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }
    await this.loadHistory()
    this.initialized = true
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): DataMigrationService {
    if (!migrationServiceInstance) {
      migrationServiceInstance = new DataMigrationService()
    }
    return migrationServiceInstance
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance(): void {
    migrationServiceInstance = null
  }

  /**
   * Get current schema version from storage
   * Returns '0.0.0' if no version has been set (fresh install)
   */
  async getCurrentSchemaVersion(): Promise<IpcResult<string>> {
    try {
      const result = await read<string>(SCHEMA_VERSION_KEY)

      if (!result.success) {
        // Fresh install - no schema version set yet
        return { success: true, data: INITIAL_SCHEMA_VERSION }
      }

      const version = result.data
      if (!version || typeof version !== 'string') {
        return {
          success: false,
          error: 'Invalid schema version format',
          code: MigrationErrorCodes.INVALID_VERSION
        }
      }

      return { success: true, data: version }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read schema version',
        code: MigrationErrorCodes.VERSION_READ_FAILED
      }
    }
  }

  /**
   * Set schema version after successful migration
   */
  async setSchemaVersion(version: string): Promise<IpcResult<void>> {
    if (!version || typeof version !== 'string') {
      return {
        success: false,
        error: 'Invalid version format',
        code: MigrationErrorCodes.INVALID_VERSION
      }
    }

    try {
      const result = await write(SCHEMA_VERSION_KEY, version)

      if (!result.success) {
        const errorResult = result as { success: false; error: string; code: string }
        return {
          success: false,
          error: errorResult.error,
          code: MigrationErrorCodes.VERSION_WRITE_FAILED
        }
      }

      return { success: true, data: undefined }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write schema version',
        code: MigrationErrorCodes.VERSION_WRITE_FAILED
      }
    }
  }

  /**
   * Register a migration function for a specific version
   *
   * @param version - Target version for this migration
   * @param description - Human-readable description of the migration
   * @param migrationFn - Function to execute the migration
   * @param rollbackFn - Optional function to rollback the migration
   */
  registerMigration(
    version: string,
    description: string,
    migrationFn: MigrationFunction,
    rollbackFn?: () => Promise<IpcResult<void>>
  ): IpcResult<void> {
    if (!version || typeof version !== 'string') {
      return {
        success: false,
        error: 'Invalid version format',
        code: MigrationErrorCodes.INVALID_VERSION
      }
    }

    if (typeof migrationFn !== 'function') {
      return {
        success: false,
        error: 'Migration function must be a function',
        code: MigrationErrorCodes.MIGRATION_FAILED
      }
    }

    if (this.migrations.has(version)) {
      console.warn(`Migration for version ${version} already registered, overwriting`)
    }

    this.migrations.set(version, {
      version,
      description,
      migrationFn,
      rollbackFn
    })

    return { success: true, data: undefined }
  }

  /**
   * Run all pending migrations
   * Migrates from current version to the latest registered version
   *
   * @returns Result with array of migration results (may include partial results on failure)
   */
  async runMigrations(): Promise<MigrationRunResult> {
    if (this.isRunning) {
      return {
        success: false,
        error: 'Migration already in progress',
        code: MigrationErrorCodes.ALREADY_MIGRATED
      }
    }

    this.isRunning = true

    try {
      // Get current version
      const versionResult = await this.getCurrentSchemaVersion()

      if (!versionResult.success) {
        this.isRunning = false
        const errorResult = versionResult as { success: false; error: string; code: string }
        return {
          success: false,
          error: `Failed to get current version: ${errorResult.error}`,
          code: MigrationErrorCodes.VERSION_READ_FAILED
        }
      }

      const currentVersion = versionResult.data

      // Get sorted list of registered migrations
      const sortedMigrations = this.getSortedMigrations()

      // Find pending migrations (versions greater than current)
      const pendingMigrations = sortedMigrations.filter(
        (entry) => this.compareVersions(entry.version, currentVersion) > 0
      )

      if (pendingMigrations.length === 0) {
        this.isRunning = false
        return { success: true, data: [] }
      }

      // Run migrations sequentially
      const results: MigrationResult[] = []

      for (const entry of pendingMigrations) {
        const startTime = Date.now()

        // Check if already migrated
        const alreadyMigrated = this.history.some(
          (record) => record.version === entry.version && record.success
        )

        if (alreadyMigrated) {
          console.log(`Migration ${entry.version} already applied, skipping`)
          continue
        }

        console.log(`Running migration ${entry.version}: ${entry.description}`)

        // Execute migration
        const result = await entry.migrationFn()
        const duration = Date.now() - startTime

        const migrationResult: MigrationResult = {
          version: entry.version,
          success: result.success,
          error: result.success ? undefined : (result as { success: false; error: string; code: string }).error,
          duration
        }

        results.push(migrationResult)

        // Record in history
        await this.recordMigration({
          version: entry.version,
          timestamp: new Date().toISOString(),
          success: result.success,
          error: result.success ? undefined : (result as { success: false; error: string; code: string }).error,
          duration
        })

        // Stop if migration failed
        if (!result.success) {
          this.isRunning = false
          const errorResult = result as { success: false; error: string; code: string }
          return {
            success: false,
            error: `Migration ${entry.version} failed: ${errorResult.error}`,
            code: MigrationErrorCodes.MIGRATION_FAILED,
            data: results
          }
        }

        // Update schema version
        const setVersionResult = await this.setSchemaVersion(entry.version)

        if (!setVersionResult.success) {
          this.isRunning = false
          const errorResult = setVersionResult as { success: false; error: string; code: string }
          return {
            success: false,
            error: `Failed to update schema version: ${errorResult.error}`,
            code: MigrationErrorCodes.VERSION_WRITE_FAILED
          }
        }

        console.log(`Migration ${entry.version} completed successfully in ${duration}ms`)
      }

      this.isRunning = false
      return { success: true, data: results }
    } catch (error) {
      this.isRunning = false
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown migration error',
        code: MigrationErrorCodes.MIGRATION_FAILED
      }
    }
  }

  /**
   * Rollback a specific migration
   * Requires the migration to have a rollback function registered
   *
   * @param version - Version to rollback
   */
  async rollbackMigration(version: string): Promise<IpcResult<void>> {
    const entry = this.migrations.get(version)

    if (!entry) {
      return {
        success: false,
        error: `Migration ${version} not found`,
        code: MigrationErrorCodes.MIGRATION_NOT_FOUND
      }
    }

    if (!entry.rollbackFn) {
      return {
        success: false,
        error: `Migration ${version} does not have a rollback function`,
        code: MigrationErrorCodes.ROLLBACK_FAILED
      }
    }

    console.log(`Rolling back migration ${version}`)

    const result = await entry.rollbackFn()

    if (!result.success) {
      const errorResult = result as { success: false; error: string; code: string }
      return {
        success: false,
        error: `Rollback failed: ${errorResult.error}`,
        code: MigrationErrorCodes.ROLLBACK_FAILED
      }
    }

    // Record rollback in history
    await this.recordMigration({
      version,
      timestamp: new Date().toISOString(),
      success: true,
      error: 'Rollback successful'
    })

    // Revert schema version to previous version
    const sortedMigrations = this.getSortedMigrations()
    const versionIndex = sortedMigrations.findIndex((e) => e.version === version)

    let previousVersion = INITIAL_SCHEMA_VERSION
    if (versionIndex > 0) {
      previousVersion = sortedMigrations[versionIndex - 1].version
    }

    const setVersionResult = await this.setSchemaVersion(previousVersion)
    if (!setVersionResult.success) {
      const errorResult = setVersionResult as { success: false; error: string; code: string }
      return {
        success: false,
        error: `Failed to revert schema version: ${errorResult.error}`,
        code: MigrationErrorCodes.VERSION_WRITE_FAILED
      }
    }

    console.log(`Rolled back to version ${previousVersion}`)

    return { success: true, data: undefined }
  }

  /**
   * Get migration history
   */
  async getMigrationHistory(): Promise<IpcResult<MigrationRecord[]>> {
    try {
      // Reload history from storage to get latest
      await this.loadHistory()
      return { success: true, data: [...this.history] }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read migration history',
        code: MigrationErrorCodes.HISTORY_READ_FAILED
      }
    }
  }

  /**
   * Get all registered migrations
   */
  getRegisteredMigrations(): MigrationEntry[] {
    return Array.from(this.migrations.values()).sort((a, b) =>
      this.compareVersions(a.version, b.version)
    )
  }

  /**
   * Get schema version info (current and target versions)
   */
  async getSchemaVersionInfo(): Promise<IpcResult<SchemaVersion>> {
    const currentResult = await this.getCurrentSchemaVersion()

    if (!currentResult.success) {
      const errorResult = currentResult as { success: false; error: string; code: string }
      return {
        success: false,
        error: errorResult.error,
        code: MigrationErrorCodes.VERSION_READ_FAILED
      }
    }

    const sortedMigrations = this.getSortedMigrations()
    const targetVersion =
      sortedMigrations.length > 0
        ? sortedMigrations[sortedMigrations.length - 1].version
        : INITIAL_SCHEMA_VERSION

    return {
      success: true,
      data: {
        current: currentResult.data,
        target: targetVersion
      }
    }
  }

  /**
   * Load migration history from storage
   */
  private async loadHistory(): Promise<void> {
    try {
      const result = await read<MigrationRecord[]>(MIGRATION_HISTORY_KEY)

      if (result.success && Array.isArray(result.data)) {
        this.history = result.data
      } else {
        // Initialize empty history
        this.history = []
      }
    } catch (error) {
      console.warn('Failed to load migration history:', error)
      this.history = []
    }
  }

  /**
   * Record a migration in history
   */
  private async recordMigration(record: MigrationRecord): Promise<void> {
    this.history.push(record)

    try {
      await write(MIGRATION_HISTORY_KEY, this.history)
    } catch (error) {
      console.error('Failed to save migration history:', error)
    }
  }

  /**
   * Get migrations sorted by version (ascending)
   */
  private getSortedMigrations(): MigrationEntry[] {
    return Array.from(this.migrations.values()).sort((a, b) =>
      this.compareVersions(a.version, b.version)
    )
  }

  /**
   * Compare two version strings
   * Returns: -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
   *
   * Handles numeric version parts (e.g., "1.2.3") and treats non-numeric
   * parts (e.g., "beta", "rc") as less than numeric parts.
   */
  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.')
    const parts2 = v2.split('.')

    const maxLength = Math.max(parts1.length, parts2.length)

    for (let i = 0; i < maxLength; i++) {
      const part1 = parts1[i] ?? '0'
      const part2 = parts2[i] ?? '0'

      const num1 = parseInt(part1, 10)
      const num2 = parseInt(part2, 10)

      // If both parts are numeric, compare numerically
      if (!isNaN(num1) && !isNaN(num2)) {
        if (num1 < num2) return -1
        if (num1 > num2) return 1
      } else {
        // If either part is non-numeric, compare as strings
        // Non-numeric parts (e.g., "beta", "rc") are considered less than numeric
        const strCmp = part1.localeCompare(part2)
        if (strCmp !== 0) return strCmp
      }
    }

    return 0
  }
}

/**
 * Get the default migration service instance
 */
export function getDataMigrationService(): DataMigrationService {
  return DataMigrationService.getInstance()
}

/**
 * Reset the migration service instance
 */
export function resetDataMigrationService(): void {
  DataMigrationService.resetInstance()
}
