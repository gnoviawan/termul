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
  contentHash?: string
  tracksHash?: true
  externalConflict?: boolean
  draftConflict?: { draftContent: string; draftSavedAt: number }
}

interface ViewerFileState extends FileStateBase {
  kind: MediaKind
  isDirty: false
  revision: number
}

export type UnsupportedReason =
  | { reason: 'binary'; size?: number }
  | { reason: 'too-large'; size?: number; limit?: number }

type UnsupportedFileState = FileStateBase & {
  kind: 'unsupported'
  isDirty: false
} & UnsupportedReason

type MediaFileState = ViewerFileState | UnsupportedFileState

export type EditorFileState = TextFileState | MediaFileState

function textFileState(
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

export function parseTooLarge(message: string): { size?: number; limit?: number } {
  const match = /\((\d+) bytes, max (\d+)\)/.exec(message)
  return match ? { size: Number(match[1]), limit: Number(match[2]) } : {}
}

async function sizeOf(filePath: string): Promise<{ size?: number }> {
  try {
    const info = await filesystemApi.getFileInfo(filePath)
    return info.success ? { size: info.data.size } : {}
  } catch {
    return {}
  }
}

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
