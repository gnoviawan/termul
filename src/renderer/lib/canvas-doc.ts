/**
 * Canvas doc resolution (OpenPencil canvas mode): the "Open canvas" entry
 * points (command palette) need a `.op` document to open. Extracted as a
 * pure helper so the resolution rule — files only, `.op` extension
 * (case-insensitive), alphabetical, first match — is unit-testable without
 * mounting the whole WorkspaceLayout.
 */

import type { DirectoryEntry } from '@shared/types/filesystem.types'

/**
 * Pick the project's `.op` document from a directory listing (the command
 * palette's "Open canvas" target): the alphabetically-first `.op` file, or
 * `undefined` when the listing carries none. Directories are never picked.
 */
export function pickCanvasDoc(entries: DirectoryEntry[]): DirectoryEntry | undefined {
  return entries
    .filter((entry) => entry.type === 'file' && entry.name.toLowerCase().endsWith('.op'))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
}
