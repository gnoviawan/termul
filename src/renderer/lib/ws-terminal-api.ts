import type { TerminalApi, TerminalSpawnOptions, IpcResult, GitStatus } from '@shared/types/ipc.types'
import type { WsAdapter } from '@shared/types/ws.types'

export function createWsTerminalApi(ws: WsAdapter): TerminalApi {
  const spawn = async (options?: TerminalSpawnOptions): Promise<IpcResult<{ id: string; shell: string; cwd: string }>> => {
    try {
      const data = await ws.invoke<{ id: string; shell: string; cwd: string }>('terminal_spawn', options)
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'SPAWN_FAILED' }
    }
  }

  const write = async (terminalId: string, data: string): Promise<IpcResult<void>> => {
    try {
      await ws.invoke('terminal_write', { terminalId, data })
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'WRITE_FAILED' }
    }
  }

  const resize = async (terminalId: string, cols: number, rows: number): Promise<IpcResult<void>> => {
    try {
      await ws.invoke('terminal_resize', { terminalId, cols, rows })
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'RESIZE_FAILED' }
    }
  }

  const kill = async (terminalId: string): Promise<IpcResult<void>> => {
    try {
      await ws.invoke('terminal_kill', { terminalId })
      return { success: true, data: undefined }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'KILL_FAILED' }
    }
  }

  const onData = (callback: (terminalId: string, data: string) => void): (() => void) => {
    return ws.listen('terminal-data', (payload) => {
      const terminalId = (payload.id || payload.terminalId) as string
      const data = payload.data as string
      if (terminalId && data) callback(terminalId, data)
    })
  }

  const onExit = (callback: (terminalId: string, exitCode: number, signal?: number) => void): (() => void) => {
    return ws.listen('terminal-exit', (payload) => {
      const terminalId = (payload.id || payload.terminalId) as string
      const exitCode = payload.exitCode as number
      const signal = payload.signal as number | undefined
      if (terminalId && exitCode !== undefined) callback(terminalId, exitCode, signal)
    })
  }

  const onCwdChanged = (callback: (terminalId: string, cwd: string) => void): (() => void) => {
    return ws.listen('terminal-cwd-changed', (payload) => {
      const terminalId = payload.terminalId as string
      const cwd = payload.cwd as string
      if (terminalId && cwd) callback(terminalId, cwd)
    })
  }

  const getCwd = async (terminalId: string): Promise<IpcResult<string | null>> => {
    try {
      const data = await ws.invoke<string | null>('terminal_get_cwd', { terminalId })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'UNKNOWN_ERROR' }
    }
  }

  const onGitBranchChanged = (callback: (terminalId: string, branch: string | null) => void): (() => void) => {
    return ws.listen('terminal-git-branch-changed', (payload) => {
      const terminalId = payload.terminalId as string
      const branch = payload.branch as string | null
      if (terminalId) callback(terminalId, branch)
    })
  }

  const getGitBranch = async (terminalId: string): Promise<IpcResult<string | null>> => {
    try {
      const data = await ws.invoke<string | null>('terminal_get_git_branch', { terminalId })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'UNKNOWN_ERROR' }
    }
  }

  const onGitStatusChanged = (callback: (terminalId: string, status: GitStatus | null) => void): (() => void) => {
    return ws.listen('terminal-git-status-changed', (payload) => {
      const terminalId = payload.terminalId as string
      const status = payload.status as GitStatus | null
      if (terminalId) callback(terminalId, status)
    })
  }

  const getGitStatus = async (terminalId: string): Promise<IpcResult<GitStatus | null>> => {
    try {
      const data = await ws.invoke<GitStatus | null>('terminal_get_git_status', { terminalId })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'UNKNOWN_ERROR' }
    }
  }

  const onExitCodeChanged = (callback: (terminalId: string, exitCode: number) => void): (() => void) => {
    return ws.listen('terminal-exit-code-changed', (payload) => {
      const terminalId = payload.terminalId as string
      const exitCode = payload.exitCode as number
      if (terminalId && exitCode !== undefined) callback(terminalId, exitCode)
    })
  }

  const getExitCode = async (terminalId: string): Promise<IpcResult<number | null>> => {
    try {
      const data = await ws.invoke<number | null>('terminal_get_exit_code', { terminalId })
      return { success: true, data }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), code: 'UNKNOWN_ERROR' }
    }
  }

  const updateOrphanDetection = async (_enabled: boolean, _timeout: number | null): Promise<IpcResult<void>> => {
    return { success: true, data: undefined }
  }

  return {
    spawn,
    write,
    resize,
    kill,
    onData,
    onExit,
    onCwdChanged,
    getCwd,
    onGitBranchChanged,
    getGitBranch,
    onGitStatusChanged,
    getGitStatus,
    onExitCodeChanged,
    getExitCode,
    updateOrphanDetection,
  }
}
