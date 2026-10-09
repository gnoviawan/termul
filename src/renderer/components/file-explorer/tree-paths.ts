import type { DirectoryEntry } from '@shared/types/filesystem.types'

/**
 * Path helpers for the file tree. Tree paths use forward slashes; Windows
 * backslash paths are normalized before they are compared or split.
 */

/** Forward slashes, no trailing slash (except the filesystem root `/`). */
export function normalizeTreePath(path: string): string {
  const forward = path.replace(/\\/g, '/')
  return forward.length > 1 && forward.endsWith('/') ? forward.slice(0, -1) : forward
}

/** Parent folder of `path`: `/` for a top-level path, '' when there is no slash. */
export function parentTreePath(path: string): string {
  const normalized = normalizeTreePath(path)
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : lastSlash === 0 ? '/' : ''
}

/** Separator-safe join: a parent that ends in `/` does not get a second slash. */
export function joinTreePath(parent: string, name: string): string {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

/** Find a loaded entry by its absolute path across all loaded folders. */
export function findTreeEntry(
  directoryContents: ReadonlyMap<string, DirectoryEntry[]>,
  path: string
): DirectoryEntry | undefined {
  for (const entries of directoryContents.values()) {
    const found = entries.find((entry) => entry.path === path)
    if (found) return found
  }
  return undefined
}
