/**
 * Which files are canvas documents. One rule shared by the file explorer's
 * open branch and the "Open canvas" command.
 */

import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { basename } from './path-basename'

export const CANVAS_DOC_EXTENSION = '.figcraft'

/** What a project without a canvas document gets on its first open. */
export const NEW_CANVAS_DOC_NAME = 'design.figcraft'

/** `path` with forward slashes and without a Windows verbatim prefix:
 * `\\?\D:\p` is `D:/p` and `\\?\UNC\srv\share` is `//srv/share`. */
export function plainPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '')
}

/** `plainPath`, folded to lower case for a drive-letter or UNC path, which
 * Windows compares without case. */
export function comparablePath(path: string): string {
  const plain = plainPath(path)
  return /^([A-Za-z]:|\/\/)/.test(plain) ? plain.toLowerCase() : plain
}

/** Whether two spellings name the same document: the command palette and
 * the file explorer hand the same file over with different separators. */
export function sameCanvasDoc(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b)
}

/** `docPath` relative to `root` with forward slashes; the absolute path when
 * the document is not under the root. Drive-letter roots compare
 * case-insensitively, as Windows paths do. */
export function projectRelativePath(docPath: string, root: string | undefined): string {
  const doc = plainPath(docPath)
  if (!root) return doc
  const prefix = `${plainPath(root).replace(/\/+$/, '')}/`
  return comparablePath(doc).startsWith(comparablePath(prefix)) ? doc.slice(prefix.length) : doc
}

/** What `host.file` tells the editor about the file it holds: the header and
 * window title show `name`, `inspect_*` report `path`, and `location` takes
 * the place of figcraft's "Drafts". */
export interface CanvasDocFile {
  name: string
  /** Project-relative, as `save_file` reports it; never an absolute path. */
  path: string
  location: string | null
}

export function canvasDocFile(
  docPath: string,
  project: { name: string; path?: string } | undefined
): CanvasDocFile {
  const file = basename(docPath)
  const relative = projectRelativePath(docPath, project?.path)
  return {
    name: isCanvasDocPath(file) ? file.slice(0, -CANVAS_DOC_EXTENSION.length) : file,
    path: relative === plainPath(docPath) ? file : relative,
    location: project?.name ?? null
  }
}

export function isCanvasDocPath(path: string): boolean {
  return path.toLowerCase().endsWith(CANVAS_DOC_EXTENSION)
}

/** The project's alphabetically-first `.figcraft` file, or `undefined`. */
export function pickCanvasDoc(entries: DirectoryEntry[]): DirectoryEntry | undefined {
  return entries
    .filter((entry) => entry.type === 'file' && isCanvasDocPath(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0]
}
