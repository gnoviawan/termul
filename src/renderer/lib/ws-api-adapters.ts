import type {
  TerminalApi,
  FilesystemApi,
  WindowApi,
  DialogApi,
  SystemApi,
  PersistenceApi,
  ClipboardApi,
  GitApi,
  TunnelApi,
  IpcResult,
  GitStatus,
  DirectoryEntry,
  FileContent,
  FileInfo,
  GitStatusDetail,
  TunnelSession,
  TunnelConfig,
  ShellApi,
  DetectedShells
} from '@shared/types/ipc.types'
import type { WsAdapter } from '@shared/types/ws.types'
import { createWsTerminalApi } from './ws-terminal-api'
import { tauriDialogApi } from './tauri-dialog-api'
import { tauriWindowApi } from './tauri-window-api'

function getWs(): WsAdapter {
  const ws = (window as unknown as Record<string, unknown>).__WS_ADAPTER__ as WsAdapter
  if (!ws) throw new Error("WebSocket adapter not initialized")
  return ws
}

export const wsFilesystemApi: FilesystemApi = {
  async readDirectory(dirPath: string) {
    try {
      const data = await getWs().invoke<DirectoryEntry[]>('read_directory', { dirPath })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: String(error), code: 'READ_DIR_ERROR' }
    }
  },
  async readFile(filePath: string) {
    try {
      const data = await getWs().invoke<{ content: string }>('read_file', { filePath })
      return { success: true, data: { content: data.content, encoding: 'utf-8', size: data.content.length, modifiedAt: Date.now() } }
    } catch (error) {
      return { success: false, error: String(error), code: 'READ_FILE_ERROR' }
    }
  },
  async getFileInfo(filePath: string) {
    return { success: true, data: { path: filePath, size: 0, modifiedAt: Date.now(), type: 'file', isReadOnly: false, isBinary: false } }
  },
  async searchContent() {
    return { success: true, data: { results: [], truncated: false, scannedFiles: 0, failedFiles: 0 } }
  },
  async searchContentStreamStart() { return { success: true, data: undefined } },
  async searchContentStreamCancel() { return { success: true, data: undefined } },
  onSearchContentBatch() { return () => {} },
  async searchFileNames() { return { success: true, data: { files: [], truncated: false } } },
  onSearchContentDone() { return () => {} },
  async writeFile(filePath: string, content: string) {
    try {
      await getWs().invoke('write_file', { filePath, content })
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: String(error), code: 'WRITE_FILE_ERROR' }
    }
  },
  async createFile(filePath: string, content = "") {
    return this.writeFile(filePath, content)
  },
  async createDirectory(dirPath: string) {
    try {
      await getWs().invoke('create_directory', { dirPath })
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: String(error), code: 'MKDIR_ERROR' }
    }
  },
  async deletePath(path: string, options) {
    try {
      await getWs().invoke('delete_path', { path, recursive: options?.recursive })
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: String(error), code: 'DELETE_ERROR' }
    }
  },
  async renameFile(oldPath: string, newPath: string) {
    try {
      await getWs().invoke('rename_path', { oldPath, newPath })
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: String(error), code: 'RENAME_ERROR' }
    }
  },
  async watchDirectory() { return { success: true, data: undefined } },
  async unwatchDirectory() { return { success: true, data: undefined } },
  onFileChanged() { return () => {} },
  onFileCreated() { return () => {} },
  onFileDeleted() { return () => {} }
}

export const wsWindowApi: typeof tauriWindowApi = {
  async minimize() { return { success: true, data: undefined } },
  async toggleMaximize() { return { success: true, data: undefined } },
  async close() { return { success: true, data: undefined } },
  async isMaximized() { return { success: true, data: false } },
  onMaximizeChange(_callback: (maximized: boolean) => void) { return () => {} },
  onCloseRequested(_callback: () => Promise<boolean>) { return () => {} },
  async setPosition(_x: number, _y: number) { return { success: true, data: undefined } },
  async setSize(_width: number, _height: number) { return { success: true, data: undefined } },
  async getPosition() { return { success: true, data: { x: 0, y: 0 } } },
  async getSize() { return { success: true, data: { width: 1024, height: 768 } } },
  respondToClose(_response: 'close' | 'cancel') {}
}

export const wsDialogApi: typeof tauriDialogApi = {
  async selectDirectory() {
    return { success: false, error: 'File dialog not supported in browser', code: 'UNSUPPORTED' }
  },
  async selectFile() {
    return { success: false, error: 'File dialog not supported in browser', code: 'UNSUPPORTED' }
  },
  async saveFile() {
    return { success: false, error: 'File dialog not supported in browser', code: 'UNSUPPORTED' }
  },
  async confirmClose(message: string) {
    return window.confirm(message)
  },
  async showMessage(msg: string, title = 'Info') {
    window.alert(`${title}: ${msg}`)
  }
}

export const wsSystemApi: SystemApi = {
  async getHomeDirectory() {
    try {
      const data = await getWs().invoke<string>('get_home_directory')
      return { success: true, data }
    } catch {
      return { success: true, data: '/' }
    }
  },
  onPowerResume() {
    return () => {}
  }
}

export const wsClipboardApi: ClipboardApi = {
  async readText() {
    try {
      const text = await navigator.clipboard.readText()
      return { success: true, data: text }
    } catch {
      return { success: false, error: 'Clipboard read denied', code: 'CLIPBOARD_ERROR' }
    }
  },
  async writeText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      return { success: true, data: undefined }
    } catch {
      return { success: false, error: 'Clipboard write denied', code: 'CLIPBOARD_ERROR' }
    }
  },
  async hasImage() {
    try {
      const items = await navigator.clipboard.read()
      const hasImage = items.some((item) => item.types.includes('image/png'))
      return { success: true, data: hasImage }
    } catch {
      return { success: false, error: 'Clipboard read denied', code: 'CLIPBOARD_ERROR' }
    }
  }
}

const WS_STORE_KEY = 'termul-web-settings'

export const wsPersistenceApi: PersistenceApi = {
  async read<T>(key: string) {
    try {
      const raw = localStorage.getItem(`${WS_STORE_KEY}-${key}`)
      if (!raw) return { success: false, error: `Key not found: ${key}`, code: 'KEY_NOT_FOUND' }
      return { success: true, data: JSON.parse(raw) as T }
    } catch (err) {
      return { success: false, error: String(err), code: 'READ_ERROR' }
    }
  },
  async write<T>(key: string, data: T) {
    try {
      localStorage.setItem(`${WS_STORE_KEY}-${key}`, JSON.stringify(data))
      return { success: true, data: undefined }
    } catch (err) {
      return { success: false, error: String(err), code: 'WRITE_ERROR' }
    }
  },
  async writeDebounced<T>(key: string, data: T) {
    return this.write(key, data)
  },
  async delete(key: string) {
    try {
      localStorage.removeItem(`${WS_STORE_KEY}-${key}`)
      return { success: true, data: undefined }
    } catch (err) {
      return { success: false, error: String(err), code: 'DELETE_ERROR' }
    }
  },
  async flushPendingWrites() {
    return { success: true, data: undefined }
  }
}

export const wsGitApi: GitApi = {
  async getStatus(cwd: string): Promise<GitStatusDetail[]> {
    try {
      const data = await getWs().invoke<GitStatusDetail[]>('git_get_status', { cwd })
      return data || []
    } catch {
      return []
    }
  },
  async getDiff(cwd: string, path: string): Promise<string> {
    try {
      const data = await getWs().invoke<string>('git_get_diff', { cwd, path })
      return data || ''
    } catch {
      return ''
    }
  }
}

export const wsTunnelApi: TunnelApi = {
  async start(config: TunnelConfig): Promise<IpcResult<TunnelSession>> {
    try {
      const data = await getWs().invoke<TunnelSession>('tunnel_start', { config })
      return { success: true, data }
    } catch (err) {
      return { success: false, error: String(err), code: 'TUNNEL_ERROR' }
    }
  },
  async stop(id: string): Promise<IpcResult<void>> {
    try {
      await getWs().invoke('tunnel_stop', { tunnelId: id })
      return { success: true, data: undefined }
    } catch (err) {
      return { success: false, error: String(err), code: 'TUNNEL_ERROR' }
    }
  },
  async getStatus(tunnelId: string): Promise<IpcResult<TunnelSession | null>> {
    try {
      const data = await getWs().invoke<TunnelSession | null>('tunnel_get_status', { tunnelId })
      return { success: true, data: data ?? null }
    } catch (err) {
      return { success: false, error: String(err), code: 'TUNNEL_ERROR' }
    }
  },
  async list(): Promise<IpcResult<TunnelSession[]>> {
    try {
      const data = await getWs().invoke<TunnelSession[]>('tunnel_list')
      return { success: true, data }
    } catch (err) {
      return { success: false, error: String(err), code: 'TUNNEL_ERROR' }
    }
  },
  onStatusChanged() { return () => {} },
  onLog() { return () => {} }
}

export const wsTerminalApi: TerminalApi = {
  spawn: (options) => createWsTerminalApi(getWs()).spawn(options),
  write: (terminalId, data) => createWsTerminalApi(getWs()).write(terminalId, data),
  resize: (terminalId, cols, rows) => createWsTerminalApi(getWs()).resize(terminalId, cols, rows),
  kill: (terminalId) => createWsTerminalApi(getWs()).kill(terminalId),
  onData: (callback) => createWsTerminalApi(getWs()).onData(callback),
  onExit: (callback) => createWsTerminalApi(getWs()).onExit(callback),
  onCwdChanged: (callback) => createWsTerminalApi(getWs()).onCwdChanged(callback),
  getCwd: (terminalId) => createWsTerminalApi(getWs()).getCwd(terminalId),
  onGitBranchChanged: (callback) => createWsTerminalApi(getWs()).onGitBranchChanged(callback),
  getGitBranch: (terminalId) => createWsTerminalApi(getWs()).getGitBranch(terminalId),
  onGitStatusChanged: (callback) => createWsTerminalApi(getWs()).onGitStatusChanged(callback),
  getGitStatus: (terminalId) => createWsTerminalApi(getWs()).getGitStatus(terminalId),
  onExitCodeChanged: (callback) => createWsTerminalApi(getWs()).onExitCodeChanged(callback),
  getExitCode: (terminalId) => createWsTerminalApi(getWs()).getExitCode(terminalId),
  updateOrphanDetection: (enabled, timeout) => createWsTerminalApi(getWs()).updateOrphanDetection(enabled, timeout),
  async takeover(terminalId: string) {
    try {
      // Web side always identifies itself as "web" so Tauri suspends.
      await getWs().invoke('terminal_takeover', { terminalId, clientType: 'web' })
      return { success: true, data: undefined }
    } catch (err) {
      return { success: false, error: String(err), code: 'TAKEOVER_ERROR' }
    }
  },
}

let cachedWsShells: IpcResult<DetectedShells> | null = null
let wsShellCachePromise: Promise<IpcResult<DetectedShells>> | null = null

/** Wait for `__WS_ADAPTER__` to appear on `window` (up to `maxMs` ms). */
async function waitForWsAdapter(maxMs = 10_000): Promise<WsAdapter | null> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      return getWs()
    } catch {
      await new Promise<void>((r) => setTimeout(r, 250))
    }
  }
  return null
}

export const wsShellApi: ShellApi = {
  async getAvailableShells(): Promise<IpcResult<DetectedShells>> {
    if (cachedWsShells) {
      return cachedWsShells
    }
    if (wsShellCachePromise) {
      return wsShellCachePromise
    }

    wsShellCachePromise = (async () => {
      try {
        // Components can mount before the WS handshake completes — wait for the
        // adapter rather than immediately failing and showing "No shells detected".
        const ws = await waitForWsAdapter()
        if (!ws) {
          return {
            success: false,
            error: 'WebSocket adapter not ready after timeout',
            code: 'DETECT_SHELLS_FAILED'
          }
        }
        const data = await ws.invoke<DetectedShells>('detect_shells')
        return { success: true, data }
      } catch (error) {
        return {
          success: false,
          error: String(error),
          code: 'DETECT_SHELLS_FAILED'
        }
      }
    })()

    const result = await wsShellCachePromise
    if (result.success) {
      cachedWsShells = result
    } else {
      // Don't keep a failed promise cached — allow the next caller to retry.
      wsShellCachePromise = null
    }

    return result
  }
}
