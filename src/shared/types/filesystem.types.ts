export interface DirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  extension: string | null
  size: number
  modifiedAt: number
  /** True when the entry matches a commonly-ignored name (e.g. node_modules, .env, dist). Shown dimmed but still accessible. */
  ignored?: boolean
}

export interface FileContent {
  content: string
  encoding: string
  size: number
  modifiedAt: number
}

export interface FileInfo {
  path: string
  size: number
  modifiedAt: number
  type: 'file' | 'directory'
  isReadOnly: boolean
  isBinary: boolean
}

export interface FileChangeEvent {
  type: 'change' | 'add' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
}

export interface FileSearchMatch {
  lineNumber: number
  lineText: string
}

export interface FileSearchResult {
  filePath: string
  matches: FileSearchMatch[]
}

/**
 * One filename-search hit. `ignored` is true when the path runs through a
 * commonly-ignored directory or a hidden/cruft segment, so the @-mention
 * picker can dim it. Mirrors the Rust `SearchFileHit` in `commands.rs`.
 * See ADR 0003.
 */
export interface SearchFileHit {
  path: string
  ignored: boolean
}

export interface FileSearchResponse {
  results: FileSearchResult[]
  truncated: boolean
  scannedFiles: number
  failedFiles: number
}

export const FilesystemErrorCodes = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  BINARY_FILE: 'BINARY_FILE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WRITE_FAILED: 'WRITE_FAILED',
  WATCH_FAILED: 'WATCH_FAILED',
  PATH_INVALID: 'PATH_INVALID',
  FILE_EXISTS: 'FILE_EXISTS',
  DELETE_FAILED: 'DELETE_FAILED',
  RENAME_FAILED: 'RENAME_FAILED'
} as const

export type FilesystemErrorCode = (typeof FilesystemErrorCodes)[keyof typeof FilesystemErrorCodes]
