import { ipcMain, BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { PtyManager, getDefaultPtyManager } from '../services/pty-manager'
import {
  getDefaultCwdTracker,
  registerTerminalForCwdTracking,
  unregisterTerminalFromCwdTracking
} from '../services/cwd-tracker'
import { getDefaultGitTracker } from '../services/git-tracker'
import { getDefaultExitCodeTracker } from '../services/exit-code-tracker'
import type {
  IpcResult,
  TerminalSpawnOptions,
  TerminalInfo,
  IpcErrorCode
} from '../../shared/types/ipc.types'
import { IpcErrorCodes } from '../../shared/types/ipc.types'

// Store cleanup functions for event listeners
let cleanupDataListener: (() => void) | null = null
let cleanupExitListener: (() => void) | null = null
let cleanupCwdListener: (() => void) | null = null
let cleanupGitBranchListener: (() => void) | null = null
let cleanupGitStatusListener: (() => void) | null = null
let cleanupExitCodeListener: (() => void) | null = null

function createSuccessResult<T>(data: T): IpcResult<T> {
  return { success: true, data }
}

function createErrorResult<T>(error: string, code: IpcErrorCode): IpcResult<T> {
  return { success: false, error, code }
}

function isValidDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10000
}

export function registerTerminalIpc(ptyManager?: PtyManager): void {
  const manager = ptyManager || getDefaultPtyManager()

  // terminal:spawn - Create a new terminal instance
  ipcMain.handle(
    'terminal:spawn',
    async (
      _event: IpcMainInvokeEvent,
      options?: TerminalSpawnOptions
    ): Promise<IpcResult<TerminalInfo>> => {
      try {
        const terminalId = manager.spawn(options || {})

        if (terminalId === null) {
          return createErrorResult('Terminal limit reached (max 30 terminals)', IpcErrorCodes.SPAWN_FAILED)
        }

        const instance = manager.get(terminalId)

        if (!instance) {
          return createErrorResult('Failed to create terminal instance', IpcErrorCodes.SPAWN_FAILED)
        }

        const info: TerminalInfo = {
          id: terminalId,
          shell: instance.shell,
          cwd: instance.cwd
        }

        // Register terminal for CWD tracking
        registerTerminalForCwdTracking(terminalId)

        // Initialize git branch tracking for this terminal
        const gitTracker = getDefaultGitTracker()
        gitTracker.initializeTerminal(terminalId, instance.cwd)

        // Initialize exit code tracking for this terminal
        const exitCodeTracker = getDefaultExitCodeTracker()
        exitCodeTracker.initializeTerminal(terminalId)

        return createSuccessResult(info)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error during spawn'
        return createErrorResult(message, IpcErrorCodes.SPAWN_FAILED)
      }
    }
  )

  // terminal:write - Write data to a terminal
  ipcMain.handle(
    'terminal:write',
    async (
      _event: IpcMainInvokeEvent,
      terminalId: string,
      data: string
    ): Promise<IpcResult<void>> => {
      try {
        const success = manager.write(terminalId, data)

        if (!success) {
          return createErrorResult(
            `Terminal ${terminalId} not found`,
            IpcErrorCodes.TERMINAL_NOT_FOUND
          )
        }

        return createSuccessResult(undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error during write'
        return createErrorResult(message, IpcErrorCodes.WRITE_FAILED)
      }
    }
  )

  // terminal:resize - Resize a terminal
  ipcMain.handle(
    'terminal:resize',
    async (
      _event: IpcMainInvokeEvent,
      terminalId: string,
      cols: number,
      rows: number
    ): Promise<IpcResult<void>> => {
      try {
        // Validate dimensions at IPC boundary
        if (!isValidDimension(cols) || !isValidDimension(rows)) {
          return createErrorResult(
            'Invalid dimensions: cols and rows must be positive integers',
            IpcErrorCodes.RESIZE_FAILED
          )
        }

        const success = manager.resize(terminalId, cols, rows)

        if (!success) {
          return createErrorResult(
            `Terminal ${terminalId} not found`,
            IpcErrorCodes.TERMINAL_NOT_FOUND
          )
        }

        return createSuccessResult(undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error during resize'
        return createErrorResult(message, IpcErrorCodes.RESIZE_FAILED)
      }
    }
  )

  // terminal:kill - Kill a terminal
  ipcMain.handle(
    'terminal:kill',
    async (_event: IpcMainInvokeEvent, terminalId: string): Promise<IpcResult<void>> => {
      try {
        // Unregister from CWD tracking before killing
        unregisterTerminalFromCwdTracking(terminalId)

        // Remove from git tracking
        const gitTracker = getDefaultGitTracker()
        gitTracker.removeTerminal(terminalId)

        // Remove from exit code tracking
        const exitCodeTracker = getDefaultExitCodeTracker()
        exitCodeTracker.removeTerminal(terminalId)

        const success = manager.kill(terminalId)

        if (!success) {
          return createErrorResult(
            `Terminal ${terminalId} not found`,
            IpcErrorCodes.TERMINAL_NOT_FOUND
          )
        }

        return createSuccessResult(undefined)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error during kill'
        return createErrorResult(message, IpcErrorCodes.KILL_FAILED)
      }
    }
  )

  // Forward PTY data events to renderer
  cleanupDataListener = manager.onData((terminalId: string, data: string) => {
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      window.webContents.send('terminal:data', terminalId, data)
    }
  })

  // Forward PTY exit events to renderer
  cleanupExitListener = manager.onExit((terminalId: string, exitCode: number, signal?: number) => {
    // Unregister from CWD tracking on exit
    unregisterTerminalFromCwdTracking(terminalId)

    // Remove from git tracking on exit
    const gitTracker = getDefaultGitTracker()
    gitTracker.removeTerminal(terminalId)

    // Remove from exit code tracking on exit
    const exitCodeTracker = getDefaultExitCodeTracker()
    exitCodeTracker.removeTerminal(terminalId)

    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      window.webContents.send('terminal:exit', terminalId, exitCode, signal)
    }
  })

  // Forward CWD changed events to renderer
  const cwdTracker = getDefaultCwdTracker()
  cleanupCwdListener = cwdTracker.onCwdChanged((terminalId: string, cwd: string) => {
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      window.webContents.send('terminal:cwd-changed', terminalId, cwd)
    }
  })

  // terminal:getCwd - Get current working directory for a terminal
  ipcMain.handle(
    'terminal:getCwd',
    async (_event: IpcMainInvokeEvent, terminalId: string): Promise<IpcResult<string | null>> => {
      try {
        const cwd = await cwdTracker.getCwd(terminalId)
        return createSuccessResult(cwd)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting CWD'
        return createErrorResult(message, IpcErrorCodes.UNKNOWN_ERROR)
      }
    }
  )

  // Forward git branch changed events to renderer
  const gitTracker = getDefaultGitTracker()
  cleanupGitBranchListener = gitTracker.onGitBranchChanged(
    (terminalId: string, branch: string | null) => {
      const windows = BrowserWindow.getAllWindows()
      for (const window of windows) {
        window.webContents.send('terminal:git-branch-changed', terminalId, branch)
      }
    }
  )

  // terminal:getGitBranch - Get git branch for a terminal
  ipcMain.handle(
    'terminal:getGitBranch',
    async (_event: IpcMainInvokeEvent, terminalId: string): Promise<IpcResult<string | null>> => {
      try {
        const branch = gitTracker.getBranch(terminalId)
        return createSuccessResult(branch)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting git branch'
        return createErrorResult(message, IpcErrorCodes.UNKNOWN_ERROR)
      }
    }
  )

  // Forward git status changed events to renderer
  cleanupGitStatusListener = gitTracker.onGitStatusChanged(
    (terminalId: string, status) => {
      const windows = BrowserWindow.getAllWindows()
      for (const window of windows) {
        window.webContents.send('terminal:git-status-changed', terminalId, status)
      }
    }
  )

  // terminal:getGitStatus - Get git status for a terminal
  ipcMain.handle(
    'terminal:getGitStatus',
    async (_event: IpcMainInvokeEvent, terminalId: string): Promise<IpcResult<import('../services/git-tracker').GitStatus | null>> => {
      try {
        const status = gitTracker.getStatus(terminalId)
        return createSuccessResult(status)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting git status'
        return createErrorResult(message, IpcErrorCodes.UNKNOWN_ERROR)
      }
    }
  )

  // Forward exit code changed events to renderer
  const exitCodeTracker = getDefaultExitCodeTracker()
  cleanupExitCodeListener = exitCodeTracker.onExitCodeChanged(
    (terminalId: string, exitCode: number) => {
      const windows = BrowserWindow.getAllWindows()
      for (const window of windows) {
        window.webContents.send('terminal:exit-code-changed', terminalId, exitCode)
      }
    }
  )

  // terminal:getExitCode - Get last exit code for a terminal
  ipcMain.handle(
    'terminal:getExitCode',
    async (_event: IpcMainInvokeEvent, terminalId: string): Promise<IpcResult<number | null>> => {
      try {
        const exitCode = exitCodeTracker.getExitCode(terminalId)
        return createSuccessResult(exitCode)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error getting exit code'
        return createErrorResult(message, IpcErrorCodes.UNKNOWN_ERROR)
      }
    }
  )
}

export function unregisterTerminalIpc(): void {
  ipcMain.removeHandler('terminal:spawn')
  ipcMain.removeHandler('terminal:write')
  ipcMain.removeHandler('terminal:resize')
  ipcMain.removeHandler('terminal:kill')
  ipcMain.removeHandler('terminal:getCwd')
  ipcMain.removeHandler('terminal:getGitBranch')
  ipcMain.removeHandler('terminal:getGitStatus')
  ipcMain.removeHandler('terminal:getExitCode')

  // Clean up event listeners
  if (cleanupDataListener) {
    cleanupDataListener()
    cleanupDataListener = null
  }
  if (cleanupExitListener) {
    cleanupExitListener()
    cleanupExitListener = null
  }
  if (cleanupCwdListener) {
    cleanupCwdListener()
    cleanupCwdListener = null
  }
  if (cleanupGitBranchListener) {
    cleanupGitBranchListener()
    cleanupGitBranchListener = null
  }
  if (cleanupGitStatusListener) {
    cleanupGitStatusListener()
    cleanupGitStatusListener = null
  }
  if (cleanupExitCodeListener) {
    cleanupExitCodeListener()
    cleanupExitCodeListener = null
  }
}
