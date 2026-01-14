import { app } from 'electron'
import { join, dirname } from 'path'
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  cp,
  rm
} from 'fs/promises'
import type { IpcResult } from '../../shared/types/ipc.types'

// Backup error codes
export const BackupErrorCodes = {
  BACKUP_FAILED: 'BACKUP_FAILED',
  RESTORE_FAILED: 'RESTORE_FAILED',
  BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
  DISK_SPACE_ERROR: 'DISK_SPACE_ERROR',
  INVALID_BACKUP: 'INVALID_BACKUP'
} as const

export type BackupErrorCode =
  (typeof BackupErrorCodes)[keyof typeof BackupErrorCodes]

// Backup metadata stored in backup-info.json
export interface BackupMetadata {
  id: string // timestamp-based ID
  timestamp: string // ISO timestamp
  version: string // app version from package.json
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
 * Get the userData directory (source for backups)
 */
function getUserDataDir(): string {
  return app.getPath('userData')
}

/**
 * Get the backups directory
 */
function getBackupsDir(): string {
  const userData = getUserDataDir()
  return join(userData, 'backups')
}

/**
 * Get the path to a specific backup directory
 */
function getBackupPath(backupId: string): string {
  return join(getBackupsDir(), backupId)
}

/**
 * Get the path to backup-info.json for a backup
 */
function getBackupInfoPath(backupId: string): string {
  return join(getBackupPath(backupId), 'backup-info.json')
}

/**
 * Generate a backup ID from timestamp
 */
function generateBackupId(): string {
  return Date.now().toString()
}

/**
 * Get app version from package.json
 */
async function getAppVersion(): Promise<string> {
  try {
    const packagePath = join(process.cwd(), 'package.json')
    const content = await readFile(packagePath, 'utf-8')
    const pkg = JSON.parse(content)
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Calculate directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0
  let fileCount = 0

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name)

        if (entry.isDirectory()) {
          await traverse(fullPath)
        } else if (entry.isFile()) {
          try {
            const stats = await readFile(fullPath, 'utf-8') // Just to check if readable
            totalSize += Buffer.byteLength(stats, 'utf-8')
            fileCount++
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
 * Copy directory recursively
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath)
    } else {
      await cp(srcPath, destPath)
    }
  }
}

/**
 * Create a backup of the userData directory
 * Backs up entire userData to backups/<timestamp>/
 * Stores metadata in backup-info.json
 * Cleans up old backups (keeps only MAX_BACKUPS most recent)
 */
export async function createBackup(): Promise<IpcResult<BackupInfo>> {
  try {
    const backupId = generateBackupId()
    const backupPath = getBackupPath(backupId)
    const userDataPath = getUserDataDir()

    // Create backup directory
    await mkdir(backupPath, { recursive: true })

    // Copy entire userData directory (except backups folder)
    const entries = await readdir(userDataPath, { withFileTypes: true })

    for (const entry of entries) {
      // Skip the backups directory itself
      if (entry.name === 'backups') {
        continue
      }

      const srcPath = join(userDataPath, entry.name)
      const destPath = join(backupPath, entry.name)

      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath)
      } else if (entry.isFile()) {
        await cp(srcPath, destPath)
      }
    }

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
    const infoPath = getBackupInfoPath(backupId)
    await writeFile(infoPath, JSON.stringify(metadata, null, 2), 'utf-8')

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
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    if (
      errorMessage.includes('ENOSPC') ||
      errorMessage.includes('disk full') ||
      errorMessage.includes('no space left')
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
 * Count files in a directory recursively
 */
async function countFiles(dirPath: string): Promise<number> {
  let count = 0

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name)

        if (entry.isDirectory()) {
          await traverse(fullPath)
        } else if (entry.isFile()) {
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
 * List all available backups
 * Returns backups sorted by timestamp (newest first)
 */
export async function listBackups(): Promise<IpcResult<BackupInfo[]>> {
  try {
    const backupsDir = getBackupsDir()

    // Ensure backups directory exists
    await mkdir(backupsDir, { recursive: true })

    const entries = await readdir(backupsDir, { withFileTypes: true })
    const backups: BackupInfo[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      const backupId = entry.name
      const infoPath = getBackupInfoPath(backupId)

      try {
        const content = await readFile(infoPath, 'utf-8')
        const metadata = JSON.parse(content) as BackupMetadata

        backups.push({
          id: metadata.id,
          timestamp: metadata.timestamp,
          version: metadata.version,
          size: metadata.size,
          fileCount: metadata.fileCount,
          path: getBackupPath(backupId)
        })
      } catch {
        // Skip invalid backups (missing or corrupted metadata)
        continue
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
 * Copies all files from backup directory to userData
 * Overwrites existing files
 */
export async function restoreBackup(backupId: string): Promise<IpcResult<void>> {
  try {
    const backupPath = getBackupPath(backupId)
    const infoPath = getBackupInfoPath(backupId)
    const userDataPath = getUserDataDir()

    // Check if backup exists and has valid metadata
    try {
      await readFile(infoPath, 'utf-8')
    } catch {
      return {
        success: false,
        error: `Backup not found or invalid: ${backupId}`,
        code: BackupErrorCodes.BACKUP_NOT_FOUND
      }
    }

    // Copy files from backup to userData
    const entries = await readdir(backupPath, { withFileTypes: true })

    for (const entry of entries) {
      // Skip backup-info.json when restoring
      if (entry.name === 'backup-info.json') {
        continue
      }

      const srcPath = join(backupPath, entry.name)
      const destPath = join(userDataPath, entry.name)

      if (entry.isDirectory()) {
        await copyDirectory(srcPath, destPath)
      } else if (entry.isFile()) {
        await cp(srcPath, destPath)
      }
    }

    return { success: true, data: undefined }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    if (
      errorMessage.includes('ENOSPC') ||
      errorMessage.includes('disk full') ||
      errorMessage.includes('no space left')
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

    for (const backup of toDelete) {
      try {
        await rm(backup.path, { recursive: true, force: true })
      } catch {
        // Log but continue if deletion fails
        console.warn(`Failed to delete old backup: ${backup.id}`)
      }
    }

    return { success: true, data: undefined }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cleanup old backups',
      code: BackupErrorCodes.BACKUP_FAILED
    }
  }
}
