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
  KeyboardShortcutsApi,
  WorktreeApi,
  WorktreeMetadata,
  WorktreeStatus,
  ArchivedWorktree,
  CreateWorktreeDto,
  DeleteWorktreeOptions,
  StatusChangedCallback,
  WorktreeCreatedCallback,
  WorktreeDeletedCallback,
  MergeApi,
  AIPromptApi,
  ProjectApi,
  GitignoreApi,
  ParseGitignoreDto,
  SaveProfileDto,
  DeleteProfileDto,
  LoadProfilesDto
} from '../shared/types/ipc.types'
import type {
  ConflictDetectionResult,
  MergePreview,
  MergeResult,
  ConflictedFile,
  MergeValidationResult,
  DetectConflictsDto,
  MergePreviewDto,
  ExecuteMergeDto,
  ValidateMergeDto,
  MergePreference
} from '../shared/types/merge.types'
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
import type {
  GeneratedPrompt,
  AIToolTemplate,
  ValidationResult,
  GeneratePromptDto,
  RegisterTemplateDto,
  ValidateTemplateDto
} from '../shared/types/ai-prompt.types'
import type {
  KeyboardShortcut,
  UpdateShortcutDto
} from '../shared/types/keyboard-shortcuts.types'

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

// Worktree API for renderer
// Story 1.6 - Task 6: Update IPC Channels for Archive/Delete
const worktreeApi: WorktreeApi = {
  list: (projectId: string): Promise<IpcResult<WorktreeMetadata[]>> => {
    return ipcRenderer.invoke('worktree:list', projectId)
  },

  create: (data: CreateWorktreeDto): Promise<IpcResult<WorktreeMetadata>> => {
    return ipcRenderer.invoke('worktree:create', data)
  },

  delete: (worktreeId: string, options?: DeleteWorktreeOptions): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('worktree:delete', worktreeId, options)
  },

  archive: (worktreeId: string): Promise<IpcResult<ArchivedWorktree>> => {
    return ipcRenderer.invoke('worktree:archive', worktreeId)
  },

  restore: (archiveId: string, projectId: string): Promise<IpcResult<WorktreeMetadata>> => {
    return ipcRenderer.invoke('worktree:restore', archiveId, projectId)
  },

  listArchived: (projectId: string): Promise<IpcResult<ArchivedWorktree[]>> => {
    return ipcRenderer.invoke('worktree:list-archived', projectId)
  },

  deleteArchive: (archiveId: string, projectId: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('worktree:delete-archive', archiveId, projectId)
  },

  cleanupArchives: (projectId: string): Promise<IpcResult<{ cleaned: number }>> => {
    return ipcRenderer.invoke('worktree:cleanup-archives', projectId)
  },

  getStatus: (worktreeId: string): Promise<IpcResult<WorktreeStatus>> => {
    return ipcRenderer.invoke('worktree:status', worktreeId)
  },

  onStatusChanged: (callback: StatusChangedCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, worktreeId: string, status: WorktreeStatus): void => {
      callback(worktreeId, status)
    }
    ipcRenderer.on('worktree:status-changed', listener)
    return () => {
      ipcRenderer.off('worktree:status-changed', listener)
    }
  },

  onCreated: (callback: WorktreeCreatedCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, worktree: WorktreeMetadata): void => {
      callback(worktree)
    }
    ipcRenderer.on('worktree:created', listener)
    return () => {
      ipcRenderer.off('worktree:created', listener)
    }
  },

  onDeleted: (callback: WorktreeDeletedCallback): (() => void) => {
    const listener = (_event: IpcRendererEvent, worktreeId: string): void => {
      callback(worktreeId)
    }
    ipcRenderer.on('worktree:deleted', listener)
    return () => {
      ipcRenderer.off('worktree:deleted', listener)
    }
  }
}

// Merge API for renderer
// Story 2.1 - Task 4: Implement Preload API
const mergeApi: MergeApi = {
  detectConflicts: (dto: DetectConflictsDto): Promise<IpcResult<ConflictDetectionResult>> => {
    return ipcRenderer.invoke('merge:detect-conflicts', dto)
  },

  getPreview: (dto: MergePreviewDto): Promise<IpcResult<MergePreview>> => {
    return ipcRenderer.invoke('merge:get-preview', dto)
  },

  execute: (dto: ExecuteMergeDto): Promise<IpcResult<MergeResult>> => {
    return ipcRenderer.invoke('merge:execute', dto)
  },

  getConflictedFiles: (projectId: string): Promise<IpcResult<ConflictedFile[]>> => {
    return ipcRenderer.invoke('merge:get-conflicted-files', projectId)
  },

  validate: (dto: ValidateMergeDto): Promise<IpcResult<MergeValidationResult>> => {
    return ipcRenderer.invoke('merge:validate', dto)
  },

  getPreference: (): Promise<IpcResult<MergePreference>> => {
    return ipcRenderer.invoke('merge:get-preference')
  },

  setPreference: (pref: MergePreference): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('merge:set-preference', pref)
  },

  getBranches: (projectId: string): Promise<IpcResult<string[]>> => {
    return ipcRenderer.invoke('merge:get-branches', projectId)
  }
}

// AI Prompt API for renderer
// Story 3.1 - Task 5: Extend Preload API
const aiPromptApi: AIPromptApi = {
  generate: (dto: GeneratePromptDto): Promise<IpcResult<GeneratedPrompt>> => {
    return ipcRenderer.invoke('ai-prompt:generate', dto)
  },

  listTemplates: (): Promise<IpcResult<AIToolTemplate[]>> => {
    return ipcRenderer.invoke('ai-prompt:list-templates')
  },

  registerTemplate: (dto: RegisterTemplateDto): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('ai-prompt:register-template', dto)
  },

  validateTemplate: (dto: ValidateTemplateDto): Promise<IpcResult<ValidationResult>> => {
    return ipcRenderer.invoke('ai-prompt:validate-template', dto)
  }
}

// Keyboard Shortcuts API for renderer
// Story 3.3 - Task 2.7: Add keyboard shortcuts API to preload script
const keyboardShortcutsApi: KeyboardShortcutsApi = {
  listShortcuts: (): Promise<IpcResult<KeyboardShortcut[]>> => {
    return ipcRenderer.invoke('keyboard-shortcuts:list')
  },

  updateShortcut: (dto: UpdateShortcutDto): Promise<IpcResult<KeyboardShortcut>> => {
    return ipcRenderer.invoke('keyboard-shortcuts:update', dto)
  },

  resetShortcuts: (): Promise<IpcResult<KeyboardShortcut[]>> => {
    return ipcRenderer.invoke('keyboard-shortcuts:reset')
  },

  getShortcutForCommand: (command: string): Promise<IpcResult<KeyboardShortcut | null>> => {
    return ipcRenderer.invoke('keyboard-shortcuts:get-shortcut', command)
  },

  formatKeybinding: (keybinding: { modifier: string; key: string }): Promise<IpcResult<string>> => {
    return ipcRenderer.invoke('keyboard-shortcuts:format-keybinding', keybinding)
  }
}

// Project API for renderer
const projectApi: ProjectApi = {
  register: (projectId: string, projectPath: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('project:register', projectId, projectPath)
  },

  getPath: (projectId: string): Promise<IpcResult<string>> => {
    return ipcRenderer.invoke('project:get-path', projectId)
  },

  unregister: (projectId: string): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('project:unregister', projectId)
  }
}

// Gitignore API for renderer
const gitignoreApi: GitignoreApi = {
  parse: (dto: ParseGitignoreDto): Promise<IpcResult<any>> => {
    return ipcRenderer.invoke('gitignore:parse', dto)
  },

  saveProfile: (dto: SaveProfileDto): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('gitignore:profiles:save', dto)
  },

  deleteProfile: (dto: DeleteProfileDto): Promise<IpcResult<void>> => {
    return ipcRenderer.invoke('gitignore:profiles:delete', dto)
  },

  loadProfiles: (dto: LoadProfilesDto): Promise<IpcResult<any>> => {
    return ipcRenderer.invoke('gitignore:profiles:list', dto)
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
  keyboardShortcuts: keyboardShortcutsApi,
  updater: updaterApi,
  worktree: worktreeApi,
  merge: mergeApi,
  aiPrompt: aiPromptApi,
  project: projectApi,
  gitignore: gitignoreApi
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
