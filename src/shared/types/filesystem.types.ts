export interface DirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  extension: string | null
  size: number
  modifiedAt: number
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
  isReadOnly: boolean
  isBinary: boolean
}

export interface FileChangeEvent {
  type: 'change' | 'add' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
}

export type ReadDirectoryOptions = object

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

export type FilesystemErrorCode =
  (typeof FilesystemErrorCodes)[keyof typeof FilesystemErrorCodes]
