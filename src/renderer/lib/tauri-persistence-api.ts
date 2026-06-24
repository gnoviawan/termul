import type { IpcResult } from '@shared/types/ipc.types'
import { Store } from '@tauri-apps/plugin-store'

const STORE_FILE = 'termul-data.json'
const DEBOUNCE_MS = 500
const CURRENT_VERSION = 1
const SCHEMA_VERSION_KEY = '_schema_version'

interface PersistedStore<T> {
  _version: number
  data: T
}

// ==================== Migration System ====================

export interface Migration {
  fromVersion: number
  toVersion: number
  migrate: () => Promise<IpcResult<void>>
}

interface MigrationRegistry {
  [key: string]: Migration
}

const migrationRegistry: MigrationRegistry = {}

function migrationKey(fromVersion: number, toVersion: number): string {
  return `${fromVersion}->${toVersion}`
}

type PendingWriteResolver = (result: IpcResult<void>) => void

interface PendingDebounceEntry<T = unknown> {
  timer: ReturnType<typeof setTimeout> | null
  data: T
  resolvers: PendingWriteResolver[]
  activeWrite: Promise<IpcResult<void>> | null
}

let storeInstance: Store | null = null
const pendingDebounce = new Map<string, PendingDebounceEntry>()

function createSuccessResult(): IpcResult<void> {
  return { success: true, data: undefined }
}

function resolvePendingResolvers(resolvers: PendingWriteResolver[], result: IpcResult<void>): void {
  resolvers.forEach((resolve) => {
    resolve(result)
  })
}

async function getStore(): Promise<Store> {
  if (!storeInstance) {
    storeInstance = await Store.load(STORE_FILE, { autoSave: false, defaults: {} })
  }
  return storeInstance
}

async function persistVersionedData<T>(key: string, data: T): Promise<IpcResult<void>> {
  try {
    const store = await getStore()
    const versioned: PersistedStore<T> = { _version: CURRENT_VERSION, data }
    await store.set(key, versioned)
    await store.save()
    return createSuccessResult()
  } catch (err) {
    return { success: false, error: String(err), code: 'WRITE_ERROR' }
  }
}

function schedulePendingWrite(key: string, entry: PendingDebounceEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer)
  }

  entry.timer = setTimeout(() => {
    entry.timer = null
    void flushPendingEntry(key, entry)
  }, DEBOUNCE_MS)
}

async function flushPendingEntry(
  key: string,
  entry: PendingDebounceEntry
): Promise<IpcResult<void>> {
  if (entry.activeWrite) {
    const activeWriteResult = await entry.activeWrite

    if (entry.resolvers.length === 0) {
      if (entry.timer === null) {
        pendingDebounce.delete(key)
      }

      return activeWriteResult
    }
  }

  if (entry.resolvers.length === 0) {
    if (entry.timer === null && entry.activeWrite === null) {
      pendingDebounce.delete(key)
    }

    return createSuccessResult()
  }

  const dataToWrite = entry.data
  const resolvers = [...entry.resolvers]
  entry.resolvers = []

  const writePromise = persistVersionedData(key, dataToWrite)
    .then((result) => {
      resolvePendingResolvers(resolvers, result)
      return result
    })
    .finally(() => {
      entry.activeWrite = null

      if (entry.resolvers.length === 0 && entry.timer === null) {
        pendingDebounce.delete(key)
      }
    })

  entry.activeWrite = writePromise
  return writePromise
}

export const tauriPersistenceApi = {
  async read<T>(key: string): Promise<IpcResult<T>> {
    try {
      const store = await getStore()
      const raw = await store.get<PersistedStore<T> | T>(key)

      if (raw === null || raw === undefined) {
        return { success: false, error: `Key not found: ${key}`, code: 'KEY_NOT_FOUND' }
      }

      // Handle versioned data
      if (typeof raw === 'object' && raw !== null && '_version' in raw) {
        const versioned = raw as PersistedStore<T>
        return { success: true, data: versioned.data }
      }

      // Legacy data without version
      return { success: true, data: raw as T }
    } catch (err) {
      return { success: false, error: String(err), code: 'READ_ERROR' }
    }
  },

  async write<T>(key: string, data: T): Promise<IpcResult<void>> {
    return persistVersionedData(key, data)
  },

  async writeDebounced<T>(key: string, data: T): Promise<IpcResult<void>> {
    return new Promise((resolve) => {
      const existing = pendingDebounce.get(key)

      if (existing) {
        existing.data = data
        existing.resolvers.push(resolve)
        schedulePendingWrite(key, existing)
        return
      }

      const entry: PendingDebounceEntry<T> = {
        timer: null,
        data,
        resolvers: [resolve],
        activeWrite: null
      }

      pendingDebounce.set(key, entry)
      schedulePendingWrite(key, entry)
    })
  },

  async remove(key: string): Promise<IpcResult<void>> {
    try {
      const store = await getStore()
      await store.delete(key)
      await store.save()
      return createSuccessResult()
    } catch (err) {
      return { success: false, error: String(err), code: 'DELETE_ERROR' }
    }
  },

  // Alias for remove - matches PersistenceApi interface
  async delete(key: string): Promise<IpcResult<void>> {
    return this.remove(key)
  },

  async flushPendingWrites(): Promise<IpcResult<void>> {
    let firstFailure: IpcResult<void> | null = null

    for (const [key, entry] of Array.from(pendingDebounce.entries())) {
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }

      const result = await flushPendingEntry(key, entry)
      if (!result.success && firstFailure === null) {
        firstFailure = result
      }
    }

    return firstFailure ?? createSuccessResult()
  }
}

/**
 * Factory function for consistency with other APIs
 */
export function createTauriPersistenceApi() {
  return tauriPersistenceApi
}

/**
 * @internal Testing only - reset the singleton store instance
 */
export function _resetStoreInstanceForTesting() {
  storeInstance = null

  for (const entry of pendingDebounce.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
  }

  pendingDebounce.clear()

  // Clear migration registry
  for (const key in migrationRegistry) {
    delete migrationRegistry[key]
  }
}

// ==================== Migration API ====================

/**
 * Get the current schema version from the store.
 * Returns 1 for fresh installs with no stored data.
 */
export async function getCurrentSchemaVersion(): Promise<IpcResult<number>> {
  try {
    const store = await getStore()
    const version = await store.get<number>(SCHEMA_VERSION_KEY)

    if (version === null || version === undefined) {
      return { success: true, data: 1 } // Fresh install defaults to v1
    }

    return { success: true, data: version }
  } catch (err) {
    return { success: false, error: String(err), code: 'VERSION_READ_ERROR' }
  }
}

/**
 * Register a migration from one version to another.
 * Migrations are executed in order when runMigrations() is called.
 *
 * Graph validation rules:
 * - Migrations must be strictly forward-moving (toVersion > fromVersion)
 * - Only one migration per fromVersion allowed (no branching)
 * - No duplicate migration paths
 */
export function registerMigration(migration: Migration): IpcResult<void> {
  const key = migrationKey(migration.fromVersion, migration.toVersion)

  // Check for duplicate migration path
  if (migrationRegistry[key]) {
    return {
      success: false,
      error: `Migration ${key} is already registered`,
      code: 'MIGRATION_ALREADY_REGISTERED'
    }
  }

  // Validate migration is forward-moving
  if (migration.toVersion <= migration.fromVersion) {
    return {
      success: false,
      error: `Migration must be forward-moving: toVersion (${migration.toVersion}) must be greater than fromVersion (${migration.fromVersion})`,
      code: 'MIGRATION_NOT_FORWARD'
    }
  }

  // Check for conflicting migrations from the same fromVersion
  for (const existingKey in migrationRegistry) {
    const existing = migrationRegistry[existingKey]
    if (
      existing.fromVersion === migration.fromVersion &&
      existing.toVersion !== migration.toVersion
    ) {
      return {
        success: false,
        error: `Conflicting migration: fromVersion ${migration.fromVersion} already has a migration to version ${existing.toVersion}. Cannot add migration to version ${migration.toVersion}. Only one migration path per version is allowed.`,
        code: 'MIGRATION_GRAPH_CONFLICT'
      }
    }
  }

  migrationRegistry[key] = migration
  return { success: true, data: undefined }
}

/**
 * Migration run result with partial results support.
 * Returns successful migrations even when the chain is interrupted.
 */
export type MigrationRunResult =
  | { success: true; data: Array<{ fromVersion: number; toVersion: number; success: boolean }> }
  | {
      success: false
      error: string
      code: string
      /** Migrations that succeeded before the failure */
      partialResults?: Array<{ fromVersion: number; toVersion: number; success: boolean }>
    }

/**
 * Run all pending migrations from current version to the latest registered version.
 * Returns a list of migration results showing which migrations ran and their outcomes.
 *
 * When a migration fails, returns partialResults containing migrations that succeeded
 * before the failure occurred.
 */
export async function runMigrations(): Promise<MigrationRunResult> {
  try {
    const versionResult = await getCurrentSchemaVersion()
    if (!versionResult.success) {
      return { success: false, error: versionResult.error, code: versionResult.code }
    }

    let currentVersion = versionResult.data!
    const results: Array<{ fromVersion: number; toVersion: number; success: boolean }> = []

    // Find the highest registered version
    const allVersions = new Set<number>()
    for (const key in migrationRegistry) {
      const migration = migrationRegistry[key]
      allVersions.add(migration.fromVersion)
      allVersions.add(migration.toVersion)
    }

    if (allVersions.size === 0) {
      // No migrations registered
      return { success: true, data: [] }
    }

    const targetVersion = Math.max(...Array.from(allVersions))

    // Run migrations sequentially from current version to target
    while (currentVersion < targetVersion) {
      let migrationFound = false

      // Look for a migration from currentVersion
      for (const key in migrationRegistry) {
        const migration = migrationRegistry[key]

        if (migration.fromVersion === currentVersion) {
          migrationFound = true

          // Execute the migration
          const migrateResult = await migration.migrate()

          if (!migrateResult.success) {
            // Migration failed - stop the chain
            results.push({
              fromVersion: migration.fromVersion,
              toVersion: migration.toVersion,
              success: false
            })

            return {
              success: false,
              error: migrateResult.error || 'Migration failed',
              code: migrateResult.code || 'MIGRATION_FAILED',
              partialResults: results
            }
          }

          // Migration succeeded - update version
          const store = await getStore()
          await store.set(SCHEMA_VERSION_KEY, migration.toVersion)
          await store.save()

          currentVersion = migration.toVersion

          results.push({
            fromVersion: migration.fromVersion,
            toVersion: migration.toVersion,
            success: true
          })

          break
        }
      }

      if (!migrationFound) {
        // No migration path found from current version - this is a failure
        return {
          success: false,
          error: `No migration path found from version ${currentVersion} to ${targetVersion}`,
          code: 'MIGRATION_PATH_NOT_FOUND',
          partialResults: results
        }
      }
    }

    return { success: true, data: results }
  } catch (err) {
    return { success: false, error: String(err), code: 'MIGRATION_ERROR' }
  }
}
