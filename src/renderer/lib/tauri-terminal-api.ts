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
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'

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
 * Invoke Tauri IPC commands that already return IpcResult<T> from Rust.
 * The Rust commands in commands.rs wrap their results in IpcResult::success/error,
 * so we must NOT wrap them again here.
 */
async function invokeIpc<T>(command: string, args?: InvokeArgs): Promise<IpcResult<T>> {
  try {
    return await invoke<IpcResult<T>>(command, args)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'INVOKE_ERROR'
    }
  }
}

/**
 * Spawn tracking variables to detect and prevent spawn loops
 */
const IS_DEV = import.meta.env.DEV

function devLog(...args: unknown[]): void {
  if (IS_DEV) {
    console.log(...args)
  }
}

let SPAWN_CALL_COUNTER = 0
const SPAWN_CALLS: Array<{
  id: string
  timestamp: number
  shell?: string
  cwd?: string
  stack: string
}> = []

/**
 * Capture stack trace for debugging spawn calls
 */
function captureStackTrace(): string {
  const stack = new Error().stack?.split('\n').slice(3).join('\n') || ''
  return stack
}

/**
 * Create a TerminalApi implementation using Tauri IPC
 *
 * This adapter maps all TerminalApi methods to Tauri invoke() calls and event listeners.
 * It maintains the same interface as the Electron preload script for easy migration.
 */
export function createTauriTerminalApi(): TerminalApi {
  const registerListener = <T>(
    eventName: string,
    callback: (payload: T) => void,
    debugLabel: string
  ): (() => void) => {
    if (!isTauriContext()) {
      if (import.meta.env.DEV) {
        devLog(`[TauriTerminalAPI] Skipping ${debugLabel} listener outside Tauri runtime`)
      }
      return () => {}
    }

    let unlisten: Promise<UnlistenFn> | undefined

    try {
      unlisten = listen<T>(eventName, ({ payload }) => {
        callback(payload)
      })
    } catch (error) {
      console.error(`[TauriTerminalAPI] Failed to register ${debugLabel} listener:`, error)
      return () => {}
    }

    return () => {
      cleanupTauriListener(unlisten)
    }
  }

  return {
    /**
     * Spawn a new terminal PTY
     */
    async spawn(options?: TerminalSpawnOptions): Promise<IpcResult<TerminalInfo>> {
      if (IS_DEV) {
        const spawnId = `spawn-${SPAWN_CALL_COUNTER++}-${Date.now().toString(36)}`
        const stack = captureStackTrace()

        const callInfo = {
          id: spawnId,
          timestamp: Date.now(),
          shell: options?.shell,
          cwd: options?.cwd,
          stack
        }

        SPAWN_CALLS.push(callInfo)

        devLog('═══════════════════════════════════════════════════════════════')
        devLog('[SPAWN CALL]', {
          id: spawnId,
          totalCalls: SPAWN_CALLS.length,
          options,
          stackTrace: stack,
          recentCalls: SPAWN_CALLS.slice(-5).map(c => ({
            id: c.id,
            time: new Date(c.timestamp).toISOString().split('T')[1].slice(0, 12),
            shell: c.shell,
            cwd: c.cwd
          }))
        })
        devLog('═══════════════════════════════════════════════════════════════')

        if (SPAWN_CALLS.length >= 5) {
          const last5 = SPAWN_CALLS.slice(-5)
          const timeSpan = last5[4].timestamp - last5[0].timestamp
          if (timeSpan < 2000) {
            console.warn('⚠️ Rapid spawns detected', {
              callCount: last5.length,
              timeSpan: `${timeSpan}ms`,
              calls: last5.map(c => ({
                id: c.id,
                time: new Date(c.timestamp).toISOString().split('T')[1].slice(0, 12),
                stack: c.stack
              }))
            })
          }
        }

        if (SPAWN_CALLS.length >= 10) {
          console.debug(`Spawn tracking: ${SPAWN_CALLS.length} terminals spawned`)
        }
      }

      return invokeIpc<TerminalInfo>(IPC_COMMANDS.SPAWN, { options })
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
      if (import.meta.env.DEV) {
        devLog('[TauriTerminalAPI] Registering terminal-data listener')
      }

      return registerListener<{ id: string; data: string }>(
        IPC_EVENTS.TERMINAL_DATA,
        (payload) => {
          callback(payload.id, payload.data)
        },
        'terminal-data'
      )
    },

    /**
     * Subscribe to terminal exit events
     * Returns cleanup function (UnlistenFn)
     */
    onExit(callback: TerminalExitCallback): () => void {
      if (import.meta.env.DEV) {
        devLog('[TauriTerminalAPI] Registering terminal-exit listener')
      }

      return registerListener<{ id: string; exitCode: number | null; signal: number | null }>(
        IPC_EVENTS.TERMINAL_EXIT,
        (payload) => {
          if (import.meta.env.DEV) {
            devLog(
              `[TauriTerminalAPI] Terminal ${payload.id} exited with code ${payload.exitCode}`
            )
          }
          callback(payload.id, payload.exitCode ?? -1, payload.signal ?? undefined)
        },
        'terminal-exit'
      )
    },

    /**
     * Subscribe to CWD change events
     * Returns cleanup function (UnlistenFn)
     */
    onCwdChanged(callback: TerminalCwdChangedCallback): () => void {
      return registerListener<{ terminalId: string; cwd: string }>(
        IPC_EVENTS.TERMINAL_CWD_CHANGED,
        (payload) => {
          callback(payload.terminalId, payload.cwd)
        },
        'terminal-cwd-changed'
      )
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
      return registerListener<{ terminalId: string; branch: string | null }>(
        IPC_EVENTS.TERMINAL_GIT_BRANCH_CHANGED,
        (payload) => {
          callback(payload.terminalId, payload.branch)
        },
        'terminal-git-branch-changed'
      )
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
      return registerListener<{ terminalId: string; status: GitStatus | null }>(
        IPC_EVENTS.TERMINAL_GIT_STATUS_CHANGED,
        (payload) => {
          callback(payload.terminalId, payload.status)
        },
        'terminal-git-status-changed'
      )
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
      return registerListener<{ terminalId: string; exitCode: number }>(
        IPC_EVENTS.TERMINAL_EXIT_CODE_CHANGED,
        (payload) => {
          callback(payload.terminalId, payload.exitCode)
        },
        'terminal-exit-code-changed'
      )
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
      // Rust expects argument `settings: OrphanDetectionSettings`
      const settings = {
        enabled,
        timeoutMinutes: timeout ? Math.floor(timeout / 60000) : null
      }
      return invokeIpc<void>(IPC_COMMANDS.UPDATE_ORPHAN_DETECTION, { settings })
    }
  }
}

/**
 * Internal method to add renderer ref (not part of TerminalApi interface)
 * Called when a terminal component mounts to register with the Rust backend
 */
export async function addRendererRef(ptyId: string, rendererId: string): Promise<IpcResult<void>> {
  // Rust expects argument `request: RendererRefRequest { terminal_id, renderer_id }`
  const request = { terminalId: ptyId, rendererId }
  return invokeIpc<void>(IPC_COMMANDS.ADD_RENDERER_REF, { request })
}

/**
 * Internal method to remove renderer ref (not part of TerminalApi interface)
 * Called when a terminal component unmounts to unregister from the Rust backend
 */
export async function removeRendererRef(ptyId: string, rendererId: string): Promise<IpcResult<void>> {
  // Rust expects argument `request: RendererRefRequest { terminal_id, renderer_id }`
  const request = { terminalId: ptyId, rendererId }
  return invokeIpc<void>(IPC_COMMANDS.REMOVE_RENDERER_REF, { request })
}

/**
 * Expose spawn tracking for debugging
 * Access via: window.__TERMUL_SPAWN_TRACKER__
 */
if (typeof window !== 'undefined' && IS_DEV) {
  const globalDebug = window as unknown as Record<string, unknown>
  globalDebug.__TERMUL_SPAWN_TRACKER__ = {
    getCalls: () => [...SPAWN_CALLS],
    getCallCount: () => SPAWN_CALLS.length,
    clearCalls: () => { SPAWN_CALLS.length = 0 },
    getLastNCalls: (n: number) => SPAWN_CALLS.slice(-n),
    printSummary: () => {
      console.table(SPAWN_CALLS.map(c => ({
        id: c.id,
        time: new Date(c.timestamp).toISOString().split('T')[1].slice(0, 12),
        shell: c.shell || 'N/A',
        cwd: c.cwd || 'N/A',
        caller: c.stack.split(' <- ')[0] || 'unknown'
      })))
      devLog(`Total spawn calls: ${SPAWN_CALLS.length}`)

      // Detect potential loops
      if (SPAWN_CALLS.length >= 5) {
        const last5 = SPAWN_CALLS.slice(-5)
        const timeSpan = last5[4].timestamp - last5[0].timestamp
        if (timeSpan < 2000) {
          console.error('🚨 POTENTIAL SPAWN LOOP DETECTED 🚨')
          console.error('5 spawns within', timeSpan, 'ms')
          console.table(last5)
        }
      }
    }
  }
}
