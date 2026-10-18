/**
 * Which files are canvas documents. One rule shared by the file explorer's
 * open branch and the "Open canvas" command.
 */

import type { DirectoryEntry } from '@shared/types/filesystem.types'

export const CANVAS_DOC_EXTENSION = '.figcraft'

/** What a project without a canvas document gets on its first open. */
export const NEW_CANVAS_DOC_NAME = 'design.figcraft'

export function isCanvasDocPath(path: string): boolean {
  return path.toLowerCase().endsWith(CANVAS_DOC_EXTENSION)
}

/** The project's alphabetically-first `.figcraft` file, or `undefined`. */
export function pickCanvasDoc(entries: DirectoryEntry[]): DirectoryEntry | undefined {
  return entries
    .filter((entry) => entry.type === 'file' && isCanvasDocPath(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
}
