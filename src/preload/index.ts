import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  IpcResult,
  TerminalSpawnOptions,
  TerminalInfo,
  TerminalDataCallback,
  TerminalExitCallback,
  TerminalCwdChangedCallback,
  TerminalGitBranchChangedCallback,
  TerminalGitStatusChangedCallback,
  TerminalExitCodeChangedCallback,
  GitStatus,
  TerminalApi,
  DialogApi,
  ShellApi,
  DetectedShells,
  PersistenceApi,
  SystemApi,
  KeyboardApi,
  KeyboardShortcutCallback,
  ClipboardApi,
  FilesystemApi,
  FileChangeCallback,
  DirectoryEntry,
  FileContent,
  FileInfo,
  ReadDirectoryOptions,
  FileChangeEvent,
  WindowApi,
  WindowMaximizeChangedCallback,
  AppCloseRequestedCallback,
  AppCloseResponse,
  VisibilityApi
} from '../shared/types/ipc.types'
import type {
  UpdateInfo,
  UpdateState,
  DownloadProgress,
  UpdaterApi,
  UpdateAvailableCallback,
  UpdateDownloadedCallback,
  DownloadProgressCallback,
  UpdaterErrorCallback,
  UpdaterErrorCode
} from '../shared/types/updater.types'

// Terminal API for renderer
const terminalApi: TerminalApi = {
  spawn: (options?: TerminalSpawnOptions): Promise<IpcResult<TerminalInfo>> => {
    return ipcRenderer.invoke('terminal:spawn', options)
  },

  write: (terminalId: string, data: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('terminal:write', terminalId, data)
  },

  resize: (terminalId: string, cols: number, rows: number): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('terminal:resize', terminalId, cols, rows)
  },

  kill: (terminalId: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('terminal:kill', terminalId)
  },

  onData: (callback: TerminalDataCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      terminalId: string,
      data: string
    ): void => {
      callback(terminalId, data)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => {
      ipcRenderer.off('terminal:data', listener)
    }
  },

  onExit: (callback: TerminalExitCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      terminalId: string,
      exitCode: number,
      signal?: number
    ): void => {
      callback(terminalId, exitCode, signal)
    }
    ipcRenderer.on('terminal:exit', listener)
    return () => {
      ipcRenderer.off('terminal:exit', listener)
    }
  },

  onCwdChanged: (callback: TerminalCwdChangedCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      terminalId: string,
      cwd: string
    ): void => {
      callback(terminalId, cwd)
    }
    ipcRenderer.on('terminal:cwd-changed', listener)
    return () => {
      ipcRenderer.off('terminal:cwd-changed', listener)
    }
  },

  getCwd: (terminalId: string): Promise<IpcResult<string | null>> => {
    return ipcRenderer.invoke('terminal:getCwd', terminalId)
  },

  onGitBranchChanged: (callback: TerminalGitBranchChangedCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      terminalId: string,
      branch: string | null
    ): void => {
      callback(terminalId, branch)
    }
    ipcRenderer.on('terminal:git-branch-changed', listener)
    return () => {
      ipcRenderer.off('terminal:git-branch-changed', listener)
    }
  },

  getGitBranch: (terminalId: string): Promise<IpcResult<string | null>> => {
    return ipcRenderer.invoke('terminal:getGitBranch', terminalId)
  },

  onGitStatusChanged: (callback: TerminalGitStatusChangedCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      terminalId: string,
      status: GitStatus | null
    ): void => {
      callback(terminalId, status)
    }
    ipcRenderer.on('terminal:git-status-changed', listener)
    return () => {
      ipcRenderer.off('terminal:git-status-changed', listener)
    }
  },

  getGitStatus: (terminalId: string): Promise<IpcResult<GitStatus | null>> => {
    return ipcRenderer.invoke('terminal:getGitStatus', terminalId)
  },

  onExitCodeChanged: (callback: TerminalExitCodeChangedCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      terminalId: string,
      exitCode: number
    ): void => {
      callback(terminalId, exitCode)
    }
    ipcRenderer.on('terminal:exit-code-changed', listener)
    return () => {
      ipcRenderer.off('terminal:exit-code-changed', listener)
    }
  },

  getExitCode: (terminalId: string): Promise<IpcResult<number | null>> => {
    return ipcRenderer.invoke('terminal:getExitCode', terminalId)
  },

  updateOrphanDetection: (enabled: boolean, timeout: number | null): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('terminal:updateOrphanDetection', enabled, timeout)
  }
}

// Dialog API for renderer
const dialogApi: DialogApi = {
  selectDirectory: (): Promise<IpcResult<string>> => {
    return ipcRenderer.invoke('dialog:selectDirectory')
  }
}

// Shell API for renderer
const shellApi: ShellApi = {
  getAvailableShells: (): Promise<IpcResult<DetectedShells>> => {
    return ipcRenderer.invoke('shell:detect')
  }
}

// Persistence API for renderer
const persistenceApi: PersistenceApi = {
  read: <T>(key: string): Promise<IpcResult<T>> => {
    return ipcRenderer.invoke('persistence:read', key)
  },

  write: <T>(key: string, data: T): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('persistence:write', key, data)
  },

  writeDebounced: <T>(key: string, data: T): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('persistence:writeDebounced', key, data)
  },

  delete: (key: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('persistence:delete', key)
  }
}

// System API for renderer
const systemApi: SystemApi = {
  getHomeDirectory: (): Promise<IpcResult<string>> => {
    return ipcRenderer.invoke('system:getHomeDirectory')
  }
}

// Keyboard API for renderer - handles shortcuts intercepted at main process level
const keyboardApi: KeyboardApi = {
  onShortcut: (callback: KeyboardShortcutCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      shortcut: 'nextTerminal' | 'prevTerminal' | 'zoomIn' | 'zoomOut' | 'zoomReset'
    ): void => {
      callback(shortcut)
    }
    ipcRenderer.on('keyboard:shortcut', listener)
    return () => {
      ipcRenderer.off('keyboard:shortcut', listener)
    }
  }
}

// Clipboard API for renderer
const clipboardApi: ClipboardApi = {
  readText: (): Promise<IpcResult<string>> => {
    return ipcRenderer.invoke('clipboard:readText')
  },

  writeText: (text: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('clipboard:writeText', text)
  }
}

// Visibility API for renderer
const visibilityApi: VisibilityApi = {
  setVisibilityState: (isVisible: boolean): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('visibility:setState', isVisible)
  }
}

// Updater API for renderer
const updaterApi: UpdaterApi = {
  checkForUpdates: (): Promise<IpcResult<UpdateInfo | null>> => {
    return ipcRenderer.invoke('updater:checkForUpdates')
  },
  downloadUpdate: (): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('updater:downloadUpdate')
  },
  installAndRestart: (): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('updater:installAndRestart')
  },
  skipVersion: (version: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('updater:skipVersion', version)
  },
  getState: (): Promise<IpcResult<UpdateState>> => {
    return ipcRenderer.invoke('updater:getState')
  },
  setAutoUpdateEnabled: (enabled: boolean): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('updater:setAutoUpdateEnabled', enabled)
  },
  getAutoUpdateEnabled: (): Promise<IpcResult<boolean>> => {
    return ipcRenderer.invoke('updater:getAutoUpdateEnabled')
  },
  onUpdateAvailable: (callback: UpdateAvailableCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, info: UpdateInfo): void => {
      callback(info)
    }
    ipcRenderer.on('updater:update-available', listener)
    return () => {
      ipcRenderer.off('updater:update-available', listener)
    }
  },
  onUpdateDownloaded: (callback: UpdateDownloadedCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, info: UpdateInfo): void => {
      callback(info)
    }
    ipcRenderer.on('updater:update-downloaded', listener)
    return () => {
      ipcRenderer.off('updater:update-downloaded', listener)
    }
  },
  onDownloadProgress: (callback: DownloadProgressCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, progress: DownloadProgress): void => {
      callback(progress)
    }
    ipcRenderer.on('updater:download-progress', listener)
    return () => {
      ipcRenderer.off('updater:download-progress', listener)
    }
  },
  onError: (callback: UpdaterErrorCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, error: { code: string; message: string }): void => {
      // Note: IPC sends { code, message } but callback expects (error: string, code: UpdaterErrorCode)
      callback(error.message, error.code as UpdaterErrorCode)
    }
    ipcRenderer.on('updater:error', listener)
    return () => {
      ipcRenderer.off('updater:error', listener)
    }
  }
}

// Filesystem API for renderer
const filesystemApi: FilesystemApi = {
  readDirectory: (
    dirPath: string,
    options?: ReadDirectoryOptions
  ): Promise<IpcResult<DirectoryEntry[]>> => {
    return ipcRenderer.invoke('filesystem:readDirectory', dirPath, options)
  },

  readFile: (filePath: string): Promise<IpcResult<FileContent>> => {
    return ipcRenderer.invoke('filesystem:readFile', filePath)
  },

  getFileInfo: (filePath: string): Promise<IpcResult<FileInfo>> => {
    return ipcRenderer.invoke('filesystem:getFileInfo', filePath)
  },

  writeFile: (filePath: string, content: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('filesystem:writeFile', filePath, content)
  },

  createFile: (filePath: string, content?: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('filesystem:createFile', filePath, content)
  },

  createDirectory: (dirPath: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('filesystem:createDirectory', dirPath)
  },

  deleteFile: (filePath: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('filesystem:deleteFile', filePath)
  },

  renameFile: (oldPath: string, newPath: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('filesystem:renameFile', oldPath, newPath)
  },

  watchDirectory: (dirPath: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('filesystem:watchDirectory', dirPath)
  },

  unwatchDirectory: (dirPath: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('filesystem:unwatchDirectory', dirPath)
  },

  onFileChanged: (callback: FileChangeCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, event: FileChangeEvent): void => {
      callback(event)
    }
    ipcRenderer.on('filesystem:file-changed', listener)
    return () => {
      ipcRenderer.off('filesystem:file-changed', listener)
    }
  },

  onFileCreated: (callback: FileChangeCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, event: FileChangeEvent): void => {
      callback(event)
    }
    ipcRenderer.on('filesystem:file-created', listener)
    return () => {
      ipcRenderer.off('filesystem:file-created', listener)
    }
  },

  onFileDeleted: (callback: FileChangeCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, event: FileChangeEvent): void => {
      callback(event)
    }
    ipcRenderer.on('filesystem:file-deleted', listener)
    return () => {
      ipcRenderer.off('filesystem:file-deleted', listener)
    }
  }
}

// Window API for renderer
const windowApi: WindowApi = {
  minimize: (): void => {
    ipcRenderer.send('window:minimize')
  },

  toggleMaximize: (): Promise<IpcResult<boolean>> => {
    return ipcRenderer.invoke('window:toggleMaximize')
  },

  close: (): void => {
    ipcRenderer.send('window:close')
  },

  onMaximizeChange: (callback: WindowMaximizeChangedCallback): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      isMaximized: boolean
    ): void => {
      callback(isMaximized)
    }
    ipcRenderer.on('window:maximize-changed', listener)
    return () => {
      ipcRenderer.off('window:maximize-changed', listener)
    }
  },

  onCloseRequested: (callback: AppCloseRequestedCallback): (() => void) => {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on('app:close-requested', listener)
    return () => {
      ipcRenderer.off('app:close-requested', listener)
    }
  },

  respondToClose: (response: AppCloseResponse): void => {
    ipcRenderer.send('app:close-response', response)
  }
}

// Custom APIs for renderer
const api = {
  terminal: terminalApi,
  dialog: dialogApi,
  shell: shellApi,
  persistence: persistenceApi,
  system: systemApi,
  keyboard: keyboardApi,
  updater: updaterApi,
  clipboard: clipboardApi,
  filesystem: filesystemApi,
  window: windowApi,
  visibility: visibilityApi
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI
  // @ts-expect-error (define in dts)
  window.api = api
}
