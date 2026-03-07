import {
  readDir,
  readTextFile,
  writeTextFile,
  remove,
  mkdir,
  stat
} from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import { Store } from '@tauri-apps/plugin-store';
import type { IpcResult } from '@shared/types/ipc.types';

// Rollback error codes
export const RollbackErrorCodes = {
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  COPY_ERROR: 'COPY_ERROR',
  DELETE_ERROR: 'DELETE_ERROR',
  METADATA_ERROR: 'METADATA_ERROR',
  NO_ROLLBACK_AVAILABLE: 'NO_ROLLBACK_AVAILABLE'
} as const;

export type RollbackErrorCode =
  (typeof RollbackErrorCodes)[keyof typeof RollbackErrorCodes];

// Maximum number of previous versions to keep
const MAX_PREVIOUS_VERSIONS = 3;

// Store file for rollback metadata
const ROLLBACK_STORE_FILE = 'rollback-metadata.json';
const PENDING_ROLLBACK_KEY = 'rollback_pending';

/**
 * Metadata for a stored rollback version
 */
export interface RollbackVersionMetadata {
  version: string;
  path: string;
  timestamp: number;
  size: number;
}

/**
 * List of available rollback versions
 */
export interface RollbackVersions {
  current: string;
  available: RollbackVersionMetadata[];
}

/**
 * Result of a version preservation operation
 */
export interface PreservationResult {
  version: string;
  path: string;
  size: number;
}

/**
 * Pending rollback information
 */
export interface PendingRollback {
  targetVersion: string;
  sourcePath: string;
  timestamp: number;
  requiresRestart: boolean;
}

/**
 * Rollback status information
 */
export interface RollbackStatus {
  hasRollbackAvailable: boolean;
  rollbackCount: number;
  maxPreviousVersions: number;
  currentVersion: string;
  pendingRollback: PendingRollback | null;
}

let metadataStore: Store | null = null;

/**
 * Get the store for rollback metadata
 */
async function getMetadataStore(): Promise<Store> {
  if (!metadataStore) {
    metadataStore = await Store.load(ROLLBACK_STORE_FILE, {
      autoSave: false,
      defaults: {}
    });
  }
  return metadataStore;
}

/**
 * Get the versions storage directory
 * Creates directory if it doesn't exist
 */
async function getVersionsDir(): Promise<string> {
  const userData = await appDataDir();
  const versionsDir = `${userData}/versions`;

  try {
    await mkdir(versionsDir, { recursive: true });
  } catch {
    // Directory creation failed, will be handled by callers
  }

  return versionsDir;
}

/**
 * Get the storage directory for a specific version
 */
async function getVersionDir(version: string): Promise<string> {
  const versionsDir = await getVersionsDir();
  return `${versionsDir}/v${version}`;
}

/**
 * Calculate directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await readDir(currentPath);

      for (const entry of entries) {
        const fullPath = `${currentPath}/${entry.name}`;

        if (entry.isDirectory ?? false) {
          // It's a directory
          await traverse(fullPath);
        } else {
          // It's a file
          try {
            const fileInfo = await stat(fullPath);
            totalSize += fileInfo.size;
          } catch {
            // Skip files that can't be read
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  await traverse(dirPath);
  return totalSize;
}

/**
 * Validate version string to prevent path traversal
 * Versions should be semver-like: v1.2.3 or just 1.2.3
 */
function validateVersion(version: string): boolean {
  // Remove leading 'v' if present
  const normalized = version.replace(/^v/, '');

  // Check for path traversal
  if (version.includes('..') || normalized.includes('..')) {
    return false;
  }

  // Allow semver format: x.y.z where x, y, z are numbers
  // Also allow -beta, -rc.1 etc for pre-release versions
  const semverRegex =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

  return semverRegex.test(version);
}

/**
 * Read rollback metadata from store
 */
async function readMetadata(): Promise<
  IpcResult<Map<string, RollbackVersionMetadata>>
> {
  try {
    const store = await getMetadataStore();
    const keys = await store.keys();
    const metadataMap = new Map<string, RollbackVersionMetadata>();

    for (const key of keys) {
      if (key.startsWith('version_')) {
        const metadata = await store.get<RollbackVersionMetadata>(key);
        if (metadata) {
          const version = key.replace('version_', '');
          metadataMap.set(version, metadata);
        }
      }
    }

    return { success: true, data: metadataMap };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to read metadata',
      code: RollbackErrorCodes.METADATA_ERROR
    };
  }
}

/**
 * Write rollback metadata to store
 */
async function writeMetadata(
  metadata: Map<string, RollbackVersionMetadata>
): Promise<IpcResult<void>> {
  try {
    const store = await getMetadataStore();

    // Clear existing version metadata
    const keys = await store.keys();
    for (const key of keys) {
      if (key.startsWith('version_')) {
        await store.delete(key);
      }
    }

    // Write new metadata
    for (const [version, meta] of metadata.entries()) {
      await store.set(`version_${version}`, meta);
    }

    await store.save();

    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to write metadata',
      code: RollbackErrorCodes.METADATA_ERROR
    };
  }
}

/**
 * Get current app version
 */
async function getCurrentVersion(): Promise<string> {
  try {
    const store = await getMetadataStore();
    const version = await store.get<string>('app_version');
    return version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Set current app version (should be called on app startup)
 */
export async function setCurrentVersion(version: string): Promise<void> {
  try {
    const store = await getMetadataStore();
    await store.set('app_version', version);
    await store.save();
  } catch {
    // Ignore errors setting version
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
      return { success: true, data: undefined };
    }

    // Sort versions by timestamp (oldest first)
    const sortedVersions = Array.from(metadata.entries()).sort(
      (a, b) => a[1].timestamp - b[1].timestamp
    );

    // Remove oldest versions beyond the limit
    const versionsToDelete = sortedVersions.slice(
      0,
      metadata.size - MAX_PREVIOUS_VERSIONS
    );

    for (const [version, meta] of versionsToDelete) {
      try {
        // Delete the version directory
        await remove(meta.path, { recursive: true });
        // Remove from metadata
        metadata.delete(version);
      } catch {
        // Deletion failed, continue with others
        console.warn(`Failed to delete old version: ${version}`);
      }
    }

    // Update metadata
    return await writeMetadata(metadata);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to cleanup old versions',
      code: RollbackErrorCodes.DELETE_ERROR
    };
  }
}

/**
 * List all available rollback versions
 * Returns metadata for each version that can be rolled back to
 */
export async function availableRollbacks(): Promise<IpcResult<RollbackVersions>> {
  try {
    const metadataResult = await readMetadata();

    if (!metadataResult.success) {
      return metadataResult as IpcResult<RollbackVersions>;
    }

    const metadata = metadataResult.data;

    // Convert map to array and sort by timestamp (newest first)
    const availableVersions = Array.from(metadata.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );

    // Get current version from store
    const currentVersion = await getCurrentVersion();

    return {
      success: true,
      data: {
        current: currentVersion,
        available: availableVersions
      }
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list rollback versions',
      code: RollbackErrorCodes.METADATA_ERROR
    };
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
    };
  }

  try {
    const versionsDir = await getVersionsDir();
    const versionDir = await getVersionDir(version);

    // Create version directory
    await mkdir(versionDir, { recursive: true });

    // In a full implementation, this would copy the current app executable
    // For now, we create a marker file and track metadata
    const markerPath = `${versionDir}/.app-version`;
    const markerContent = JSON.stringify({
      version,
      timestamp: Date.now(),
      platform: 'unknown', // Would use Tauri's platform API
      arch: 'unknown' // Would use Tauri's arch API
    });

    await writeTextFile(markerPath, markerContent);

    // Get directory size (recursively calculate total size of contents)
    const size = await getDirectorySize(versionDir);

    // Update metadata
    const metadataResult = await readMetadata();
    if (!metadataResult.success) {
      return metadataResult as IpcResult<PreservationResult>;
    }

    const metadata = metadataResult.data;
    metadata.set(version, {
      version,
      path: versionDir,
      timestamp: Date.now(),
      size
    });

    // Clean up old versions
    const cleanupResult = await cleanupOldVersions(metadata);
    if (!cleanupResult.success) {
      console.warn('Cleanup of old versions failed:', cleanupResult.error);
    }

    // Save updated metadata
    const writeResult = await writeMetadata(metadata);
    if (!writeResult.success) {
      return writeResult as IpcResult<PreservationResult>;
    }

    return {
      success: true,
      data: {
        version,
        path: versionDir,
        size
      }
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to preserve version',
      code: RollbackErrorCodes.COPY_ERROR
    };
  }
}

/**
 * Install a previous version (rollback)
 * This prepares the rollback but requires external launcher to complete
 *
 * @param version - The version to rollback to (e.g., "0.1.0")
 * @returns Result with instructions for completing rollback
 */
export async function installRollback(
  version: string
): Promise<
  IpcResult<{ version: string; path: string; instructions: string }>
> {
  if (!validateVersion(version)) {
    return {
      success: false,
      error: `Invalid version format: ${version}`,
      code: RollbackErrorCodes.VERSION_NOT_FOUND
    };
  }

  try {
    const metadataResult = await readMetadata();
    if (!metadataResult.success) {
      return metadataResult as IpcResult<{
        version: string;
        path: string;
        instructions: string;
      }>;
    }

    const metadata = metadataResult.data;
    const versionMetadata = metadata.get(version);

    if (!versionMetadata) {
      return {
        success: false,
        error: `Version ${version} not found in rollback history`,
        code: RollbackErrorCodes.VERSION_NOT_FOUND
      };
    }

    // Verify the version directory still exists
    try {
      await stat(versionMetadata.path);
    } catch {
      // Directory doesn't exist, remove from metadata
      metadata.delete(version);
      await writeMetadata(metadata);

      return {
        success: false,
        error: `Version ${version} files not found`,
        code: RollbackErrorCodes.VERSION_NOT_FOUND
      };
    }

    // Create rollback instruction for external launcher
    const instructions: PendingRollback = {
      targetVersion: version,
      sourcePath: versionMetadata.path,
      timestamp: Date.now(),
      requiresRestart: true
    };

    // Store pending rollback in store
    const store = await getMetadataStore();
    await store.set(PENDING_ROLLBACK_KEY, instructions);
    await store.save();

    return {
      success: true,
      data: {
        version,
        path: versionMetadata.path,
        instructions: `Rollback to v${version} prepared. Restart the application to complete the rollback.`
      }
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to install rollback',
      code: RollbackErrorCodes.COPY_ERROR
    };
  }
}

/**
 * Check if there's a pending rollback from a previous session
 * Called on startup to detect auto-rollback scenarios
 */
export async function checkPendingRollback(): Promise<
  IpcResult<{ version: string; path: string } | null>
> {
  try {
    const store = await getMetadataStore();
    const pending = await store.get<PendingRollback>(PENDING_ROLLBACK_KEY);

    if (!pending) {
      return { success: true, data: null };
    }

    return {
      success: true,
      data: {
        version: pending.targetVersion,
        path: pending.sourcePath
      }
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to check pending rollback',
      code: RollbackErrorCodes.METADATA_ERROR
    };
  }
}

/**
 * Clear pending rollback file
 * Called after successful rollback or if rollback is cancelled
 */
export async function clearPendingRollback(): Promise<IpcResult<void>> {
  try {
    const store = await getMetadataStore();
    await store.delete(PENDING_ROLLBACK_KEY);
    await store.save();
    return { success: true, data: undefined };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to clear pending rollback',
      code: RollbackErrorCodes.DELETE_ERROR
    };
  }
}

/**
 * Get the current rollback service status
 * Useful for UI to display available rollback options
 */
export async function getRollbackStatus(): Promise<IpcResult<RollbackStatus>> {
  try {
    const availableResult = await availableRollbacks();

    if (!availableResult.success) {
      return availableResult as IpcResult<RollbackStatus>;
    }

    const rollbackCount = availableResult.data.available.length;
    const currentVersion = availableResult.data.current;

    // Check for pending rollback
    const pendingResult = await checkPendingRollback();
    const pendingRollback = pendingResult.success
      ? await (async () => {
          const store = await getMetadataStore();
          return await store.get<PendingRollback>(PENDING_ROLLBACK_KEY);
        })()
      : null;

    return {
      success: true,
      data: {
        hasRollbackAvailable: rollbackCount > 0,
        rollbackCount,
        maxPreviousVersions: MAX_PREVIOUS_VERSIONS,
        currentVersion,
        pendingRollback: pendingRollback ?? null
      }
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to get rollback status',
      code: RollbackErrorCodes.METADATA_ERROR
    };
  }
}

/**
 * @internal Testing only - reset module state
 */
export function _resetRollbackStateForTesting() {
  metadataStore = null;
}

/**
 * Create a rollback API object for consistency with other APIs
 */
export const tauriRollbackApi = {
  keepPreviousVersion,
  availableRollbacks,
  installRollback,
  checkPendingRollback,
  clearPendingRollback,
  getRollbackStatus,
  setCurrentVersion
};

/**
 * Factory function for consistency with other APIs
 */
export function createTauriRollbackApi() {
  return tauriRollbackApi;
}
