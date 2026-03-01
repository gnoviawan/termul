import { invoke, type InvokeArgs } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  IpcResult,
  TerminalApi,
  TerminalInfo,
  TerminalSpawnOptions,
  TerminalDataCallback,
  TerminalExitCallback,
  TerminalCwdChangedCallback,
  TerminalGitBranchChangedCallback,
  TerminalGitStatusChangedCallback,
  TerminalExitCodeChangedCallback,
  GitStatus
} from '@shared/types/ipc.types'

/**
 * IPC Event names matching Rust commands in src-tauri/src/commands.rs
 * Using kebab-case as defined in tech spec
 */
const IPC_EVENTS = {
  TERMINAL_DATA: 'terminal-data',
  TERMINAL_EXIT: 'terminal-exit',
  TERMINAL_CWD_CHANGED: 'terminal-cwd-changed',
  TERMINAL_GIT_BRANCH_CHANGED: 'terminal-git-branch-changed',
  TERMINAL_GIT_STATUS_CHANGED: 'terminal-git-status-changed',
  TERMINAL_EXIT_CODE_CHANGED: 'terminal-exit-code-changed'
} as const

/**
 * IPC Command names matching Rust commands in src-tauri/src/commands/terminal.rs
 */
const IPC_COMMANDS = {
  SPAWN: 'terminal_spawn',
  WRITE: 'terminal_write',
  RESIZE: 'terminal_resize',
  KILL: 'terminal_kill',
  GET_CWD: 'terminal_get_cwd',
  GET_GIT_BRANCH: 'terminal_get_git_branch',
  GET_GIT_STATUS: 'terminal_get_git_status',
  GET_EXIT_CODE: 'terminal_get_exit_code',
  UPDATE_ORPHAN_DETECTION: 'terminal_update_orphan_detection',
  ADD_RENDERER_REF: 'terminal_add_renderer_ref',
  REMOVE_RENDERER_REF: 'terminal_remove_renderer_ref'
} as const

/**
 * Wrap invoke() calls in IpcResult<T> pattern with try/catch
 */
async function invokeIpc<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    const data = await invoke<T>(command, args)
    return { success: true, data }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'UNKNOWN_ERROR'
    }
  }
}

/**
 * Create a TerminalApi implementation using Tauri IPC
 *
 * This adapter maps all TerminalApi methods to Tauri invoke() calls and event listeners.
 * It maintains the same interface as the Electron preload script for easy migration.
 */
export function createTauriTerminalApi(): TerminalApi {
  return {
    /**
     * Spawn a new terminal PTY
     */
    async spawn(options?: TerminalSpawnOptions): Promise<IpcResult<TerminalInfo>> {
      return invokeIpc<TerminalInfo>(IPC_COMMANDS.SPAWN, options)
    },

    /**
     * Write data to terminal PTY
     */
    async write(terminalId: string, data: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(IPC_COMMANDS.WRITE, { terminalId, data })
    },

    /**
     * Resize terminal PTY
     */
    async resize(terminalId: string, cols: number, rows: number): Promise<IpcResult<void>> {
      return invokeIpc<void>(IPC_COMMANDS.RESIZE, { terminalId, cols, rows })
    },

    /**
     * Kill terminal PTY
     */
    async kill(terminalId: string): Promise<IpcResult<void>> {
      return invokeIpc<void>(IPC_COMMANDS.KILL, { terminalId })
    },

    /**
     * Subscribe to terminal data events
     * Returns cleanup function (UnlistenFn)
     */
    onData(callback: TerminalDataCallback): () => void {
      const unlisten = listen<[string, string]>(
        IPC_EVENTS.TERMINAL_DATA,
        ({ payload: [terminalId, data] }) => {
          callback(terminalId, data)
        }
      )
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    /**
     * Subscribe to terminal exit events
     * Returns cleanup function (UnlistenFn)
     */
    onExit(callback: TerminalExitCallback): () => void {
      const unlisten = listen<[string, number, number | undefined]>(
        IPC_EVENTS.TERMINAL_EXIT,
        ({ payload: [terminalId, exitCode, signal] }) => {
          callback(terminalId, exitCode, signal)
        }
      )
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    /**
     * Subscribe to CWD change events
     * Returns cleanup function (UnlistenFn)
     */
    onCwdChanged(callback: TerminalCwdChangedCallback): () => void {
      const unlisten = listen<[string, string]>(
        IPC_EVENTS.TERMINAL_CWD_CHANGED,
        ({ payload: [terminalId, cwd] }) => {
          callback(terminalId, cwd)
        }
      )
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    /**
     * Get current working directory for terminal
     */
    async getCwd(terminalId: string): Promise<IpcResult<string | null>> {
      return invokeIpc<string | null>(IPC_COMMANDS.GET_CWD, { terminalId })
    },

    /**
     * Subscribe to git branch change events
     * Returns cleanup function (UnlistenFn)
     */
    onGitBranchChanged(callback: TerminalGitBranchChangedCallback): () => void {
      const unlisten = listen<[string, string | null]>(
        IPC_EVENTS.TERMINAL_GIT_BRANCH_CHANGED,
        ({ payload: [terminalId, branch] }) => {
          callback(terminalId, branch)
        }
      )
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    /**
     * Get git branch for terminal
     */
    async getGitBranch(terminalId: string): Promise<IpcResult<string | null>> {
      return invokeIpc<string | null>(IPC_COMMANDS.GET_GIT_BRANCH, { terminalId })
    },

    /**
     * Subscribe to git status change events
     * Returns cleanup function (UnlistenFn)
     */
    onGitStatusChanged(callback: TerminalGitStatusChangedCallback): () => void {
      const unlisten = listen<[string, GitStatus | null]>(
        IPC_EVENTS.TERMINAL_GIT_STATUS_CHANGED,
        ({ payload: [terminalId, status] }) => {
          callback(terminalId, status)
        }
      )
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    /**
     * Get git status for terminal
     */
    async getGitStatus(terminalId: string): Promise<IpcResult<GitStatus | null>> {
      return invokeIpc<GitStatus | null>(IPC_COMMANDS.GET_GIT_STATUS, { terminalId })
    },

    /**
     * Subscribe to exit code change events
     * Returns cleanup function (UnlistenFn)
     */
    onExitCodeChanged(callback: TerminalExitCodeChangedCallback): () => void {
      const unlisten = listen<[string, number]>(
        IPC_EVENTS.TERMINAL_EXIT_CODE_CHANGED,
        ({ payload: [terminalId, exitCode] }) => {
          callback(terminalId, exitCode)
        }
      )
      return () => {
        void unlisten.then((fn) => fn())
      }
    },

    /**
     * Get exit code for terminal
     */
    async getExitCode(terminalId: string): Promise<IpcResult<number | null>> {
      return invokeIpc<number | null>(IPC_COMMANDS.GET_EXIT_CODE, { terminalId })
    },

    /**
     * Update orphan detection settings
     */
    async updateOrphanDetection(
      enabled: boolean,
      timeout: number | null
    ): Promise<IpcResult<void>> {
      return invokeIpc<void>(IPC_COMMANDS.UPDATE_ORPHAN_DETECTION, { enabled, timeout })
    }
  }
}

/**
 * Internal method to add renderer ref (not part of TerminalApi interface)
 * Called when a terminal component mounts to register with the Rust backend
 */
export async function addRendererRef(ptyId: string): Promise<IpcResult<void>> {
  return invokeIpc<void>(IPC_COMMANDS.ADD_RENDERER_REF, { ptyId })
}

/**
 * Internal method to remove renderer ref (not part of TerminalApi interface)
 * Called when a terminal component unmounts to unregister from the Rust backend
 */
export async function removeRendererRef(ptyId: string): Promise<IpcResult<void>> {
  return invokeIpc<void>(IPC_COMMANDS.REMOVE_RENDERER_REF, { ptyId })
}
