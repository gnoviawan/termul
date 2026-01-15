import { read, write, remove } from './persistence-service'

/**
 * Skipped version data structure
 * Stored at settings/skipped-version.json
 */
export interface SkippedVersionData {
  version: string
  skippedAt: string // ISO timestamp
}

/**
 * Storage key for skipped version
 */
const SKIPPED_VERSION_KEY = 'settings/skipped-version'

/**
 * Save a version as skipped
 * Stores the version and timestamp to persist the skip across app restarts
 *
 * @param version - The version to skip (e.g., "1.2.3")
 * @returns Promise resolving to success status
 */
export async function skipVersion(version: string): Promise<boolean> {
  const data: SkippedVersionData = {
    version,
    skippedAt: new Date().toISOString()
  }

  const result = await write(SKIPPED_VERSION_KEY, data)
  return result.success
}

/**
 * Get the currently skipped version
 *
 * @returns Promise resolving to skipped version data, or null if none exists
 */
export async function getSkippedVersion(): Promise<SkippedVersionData | null> {
  const result = await read<SkippedVersionData>(SKIPPED_VERSION_KEY)

  if (result.success && result.data) {
    return result.data
  }

  return null
}

/**
 * Clear the skipped version
 * Removes the skip file, allowing updates to be shown again
 *
 * @returns Promise resolving to success status
 */
export async function clearSkippedVersion(): Promise<boolean> {
  const result = await remove(SKIPPED_VERSION_KEY)
  return result.success
}

/**
 * Check if an update notification should be shown for a given version
 * Returns false if the version matches the skipped version (user dismissed it)
 * Returns true if no version is skipped or if a different version is available
 *
 * This implements auto-clearing: when a new version becomes available,
 * the skip is automatically cleared and the update will be shown.
 *
 * @param version - The version to check (e.g., "1.2.3")
 * @returns Promise resolving to true if update should be shown, false otherwise
 */
export async function shouldShowUpdate(version: string): Promise<boolean> {
  const skipped = await getSkippedVersion()

  // No skip exists, show the update
  if (!skipped) {
    return true
  }

  // Different version available, auto-clear the skip and show the update
  if (skipped.version !== version) {
    await clearSkippedVersion()
    return true
  }

  // Same version is skipped, don't show the update
  return false
}
