import type { DirectoryEntry } from '@shared/types/filesystem.types'

/** Match the desktop explorer's default ordering for every filesystem surface. */
export function sortDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type === 'directory' && b.type === 'file') return -1
    if (a.type === 'file' && b.type === 'directory') return 1

    if (!a.ignored && b.ignored) return -1
    if (a.ignored && !b.ignored) return 1

    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })
}
