import { ipcMain, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { resolve, normalize } from 'path'
import {
  getDefaultFilesystemService,
  FilesystemError
} from '../services/filesystem-service'
import type { IpcResult, IpcErrorCode } from '../../shared/types/ipc.types'
import { IpcErrorCodes } from '../../shared/types/ipc.types'
import type {
  DirectoryEntry,
  FileContent,
  FileInfo,
  ReadDirectoryOptions
} from '../../shared/types/filesystem.types'

let cleanupFileChangeListener: (() => void) | null = null

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function createErrorResult<T>(error: string, code: IpcErrorCode): IpcResult<T> {
  return { success: false, error, code }
}

function mapErrorCode(code: string): IpcErrorCode {
  const mapping: Record<string, IpcErrorCode> = {
    FILE_NOT_FOUND: IpcErrorCodes.FILE_NOT_FOUND,
    FILE_TOO_LARGE: IpcErrorCodes.FILE_TOO_LARGE,
    BINARY_FILE: IpcErrorCodes.BINARY_FILE,
    PERMISSION_DENIED: IpcErrorCodes.PERMISSION_DENIED,
    WRITE_FAILED: IpcErrorCodes.WRITE_FAILED,
    WATCH_FAILED: IpcErrorCodes.WATCH_FAILED,
    PATH_INVALID: IpcErrorCodes.PATH_INVALID,
    FILE_EXISTS: IpcErrorCodes.FILE_EXISTS,
    DELETE_FAILED: IpcErrorCodes.DELETE_FAILED,
    RENAME_FAILED: IpcErrorCodes.RENAME_FAILED
  }
  return mapping[code] || IpcErrorCodes.UNKNOWN_ERROR
}

// Tracks allowed root directories (project paths that the renderer has requested)
const allowedRoots = new Set<string>()

function addAllowedRoot(root: string): void {
  const normalizedRoot = normalize(resolve(root))
  allowedRoots.add(normalizedRoot)
}

function isPathAllowed(p: string): boolean {
  if (!p || typeof p !== 'string') return false
  const resolved = normalize(resolve(p))
  let allowed = false
  allowedRoots.forEach((root) => {
    if (resolved === root || resolved.startsWith(root + '\\') || resolved.startsWith(root + '/')) {
      allowed = true
    }
  })
  return allowed
}

function handleError<T>(error: unknown): IpcResult<T> {
  if (error instanceof FilesystemError) {
    return createErrorResult(error.message, mapErrorCode(error.code))
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    return createErrorResult('File or directory not found', IpcErrorCodes.FILE_NOT_FOUND)
  }
  if (error instanceof Error && 'code' in error && error.code === 'EACCES') {
    return createErrorResult('Permission denied', IpcErrorCodes.PERMISSION_DENIED)
  }
  const message = error instanceof Error ? error.message : 'Unknown error'
  return createErrorResult(message, IpcErrorCodes.UNKNOWN_ERROR)
}

export function registerFilesystemIpc(): void {
  const service = getDefaultFilesystemService()

  // filesystem:readDirectory
  ipcMain.handle(
    'filesystem:readDirectory',
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string,
      options?: ReadDirectoryOptions
    ): Promise<IpcResult<DirectoryEntry[]>> => {
      if (!isPathAllowed(dirPath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        const entries = await service.readDirectory(dirPath, options)
        return createSuccessResult(entries)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:readFile
  ipcMain.handle(
    'filesystem:readFile',
    async (
      _event: IpcMainInvokeEvent,
      filePath: string
    ): Promise<IpcResult<FileContent>> => {
      if (!isPathAllowed(filePath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        const content = await service.readFile(filePath)
        return createSuccessResult(content)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:getFileInfo
  ipcMain.handle(
    'filesystem:getFileInfo',
    async (
      _event: IpcMainInvokeEvent,
      filePath: string
    ): Promise<IpcResult<FileInfo>> => {
      if (!isPathAllowed(filePath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        const info = await service.getFileInfo(filePath)
        return createSuccessResult(info)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:writeFile
  ipcMain.handle(
    'filesystem:writeFile',
    async (
      _event: IpcMainInvokeEvent,
      filePath: string,
      content: string
    ): Promise<IpcResult<void>> => {
      if (!isPathAllowed(filePath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        await service.writeFile(filePath, content)
        return createSuccessResult(undefined)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:createFile
  ipcMain.handle(
    'filesystem:createFile',
    async (
      _event: IpcMainInvokeEvent,
      filePath: string,
      content?: string
    ): Promise<IpcResult<void>> => {
      if (!isPathAllowed(filePath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        await service.createFile(filePath, content)
        return createSuccessResult(undefined)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:createDirectory
  ipcMain.handle(
    'filesystem:createDirectory',
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string
    ): Promise<IpcResult<void>> => {
      if (!isPathAllowed(dirPath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        await service.createDirectory(dirPath)
        return createSuccessResult(undefined)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:deleteFile
  ipcMain.handle(
    'filesystem:deleteFile',
    async (
      _event: IpcMainInvokeEvent,
      filePath: string
    ): Promise<IpcResult<void>> => {
      if (!isPathAllowed(filePath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        await service.deleteFile(filePath)
        return createSuccessResult(undefined)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:renameFile
  ipcMain.handle(
    'filesystem:renameFile',
    async (
      _event: IpcMainInvokeEvent,
      oldPath: string,
      newPath: string
    ): Promise<IpcResult<void>> => {
      if (!isPathAllowed(oldPath) || !isPathAllowed(newPath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        await service.renameFile(oldPath, newPath)
        return createSuccessResult(undefined)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:watchDirectory
  ipcMain.handle(
    'filesystem:watchDirectory',
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string
    ): Promise<IpcResult<void>> => {
      if (!dirPath || typeof dirPath !== 'string') {
        return createErrorResult('Invalid path', IpcErrorCodes.PATH_INVALID)
      }

      const normalizedPath = normalize(resolve(dirPath))

      try {
        // Register each watched project root so unrelated projects can be opened in-session.
        addAllowedRoot(normalizedPath)
        service.watchDirectory(normalizedPath)
        return createSuccessResult(undefined)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // filesystem:unwatchDirectory
  ipcMain.handle(
    'filesystem:unwatchDirectory',
    async (
      _event: IpcMainInvokeEvent,
      dirPath: string
    ): Promise<IpcResult<void>> => {
      if (!isPathAllowed(dirPath)) {
        return createErrorResult('Path is outside allowed project directories', IpcErrorCodes.PATH_INVALID)
      }
      try {
        await service.unwatchDirectory(dirPath)
        return createSuccessResult(undefined)
      } catch (error) {
        return handleError(error)
      }
    }
  )

  // Forward file change events to renderer
  cleanupFileChangeListener = service.onFileChange((event) => {
    const windows = BrowserWindow.getAllWindows()
    let channel: string

    switch (event.type) {
      case 'add':
      case 'addDir':
        channel = 'filesystem:file-created'
        break
      case 'unlink':
      case 'unlinkDir':
        channel = 'filesystem:file-deleted'
        break
      default:
        channel = 'filesystem:file-changed'
    }

    for (const window of windows) {
      window.webContents.send(channel, event)
    }
  })
}

export function unregisterFilesystemIpc(): void {
  ipcMain.removeHandler('filesystem:readDirectory')
  ipcMain.removeHandler('filesystem:readFile')
  ipcMain.removeHandler('filesystem:getFileInfo')
  ipcMain.removeHandler('filesystem:writeFile')
  ipcMain.removeHandler('filesystem:createFile')
  ipcMain.removeHandler('filesystem:createDirectory')
  ipcMain.removeHandler('filesystem:deleteFile')
  ipcMain.removeHandler('filesystem:renameFile')
  ipcMain.removeHandler('filesystem:watchDirectory')
  ipcMain.removeHandler('filesystem:unwatchDirectory')

  allowedRoots.clear()

  if (cleanupFileChangeListener) {
    cleanupFileChangeListener()
    cleanupFileChangeListener = null
  }
}
