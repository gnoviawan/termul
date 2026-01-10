import { app } from 'electron'
import { join, dirname } from 'path'
import { mkdir, readFile, writeFile, unlink, rename, access } from 'fs/promises'
import type { IpcResult } from '../../shared/types/ipc.types'

// Persistence error codes
export const PersistenceErrorCodes = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PARSE_ERROR: 'PARSE_ERROR',
  WRITE_ERROR: 'WRITE_ERROR',
  DELETE_ERROR: 'DELETE_ERROR'
} as const

export type PersistenceErrorCode =
  (typeof PersistenceErrorCodes)[keyof typeof PersistenceErrorCodes]

// Debounced write tracking
interface PendingWrite {
  key: string
  data: unknown
  timeoutId: NodeJS.Timeout
}

const pendingWrites = new Map<string, PendingWrite>()
const DEBOUNCE_DELAY = 500 // 500ms as per architecture spec

/**
 * Get the base directory for persistence storage
 * Uses Electron's userData path for platform-appropriate location
 */
export function getStorageDir(): string {
  return app.getPath('userData')
}

/**
 * Validate storage key to prevent path traversal attacks
 * Keys must be alphanumeric with optional forward slashes and hyphens
 */
function validateKey(key: string): boolean {
  // Reject empty keys
  if (!key || key.length === 0) return false
  // Reject path traversal attempts
  if (key.includes('..')) return false
  // Only allow alphanumeric, hyphens, underscores, and forward slashes
  return /^[a-zA-Z0-9/_-]+$/.test(key)
}

/**
 * Get the full file path for a given key
 * Keys like 'projects' -> projects.json
 * Keys like 'terminals/project-1' -> terminals/project-1.json
 */
export function getFilePath(key: string): string {
  if (!validateKey(key)) {
    throw new Error(`Invalid storage key: ${key}`)
  }
  const baseDir = getStorageDir()
  return join(baseDir, `${key}.json`)
}

/**
 * Get backup file path
 */
export function getBackupPath(filePath: string): string {
  return `${filePath}.backup`
}

/**
 * Ensure directory exists for a file path
 */
async function ensureDir(filePath: string): Promise<void> {
  const dir = dirname(filePath)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // Directory already exists or creation failed
  }
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Read data from a JSON file
 */
export async function read<T>(key: string): Promise<IpcResult<T>> {
  const filePath = getFilePath(key)

  try {
    const content = await readFile(filePath, 'utf-8')
    const data = JSON.parse(content) as T
    return { success: true, data }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return {
        success: false,
        error: `File not found: ${key}`,
        code: PersistenceErrorCodes.FILE_NOT_FOUND
      }
    }
    if (err instanceof SyntaxError) {
      return {
        success: false,
        error: `Invalid JSON in ${key}: ${err.message}`,
        code: PersistenceErrorCodes.PARSE_ERROR
      }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown read error',
      code: PersistenceErrorCodes.PARSE_ERROR
    }
  }
}

/**
 * Write data to a JSON file atomically
 * Uses temp file + rename pattern for atomic writes
 * Creates backup of existing file before overwriting
 */
export async function write<T>(key: string, data: T): Promise<IpcResult<void>> {
  const filePath = getFilePath(key)
  const tempPath = `${filePath}.tmp`
  const backupPath = getBackupPath(filePath)

  try {
    await ensureDir(filePath)

    // Write to temp file first
    const content = JSON.stringify(data, null, 2)
    await writeFile(tempPath, content, 'utf-8')

    // Create backup of existing file if it exists
    if (await fileExists(filePath)) {
      try {
        await rename(filePath, backupPath)
      } catch {
        // Backup failed, continue anyway
      }
    }

    // Atomic rename temp to final
    await rename(tempPath, filePath)

    return { success: true, data: undefined }
  } catch (err) {
    // Clean up temp file if it exists
    try {
      await unlink(tempPath)
    } catch {
      // Ignore cleanup errors
    }

    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown write error',
      code: PersistenceErrorCodes.WRITE_ERROR
    }
  }
}

/**
 * Delete a JSON file
 */
export async function remove(key: string): Promise<IpcResult<void>> {
  const filePath = getFilePath(key)

  try {
    await unlink(filePath)
    return { success: true, data: undefined }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      // File doesn't exist, consider it a success
      return { success: true, data: undefined }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown delete error',
      code: PersistenceErrorCodes.DELETE_ERROR
    }
  }
}

/**
 * Write data with debouncing
 * Coalesces rapid writes into a single write operation
 */
export function writeDebounced<T>(key: string, data: T): void {
  // Cancel any pending write for this key
  const pending = pendingWrites.get(key)
  if (pending) {
    clearTimeout(pending.timeoutId)
  }

  // Schedule new write
  const timeoutId = setTimeout(async () => {
    pendingWrites.delete(key)
    const result = await write(key, data)
    if (!result.success) {
      console.error(`Debounced write failed for ${key}:`, result.error)
    }
  }, DEBOUNCE_DELAY)

  pendingWrites.set(key, { key, data, timeoutId })
}

/**
 * Flush all pending debounced writes
 * Call this on app quit to ensure data is saved
 */
export async function flushPendingWrites(): Promise<void> {
  const writes: Promise<IpcResult<void>>[] = []

  pendingWrites.forEach((pending, key) => {
    clearTimeout(pending.timeoutId)
    writes.push(write(key, pending.data))
  })
  pendingWrites.clear()

  await Promise.all(writes)
}

/**
 * Get the count of pending writes (for testing)
 */
export function getPendingWriteCount(): number {
  return pendingWrites.size
}

/**
 * Clear all pending writes without executing them (for testing)
 */
export function clearPendingWrites(): void {
  pendingWrites.forEach((pending) => {
    clearTimeout(pending.timeoutId)
  })
  pendingWrites.clear()
}
