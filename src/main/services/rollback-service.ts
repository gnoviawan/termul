import { app } from 'electron'
import { join, dirname } from 'path'
import { mkdir, readdir, copyFile, stat, unlink, rm, readFile, writeFile } from 'fs/promises'
import type { IpcResult } from '../../shared/types/ipc.types'

// Rollback error codes
export const RollbackErrorCodes = {
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  COPY_ERROR: 'COPY_ERROR',
  DELETE_ERROR: 'DELETE_ERROR',
  METADATA_ERROR: 'METADATA_ERROR',
  NO_ROLLBACK_AVAILABLE: 'NO_ROLLBACK_AVAILABLE'
} as const

export type RollbackErrorCode =
  (typeof RollbackErrorCodes)[keyof typeof RollbackErrorCodes]

// Maximum number of previous versions to keep
const MAX_PREVIOUS_VERSIONS = 3

/**
 * Metadata for a stored rollback version
 */
export interface RollbackVersionMetadata {
  version: string
  path: string
  timestamp: number
  size: number
}

/**
 * List of available rollback versions
 */
export interface RollbackVersions {
  current: string
  available: RollbackVersionMetadata[]
}

/**
 * Result of a version preservation operation
 */
export interface PreservationResult {
  version: string
  path: string
  size: number
}

/**
 * Get the versions storage directory
 * Creates directory if it doesn't exist
 */
async function getVersionsDir(): Promise<string> {
  const userData = app.getPath('userData')
  const versionsDir = join(userData, 'versions')

  try {
    await mkdir(versionsDir, { recursive: true })
  } catch {
    // Directory creation failed, will be handled by callers
  }

  return versionsDir
}

/**
 * Get metadata file path for version tracking
 */
function getMetadataPath(): string {
  const userData = app.getPath('userData')
  return join(userData, 'rollback-metadata.json')
}

/**
 * Get the storage directory for a specific version
 */
async function getVersionDir(version: string): Promise<string> {
  const versionsDir = await getVersionsDir()
  return join(versionsDir, `v${version}`)
}

/**
 * Calculate directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name)

        if (entry.isDirectory()) {
          await traverse(fullPath)
        } else if (entry.isFile()) {
          try {
            const stats = await stat(fullPath)
            totalSize += stats.size
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
 * Validate version string to prevent path traversal
 * Versions should be semver-like: v1.2.3 or just 1.2.3
 */
function validateVersion(version: string): boolean {
  // Remove leading 'v' if present
  const normalized = version.replace(/^v/, '')

  // Check for path traversal
  if (version.includes('..') || normalized.includes('..')) {
    return false
  }

  // Allow semver format: x.y.z where x, y, z are numbers
  // Also allow -beta, -rc.1 etc for pre-release versions
  const semverRegex =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

  return semverRegex.test(version)
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
 * Read rollback metadata from disk
 */
async function readMetadata(): Promise<IpcResult<Map<string, RollbackVersionMetadata>>> {
  const metadataPath = getMetadataPath()

  try {
    const content = await readFile(metadataPath, 'utf-8')
    const data = JSON.parse(content) as Record<string, RollbackVersionMetadata>

    const metadataMap = new Map<string, RollbackVersionMetadata>()
    for (const [version, meta] of Object.entries(data)) {
      metadataMap.set(version, meta)
    }

    return { success: true, data: metadataMap }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      // No metadata file yet, return empty map
      return { success: true, data: new Map() }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to read metadata',
      code: RollbackErrorCodes.METADATA_ERROR
    }
  }
}

/**
 * Write rollback metadata to disk
 */
async function writeMetadata(
  metadata: Map<string, RollbackVersionMetadata>
): Promise<IpcResult<void>> {
  const metadataPath = getMetadataPath()

  try {
    await ensureDir(metadataPath)

    const data: Record<string, RollbackVersionMetadata> = {}
    metadata.forEach((meta, version) => {
      data[version] = meta
    })

    const content = JSON.stringify(data, null, 2)
    await writeFile(metadataPath, content, 'utf-8')

    return { success: true, data: undefined }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to write metadata',
      code: RollbackErrorCodes.METADATA_ERROR
    }
  }
}

/**
 * Clean up old versions, keeping only the most recent MAX_PREVIOUS_VERSIONS
 */
async function cleanupOldVersions(
  metadata: Map<string, RollbackVersionMetadata>
): Promise<IpcResult<void>> {
  try {
    if (metadata.size <= MAX_PREVIOUS_VERSIONS) {
      return { success: true, data: undefined }
    }

    // Sort versions by timestamp (oldest first)
    const sortedVersions = Array.from(metadata.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    )

    // Remove oldest versions beyond the limit
    const versionsToDelete = sortedVersions.slice(0, metadata.size - MAX_PREVIOUS_VERSIONS)

    for (const [version, meta] of versionsToDelete) {
      try {
        // Delete the version directory
        await rm(meta.path, { recursive: true, force: true })
        // Remove from metadata
        metadata.delete(version)
      } catch {
        // Deletion failed, continue with others
        console.warn(`Failed to delete old version: ${version}`)
      }
    }

    // Update metadata
    return await writeMetadata(metadata)
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cleanup old versions',
      code: RollbackErrorCodes.DELETE_ERROR
    }
  }
}

/**
 * List all available rollback versions
 * Returns metadata for each version that can be rolled back to
 */
export async function availableRollbacks(): Promise<IpcResult<RollbackVersions>> {
  try {
    const metadataResult = await readMetadata()

    if (!metadataResult.success) {
      return metadataResult as IpcResult<RollbackVersions>
    }

    const metadata = metadataResult.data

    // Convert map to array and sort by timestamp (newest first)
    const availableVersions = Array.from(metadata.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    )

    // Get current version from app
    const currentVersion = app.getVersion()

    return {
      success: true,
      data: {
        current: currentVersion,
        available: availableVersions
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list rollback versions',
      code: RollbackErrorCodes.METADATA_ERROR
    }
  }
}

/**
 * Keep a copy of the current version for rollback
 * Should be called before an update is installed
 *
 * @param version - The version string to preserve (e.g., "0.1.0")
 * @returns Result with preservation details
 */
export async function keepPreviousVersion(
  version: string
): Promise<IpcResult<PreservationResult>> {
  if (!validateVersion(version)) {
    return {
      success: false,
      error: `Invalid version format: ${version}`,
      code: RollbackErrorCodes.VERSION_NOT_FOUND
    }
  }

  try {
    const versionsDir = await getVersionsDir()
    const versionDir = await getVersionDir(version)

    // Create version directory
    await mkdir(versionDir, { recursive: true })

    // In a full implementation, this would copy the current app executable
    // For now, we create a marker file and track metadata
    const markerPath = join(versionDir, '.app-version')
    const markerContent = JSON.stringify({
      version,
      timestamp: Date.now(),
      platform: process.platform,
      arch: process.arch
    })

    await writeFile(markerPath, markerContent, 'utf-8')

    // Get directory size (recursively calculate total size of contents)
    const size = await getDirectorySize(versionDir)

    // Update metadata
    const metadataResult = await readMetadata()
    if (!metadataResult.success) {
      return metadataResult as IpcResult<PreservationResult>
    }

    const metadata = metadataResult.data
    metadata.set(version, {
      version,
      path: versionDir,
      timestamp: Date.now(),
      size
    })

    // Clean up old versions
    const cleanupResult = await cleanupOldVersions(metadata)
    if (!cleanupResult.success) {
      console.warn('Cleanup of old versions failed:', cleanupResult.error)
    }

    // Save updated metadata
    const writeResult = await writeMetadata(metadata)
    if (!writeResult.success) {
      return writeResult as IpcResult<PreservationResult>
    }

    return {
      success: true,
      data: {
        version,
        path: versionDir,
        size
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to preserve version',
      code: RollbackErrorCodes.COPY_ERROR
    }
  }
}

/**
 * Install a previous version (rollback)
 * This prepares the rollback but requires external launcher to complete
 *
 * @param version - The version to rollback to (e.g., "0.1.0")
 * @returns Result with instructions for completing rollback
 */
export async function installRollback(version: string): Promise<IpcResult<{ version: string; path: string; instructions: string }>> {
  if (!validateVersion(version)) {
    return {
      success: false,
      error: `Invalid version format: ${version}`,
      code: RollbackErrorCodes.VERSION_NOT_FOUND
    }
  }

  try {
    const metadataResult = await readMetadata()
    if (!metadataResult.success) {
      return metadataResult as IpcResult<{ version: string; path: string; instructions: string }>
    }

    const metadata = metadataResult.data
    const versionMetadata = metadata.get(version)

    if (!versionMetadata) {
      return {
        success: false,
        error: `Version ${version} not found in rollback history`,
        code: RollbackErrorCodes.VERSION_NOT_FOUND
      }
    }

    // Verify the version directory still exists
    try {
      await stat(versionMetadata.path)
    } catch {
      // Directory doesn't exist, remove from metadata
      metadata.delete(version)
      await writeMetadata(metadata)

      return {
        success: false,
        error: `Version ${version} files not found`,
        code: RollbackErrorCodes.VERSION_NOT_FOUND
      }
    }

    // Create rollback instruction file for external launcher
    const instructionPath = join(app.getPath('userData'), 'rollback-pending.json')
    const instructions = {
      targetVersion: version,
      sourcePath: versionMetadata.path,
      timestamp: Date.now(),
      requiresRestart: true
    }

    await writeFile(instructionPath, JSON.stringify(instructions, null, 2), 'utf-8')

    return {
      success: true,
      data: {
        version,
        path: versionMetadata.path,
        instructions: `Rollback to v${version} prepared. Restart the application to complete the rollback.`
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to install rollback',
      code: RollbackErrorCodes.COPY_ERROR
    }
  }
}

/**
 * Check if there's a pending rollback from a previous session
 * Called on startup to detect auto-rollback scenarios
 */
export async function checkPendingRollback(): Promise<IpcResult<{ version: string; path: string } | null>> {
  const instructionPath = join(app.getPath('userData'), 'rollback-pending.json')

  try {
    const content = await readFile(instructionPath, 'utf-8')
    const instructions = JSON.parse(content) as {
      targetVersion: string
      sourcePath: string
      timestamp: number
      requiresRestart: boolean
    }

    return {
      success: true,
      data: {
        version: instructions.targetVersion,
        path: instructions.sourcePath
      }
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { success: true, data: null }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to check pending rollback',
      code: RollbackErrorCodes.METADATA_ERROR
    }
  }
}

/**
 * Clear pending rollback file
 * Called after successful rollback or if rollback is cancelled
 */
export async function clearPendingRollback(): Promise<IpcResult<void>> {
  const instructionPath = join(app.getPath('userData'), 'rollback-pending.json')

  try {
    await unlink(instructionPath)
    return { success: true, data: undefined }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      // File doesn't exist, that's fine
      return { success: true, data: undefined }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to clear pending rollback',
      code: RollbackErrorCodes.DELETE_ERROR
    }
  }
}

/**
 * Get the current rollback service status
 * Useful for UI to display available rollback options
 */
export async function getRollbackStatus(): Promise<IpcResult<{
  hasRollbackAvailable: boolean
  rollbackCount: number
  maxPreviousVersions: number
}>> {
  try {
    const availableResult = await availableRollbacks()

    if (!availableResult.success) {
      return availableResult as IpcResult<{
        hasRollbackAvailable: boolean
        rollbackCount: number
        maxPreviousVersions: number
      }>
    }

    const rollbackCount = availableResult.data.available.length

    return {
      success: true,
      data: {
        hasRollbackAvailable: rollbackCount > 0,
        rollbackCount,
        maxPreviousVersions: MAX_PREVIOUS_VERSIONS
      }
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get rollback status',
      code: RollbackErrorCodes.METADATA_ERROR
    }
  }
}
