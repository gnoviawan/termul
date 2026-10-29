import { filesystemApi } from '@/lib/api'
import {
  detectLanguage,
  type EditorViewMode,
  editorFileKindForPath,
  getDefaultViewMode
} from '@/lib/editor-file-kind'
import { logFrontendError } from '@/lib/log-api'
import type { MediaKind } from '@/lib/media-kind'
import { basename } from '@/lib/path-basename'

interface FileStateBase {
  filePath: string
  lastModified: number
  operationStatus: 'idle' | 'saving' | 'reloading' | 'saved'
}

export interface TextFileState extends FileStateBase {
  kind: 'text'
  content: string
  originalContent: string
  isDirty: boolean
  language: string
  viewMode: EditorViewMode
  cursorPosition: { line: number; col: number }
  scrollTop: number
  /**
   * sha256 of the bytes this buffer was last read from / saved to (web host
   * only): sent as the `expected` precondition of the next save so a write over
   * a file changed elsewhere is refused instead of overwriting it.
   */
  contentHash?: string
  /**
   * The host reports content hashes for this file (web): kept when `contentHash`
   * is dropped (overwrite) so the next successful save re-establishes it.
   */
  tracksHash?: true
  /** The host refused the last save (`PRECONDITION_FAILED`): the file changed on disk. */
  externalConflict?: boolean
  /**
   * Set when a restored unsaved draft differs from a file that changed on disk
   * after the draft was saved. `content` holds the disk version; the draft is
   * kept here until the user resolves it (never silently dropped).
   */
  draftConflict?: { draftContent: string; draftSavedAt: number }
}

/** A read-only tab: never dirty, never saved. Its viewer reads the bytes. */
interface ViewerFileState extends FileStateBase {
  kind: MediaKind
  isDirty: false
  /** Bumped when the file changes on disk; the viewer re-reads on change. */
  revision: number
}

/** Why the text read refused a file; `limit` is the read cap it exceeded. */
export type UnsupportedReason =
  | { reason: 'binary'; size?: number }
  | { reason: 'too-large'; size?: number; limit?: number }

/** A file the text read refused, shown as "can't be previewed". */
type UnsupportedFileState = FileStateBase & {
  kind: 'unsupported'
  isDirty: false
} & UnsupportedReason

export type MediaFileState = ViewerFileState | UnsupportedFileState

export type EditorFileState = TextFileState | MediaFileState

export function textFileState(
  filePath: string,
  read: { content: string; modifiedAt: number; contentHash?: string }
): TextFileState {
  return {
    kind: 'text',
    filePath,
    content: read.content,
    originalContent: read.content,
    isDirty: false,
    language: detectLanguage(filePath),
    lastModified: read.modifiedAt,
    ...(read.contentHash ? { contentHash: read.contentHash, tracksHash: true as const } : {}),
    viewMode: getDefaultViewMode(filePath),
    cursorPosition: { line: 1, col: 1 },
    scrollTop: 0,
    operationStatus: 'idle'
  }
}

/** `file too large (N bytes, max M)`, as the host text and media reads both word it. */
export function parseTooLarge(message: string): { size?: number; limit?: number } {
  const match = /\((\d+) bytes, max (\d+)\)/.exec(message)
  return match ? { size: Number(match[1]), limit: Number(match[2]) } : {}
}

/** Best effort: `/fs/info` is loopback-only on web, so a remote peer gets no size. */
async function sizeOf(filePath: string): Promise<{ size?: number }> {
  try {
    const info = await filesystemApi.getFileInfo(filePath)
    return info.success ? { size: info.data.size } : {}
  } catch {
    return {}
  }
}

/**
 * Build the tab state for `filePath`. Media kinds do no I/O here (the viewer
 * reads the bytes). A text read that the host refuses as binary or too large
 * becomes an `unsupported` tab; any other failure throws.
 */
export async function loadEditorFile(filePath: string): Promise<EditorFileState> {
  const kind = editorFileKindForPath(filePath)
  const base = { filePath, lastModified: Date.now(), operationStatus: 'idle' as const }
  if (kind !== 'text') return { ...base, kind, isDirty: false, revision: 0 }

  const result = await filesystemApi.readFile(filePath)
  if (result.success) return textFileState(filePath, result.data)
  if (result.code !== 'BINARY_FILE' && result.code !== 'FILE_TOO_LARGE') {
    throw new Error(result.error)
  }
  void logFrontendError({
    level: 'info',
    source: 'editor-store.openFile',
    message: `opened '${basename(filePath)}' as unsupported (${result.code})`
  })
  return result.code === 'BINARY_FILE'
    ? {
        ...base,
        kind: 'unsupported',
        isDirty: false,
        reason: 'binary',
        ...(await sizeOf(filePath))
      }
    : {
        ...base,
        kind: 'unsupported',
        isDirty: false,
        reason: 'too-large',
        ...parseTooLarge(result.error)
      }
}
