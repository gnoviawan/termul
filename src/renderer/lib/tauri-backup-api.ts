import type { IpcResult } from '@shared/types/ipc.types'
import { appDataDir } from '@tauri-apps/api/path'
import {
  copyFile,
  type DirEntry,
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile
} from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'
import { logFrontendError } from './log-api'

const LOG_SOURCE = 'tauri-backup-api'

// Cap on skipped paths named in one warning so the log line stays readable.
const MAX_LOGGED_SKIPPED_PATHS = 20

// Backup error codes
export const BackupErrorCodes = {
  BACKUP_FAILED: 'BACKUP_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
  DISK_SPACE_ERROR: 'DISK_SPACE_ERROR',
  INVALID_BACKUP: 'INVALID_BACKUP'
} as const

export type BackupErrorCode = (typeof BackupErrorCodes)[keyof typeof BackupErrorCodes]

// Backup metadata stored in backup-info.json
export interface BackupMetadata {
  id: string // timestamp-based ID
  timestamp: string // ISO timestamp
  version: string // app version
  size: number // total size in bytes
  fileCount: number // number of files backed up
}

// Backup info returned by listBackups
export interface BackupInfo {
  id: string
  timestamp: string
  version: string
  size: number
  fileCount: number
  path: string
}

// Maximum number of backups to keep
const MAX_BACKUPS = 3

/**
 * Top-level userData entries the backup leaves out: its own destination, the
 * rollback store, and data Troupe downloads or rebuilds by itself (agent
 * binaries, registry catalogs, browser profiles and captures). Agent binaries
 * alone can be gigabytes in thousands of files, and copying them one file at a
 * time held the update download at 0% before it started (#1431).
 */
const EXCLUDED_TOP_LEVEL_ENTRIES: ReadonlySet<string> = new Set([
  'backups',
  'versions',
  'acp-registry-binaries',
  'acp-catalog',
  'mcp-catalog',
  'browser-agent-profile',
  'browser-sessions',
  'browser-artifacts'
])

/**
 * Data-lock sidecars (src-tauri/src/data_lock.rs) are held locked while Troupe
 * runs. They carry no data, and on Windows reading a locked file fails, which
 * failed the backup.
 */
const DATA_LOCK_SIDECARS: ReadonlySet<string> = new Set([
  '.termul.lock',
  'store.json.lock',
  'projects.json.lock'
])

function isDataLockSidecar(entry: DirEntry): boolean {
  return entry.isFile && DATA_LOCK_SIDECARS.has(entry.name)
}

// Store file for metadata persistence
const METADATA_STORE_FILE = 'backup-metadata.json'

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Tauri plugin commands reject with plain strings (not Error instances), so a
 * bare `err instanceof Error` check would discard the real reason and report
 * "Unknown error". This normalizes Errors, strings, and serializable objects.
 */
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message
  }
  if (typeof err === 'string' && err.trim()) {
    return err
  }
  try {
    const serialized = JSON.stringify(err)
    if (serialized && serialized !== '{}' && serialized !== 'null') {
      return serialized
    }
  } catch {
    // fall through to fallback
  }
  return fallback
}

/**
 * Get the userData directory (source for backups)
 */
async function getUserDataDir(): Promise<string> {
  return await appDataDir()
}

/**
 * Get the backups directory
 */
async function getBackupsDir(): Promise<string> {
  const userData = await getUserDataDir()
  return `${userData}/backups`
}

/**
 * Get the store for backup metadata
 */
let metadataStore: Store | null = null

async function getMetadataStore(): Promise<Store> {
  if (!metadataStore) {
    metadataStore = await Store.load(METADATA_STORE_FILE, {
      autoSave: false,
      defaults: {}
    })
  }
  return metadataStore
}

/**
 * Validate backup ID to prevent path traversal attacks
 * Only allows alphanumeric characters, dots, hyphens, and underscores
 */
function validateBackupId(backupId: string): boolean {
  // Allow alphanumeric, dots, hyphens, and underscores (timestamp-based IDs)
  const validIdPattern = /^[A-Za-z0-9._-]+$/
  return validIdPattern.test(backupId)
}

/**
 * Get the path to a specific backup directory
 * Validates backupId to prevent path traversal
 */
async function getBackupPath(backupId: string): Promise<string> {
  if (!validateBackupId(backupId)) {
    throw new Error(`Invalid backup ID: ${backupId}`)
  }

  const backupsDir = await getBackupsDir()
  const backupPath = `${backupsDir}/${backupId}`

  // Ensure the resolved path is within the backups directory
  const normalizedPath = backupPath.replace(/\\/g, '/')
  const normalizedBackupsDir = backupsDir.replace(/\\/g, '/')

  if (!normalizedPath.startsWith(normalizedBackupsDir)) {
    throw new Error(`Backup path traversal detected: ${backupId}`)
  }

  return backupPath
}

/**
 * Get the path to backup-info.json for a backup
 */
async function getBackupInfoPath(backupId: string): Promise<string> {
  const backupPath = await getBackupPath(backupId)
  return `${backupPath}/backup-info.json`
}

/**
 * Generate a backup ID from timestamp
 */
function generateBackupId(): string {
  return Date.now().toString()
}

/**
 * Get app version - reads from package.json at build time
 * In Tauri, this is typically set via environment variable or config
 */
async function getAppVersion(): Promise<string> {
  // Try to get from a Tauri command or use a default
  // For now, return 'unknown' - in production this should come from
  // a Tauri command that reads from tauri.conf.json or package.json
  try {
    const store = await getMetadataStore()
    const version = await store.get<string>('app_version')
    return version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Set app version (should be called on app startup)
 */
export async function setAppVersion(version: string): Promise<void> {
  try {
    const store = await getMetadataStore()
    await store.set('app_version', version)
    await store.save()
  } catch {
    // Ignore errors setting version
  }
}

/**
 * Calculate directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await readDir(currentPath)

      for (const entry of entries) {
        const fullPath = `${currentPath}/${entry.name}`

        if (entry.isDirectory ?? false) {
          // It's a directory
          await traverse(fullPath)
        } else {
          // It's a file
          try {
            const fileInfo = await stat(fullPath)
            totalSize += fileInfo.size
          } catch {
            // Skip files that can't be read
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  await traverse(dirPath)
  return totalSize
}

/**
 * Count files in a directory recursively
 */
async function countFiles(dirPath: string): Promise<number> {
  let count = 0

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await readDir(currentPath)

      for (const entry of entries) {
        const fullPath = `${currentPath}/${entry.name}`

        if (entry.isDirectory ?? false) {
          // It's a directory
          await traverse(fullPath)
        } else {
          // It's a file
          count++
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  await traverse(dirPath)
  return count
}

/**
 * Copy one directory entry. Symlinks are never followed: they point outside the
 * copied tree (e.g. Claude account links to the shared `~/.claude` dirs, #1669),
 * so following them could copy unbounded or cyclic data, and Tauri `copyFile`
 * rejects links to directories, which used to abort the whole backup. Links and
 * other non-regular entries (sockets, FIFOs) are recorded in `skipped` instead.
 */
async function copyEntry(
  entry: DirEntry,
  src: string,
  dest: string,
  relPath: string,
  skipped: string[]
): Promise<void> {
  if (entry.isSymlink || !(entry.isDirectory || entry.isFile)) {
    skipped.push(relPath)
    return
  }
  if (isDataLockSidecar(entry)) return
  if (entry.isDirectory) {
    await copyDirectory(src, dest, relPath, skipped)
    return
  }
  await copyFile(src, dest)
}

/**
 * Copy directory recursively, skipping symlinks (see `copyEntry`).
 */
async function copyDirectory(
  src: string,
  dest: string,
  relPath: string,
  skipped: string[]
): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readDir(src)

  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name
    await copyEntry(entry, `${src}/${entry.name}`, `${dest}/${entry.name}`, childRel, skipped)
  }
}

/**
 * Warn about entries left out of a copy. Paths are relative to the copied root
 * so the home directory never reaches the log.
 */
function logSkippedEntries(operation: string, skipped: string[]): void {
  if (skipped.length === 0) return
  const shown = skipped.slice(0, MAX_LOGGED_SKIPPED_PATHS).join(', ')
  const more =
    skipped.length > MAX_LOGGED_SKIPPED_PATHS
      ? ` (+${skipped.length - MAX_LOGGED_SKIPPED_PATHS} more)`
      : ''
  void logFrontendError({
    level: 'warn',
    source: LOG_SOURCE,
    message: `[backup] ${operation}: skipped ${skipped.length} symlink or non-regular entries: ${shown}${more}`
  })
}

/**
 * Create a backup of the userData directory
 * Backs up entire userData to backups/<timestamp>/
 * Stores metadata in backup-info.json
 * Cleans up old backups (keeps only MAX_BACKUPS most recent)
 */
export async function createBackup(): Promise<IpcResult<BackupInfo>> {
  // Tracks the folder this attempt created so a mid-way failure can remove it
  // instead of leaving a partial copy that listBackups/cleanupOldBackups ignore.
  let createdBackupPath: string | null = null

  try {
    const backupId = generateBackupId()
    const backupPath = await getBackupPath(backupId)
    const userDataPath = await getUserDataDir()

    // The backup folder itself is created without `recursive` so mkdir fails
    // when the path already exists (an existing backup, or a link). Only a
    // folder this attempt created may be removed on failure below.
    await mkdir(await getBackupsDir(), { recursive: true })
    await mkdir(backupPath)
    createdBackupPath = backupPath

    const entries = await readDir(userDataPath)
    const skipped: string[] = []

    for (const entry of entries) {
      if (EXCLUDED_TOP_LEVEL_ENTRIES.has(entry.name)) {
        continue
      }

      await copyEntry(
        entry,
        `${userDataPath}/${entry.name}`,
        `${backupPath}/${entry.name}`,
        entry.name,
        skipped
      )
    }
    logSkippedEntries('create', skipped)

    // Calculate backup size
    const size = await getDirectorySize(backupPath)
    const fileCount = await countFiles(backupPath)

    // Create backup metadata
    const metadata: BackupMetadata = {
      id: backupId,
      timestamp: new Date().toISOString(),
      version: await getAppVersion(),
      size,
      fileCount
    }

    // Write backup-info.json
    const infoPath = await getBackupInfoPath(backupId)
    await writeTextFile(infoPath, JSON.stringify(metadata, null, 2))
    // The backup is complete from here on: a later failure (store, retention)
    // must not delete it.
    createdBackupPath = null

    // Store metadata in store for quick access
    const store = await getMetadataStore()
    await store.set(`backup_${backupId}`, metadata)
    await store.save()

    // Clean up old backups
    await cleanupOldBackups()

    const backupInfo: BackupInfo = {
      id: metadata.id,
      timestamp: metadata.timestamp,
      version: metadata.version,
      size: metadata.size,
      fileCount: metadata.fileCount,
      path: backupPath
    }

    return { success: true, data: backupInfo }
  } catch (err) {
    // Check for disk space errors
    const errorMessage = extractErrorMessage(err, 'Unknown error')
    void logFrontendError({
      level: 'error',
      source: LOG_SOURCE,
      message: `[backup] create failed: ${errorMessage}`
    })

    // Remove the partial folder this attempt created. Without backup-info.json
    // listBackups skips it, so cleanupOldBackups would never reclaim it and
    // partial copies would pile up with every failed attempt. Best effort: if
    // the removal also fails, log it and still report the original failure.
    if (createdBackupPath) {
      try {
        await remove(createdBackupPath, { recursive: true })
      } catch (cleanupErr) {
        void logFrontendError({
          level: 'warn',
          source: LOG_SOURCE,
          message: `[backup] failed to remove partial backup folder: ${extractErrorMessage(cleanupErr, 'Unknown error')}`
        })
      }
    }

    if (
      errorMessage.includes('ENOSPC') ||
      errorMessage.includes('disk full') ||
      errorMessage.includes('no space left') ||
      errorMessage.includes('Insufficient')
    ) {
      return {
        success: false,
        error: `Insufficient disk space to create backup: ${errorMessage}`,
        code: BackupErrorCodes.DISK_SPACE_ERROR
      }
    }

    return {
      success: false,
      error: `Failed to create backup: ${errorMessage}`,
      code: BackupErrorCodes.BACKUP_FAILED
    }
  }
}

/**
 * List all available backups
 * Returns backups sorted by timestamp (newest first)
 */
export async function listBackups(): Promise<IpcResult<BackupInfo[]>> {
  try {
    const backupsDir = await getBackupsDir()

    // Ensure backups directory exists
    try {
      await mkdir(backupsDir, { recursive: true })
    } catch {
      // Directory might already exist
    }

    const entries = await readDir(backupsDir)
    const backups: BackupInfo[] = []

    // Also check store for metadata
    const store = await getMetadataStore()

    for (const entry of entries) {
      if (!(entry.isDirectory ?? false)) {
        continue // Skip files, only process directories
      }

      const backupId = entry.name
      const infoPath = await getBackupInfoPath(backupId)

      try {
        const content = await readTextFile(infoPath)
        const metadata = JSON.parse(content) as BackupMetadata

        backups.push({
          id: metadata.id,
          timestamp: metadata.timestamp,
          version: metadata.version,
          size: metadata.size,
          fileCount: metadata.fileCount,
          path: await getBackupPath(backupId)
        })
      } catch {
        // Try to get from store as fallback
        try {
          const metadata = await store.get<BackupMetadata>(`backup_${backupId}`)
          if (metadata) {
            backups.push({
              id: metadata.id,
              timestamp: metadata.timestamp,
              version: metadata.version,
              size: metadata.size,
              fileCount: metadata.fileCount,
              path: await getBackupPath(backupId)
            })
          }
        } catch {}
      }
    }

    // Sort by timestamp, newest first
    backups.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime()
      const timeB = new Date(b.timestamp).getTime()
      return timeB - timeA
    })

    return { success: true, data: backups }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list backups',
      code: BackupErrorCodes.BACKUP_FAILED
    }
  }
}

/**
 * Restore from a backup
 * Copies all files from backup directory to userData atomically
 * Overwrites existing files
 */
export async function restoreBackup(backupId: string): Promise<IpcResult<void>> {
  let tempRestorePath: string | null = null
  let oldUserDataPath: string | null = null

  try {
    const backupPath = await getBackupPath(backupId)
    const infoPath = await getBackupInfoPath(backupId)
    const userDataPath = await getUserDataDir()

    // Check if backup exists and has valid metadata
    try {
      await readTextFile(infoPath)
    } catch {
      return {
        success: false,
        error: `Backup not found or invalid: ${backupId}`,
        code: BackupErrorCodes.BACKUP_NOT_FOUND
      }
    }

    // Create unique paths for atomic restore
    const timestamp = Date.now()
    const randomSuffix = Math.random().toString(36).substring(2, 9)
    const userDataDir = await getUserDataDir()

    // Get parent directory for temp paths
    const parentDir = userDataDir.substring(0, userDataPath.lastIndexOf('/')) || userDataPath

    tempRestorePath = `${parentDir}/temp-restore-${timestamp}-${randomSuffix}`
    oldUserDataPath = `${parentDir}/old-userdata-${timestamp}-${randomSuffix}`

    // Copy backup to temp directory
    const skipped: string[] = []
    await copyDirectory(backupPath, tempRestorePath, '', skipped)
    logSkippedEntries('restore', skipped)

    // Remove backup-info.json from temp restore
    const tempInfoPath = `${tempRestorePath}/backup-info.json`
    try {
      await remove(tempInfoPath)
    } catch {
      // Ignore if file doesn't exist
    }

    // Atomic rename: userData -> old, temp -> userData
    await rename(userDataPath, oldUserDataPath)
    await rename(tempRestorePath, userDataPath)

    // Clean up old userData directory
    try {
      await remove(oldUserDataPath, { recursive: true })
    } catch {
      // Log but don't fail if cleanup fails
      console.warn(`Failed to clean up old userData: ${oldUserDataPath}`)
    }

    return { success: true, data: undefined }
  } catch (err) {
    const errorMessage = extractErrorMessage(err, 'Unknown error')

    // Attempt rollback: detect actual state and restore original data
    if (oldUserDataPath && tempRestorePath) {
      try {
        const userDataPath = await getUserDataDir()

        // Check what actually exists to determine rollback strategy
        const oldExists = await stat(oldUserDataPath)
          .then(() => true)
          .catch(() => false)
        const tempExists = await stat(tempRestorePath)
          .then(() => true)
          .catch(() => false)
        const currentExists = await stat(userDataPath)
          .then(() => true)
          .catch(() => false)

        // If old userData backup exists, restore it
        if (oldExists) {
          // If current userData exists (possibly temp), remove it first
          if (currentExists) {
            await remove(userDataPath, { recursive: true })
          }
          // Rename old userData back to userDataPath
          await rename(oldUserDataPath, userDataPath)
        }

        // Clean up temp restore path if it still exists
        if (tempExists) {
          await remove(tempRestorePath, { recursive: true })
        }
      } catch (rollbackError) {
        console.error('Failed to rollback restore operation:', rollbackError)
      }
    }

    if (
      errorMessage.includes('ENOSPC') ||
      errorMessage.includes('disk full') ||
      errorMessage.includes('no space left') ||
      errorMessage.includes('Insufficient')
    ) {
      return {
        success: false,
        error: `Insufficient disk space to restore backup: ${errorMessage}`,
        code: BackupErrorCodes.DISK_SPACE_ERROR
      }
    }

    return {
      success: false,
      error: `Failed to restore backup: ${errorMessage}`,
      code: BackupErrorCodes.RESTORE_FAILED
    }
  }
}

/**
 * Clean up old backups, keeping only MAX_BACKUPS most recent
 * Should be called after creating a new backup
 */
export async function cleanupOldBackups(): Promise<IpcResult<void>> {
  try {
    const result = await listBackups()

    if (!result.success) {
      return result
    }

    const backups = result.data

    // Keep only MAX_BACKUPS most recent backups
    if (backups.length <= MAX_BACKUPS) {
      return { success: true, data: undefined }
    }

    // Delete old backups
    const toDelete = backups.slice(MAX_BACKUPS)
    const store = await getMetadataStore()

    for (const backup of toDelete) {
      try {
        await remove(backup.path, { recursive: true })
        // Also remove from store
        await store.delete(`backup_${backup.id}`)
      } catch {
        // Log but continue if deletion fails
        console.warn(`Failed to delete old backup: ${backup.id}`)
      }
    }

    // Save store after deletions
    await store.save()

    return { success: true, data: undefined }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cleanup old backups',
      code: BackupErrorCodes.BACKUP_FAILED
    }
  }
}

/**
 * @internal Testing only - reset module state
 */
export function _resetBackupStateForTesting() {
  metadataStore = null
}

/**
 * Create a backup API object for consistency with other APIs
 */
export const tauriBackupApi = {
  createBackup,
  listBackups,
  restoreBackup,
  cleanupOldBackups,
  setAppVersion
}

/**
 * Factory function for consistency with other APIs
 */
export function createTauriBackupApi() {
  return tauriBackupApi
}
