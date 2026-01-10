import { getDefaultPtyManager } from './pty-manager'

export type ExitCodeChangedCallback = (terminalId: string, exitCode: number) => void

// OSC 133;D;{exit_code} escape sequence pattern (shell integration protocol)
// eslint-disable-next-line no-control-regex
const OSC_EXIT_CODE_PATTERN = /\x1b\]133;D;?(\d*)\x07/

// Simple marker pattern as fallback (injected via PROMPT_COMMAND)
const EXIT_MARKER_PATTERN = /__TERMUL_EXIT__(\d+)__/

interface ExitCodeState {
  terminalId: string
  lastExitCode: number | null
}

export function parseExitCode(data: string): number | null {
  // Try OSC 133;D pattern first
  const oscMatch = data.match(OSC_EXIT_CODE_PATTERN)
  if (oscMatch) {
    // If no exit code in sequence, assume 0 (some shells do this)
    return oscMatch[1] ? parseInt(oscMatch[1], 10) : 0
  }

  // Try custom marker pattern as fallback
  const markerMatch = data.match(EXIT_MARKER_PATTERN)
  if (markerMatch) {
    return parseInt(markerMatch[1], 10)
  }

  return null
}

class ExitCodeTracker {
  private terminalExitCodes: Map<string, ExitCodeState> = new Map()
  private exitCodeCallbacks: Set<ExitCodeChangedCallback> = new Set()
  private dataCleanup: (() => void) | null = null

  constructor() {
    // Listen for PTY data events to parse exit codes
    const ptyManager = getDefaultPtyManager()
    this.dataCleanup = ptyManager.onData((terminalId: string, data: string) => {
      this.parseDataForExitCode(terminalId, data)
    })
  }

  private parseDataForExitCode(terminalId: string, data: string): void {
    // Quick check before regex for performance
    if (!data.includes('\x1b]133;D') && !data.includes('__TERMUL_EXIT__')) {
      return
    }

    const exitCode = parseExitCode(data)
    if (exitCode === null) {
      return
    }

    const state = this.terminalExitCodes.get(terminalId)
    if (!state) {
      // First exit code for this terminal
      this.terminalExitCodes.set(terminalId, {
        terminalId,
        lastExitCode: exitCode
      })
      this.notifyExitCodeChanged(terminalId, exitCode)
      return
    }

    // Only notify if exit code changed
    if (state.lastExitCode !== exitCode) {
      state.lastExitCode = exitCode
      this.notifyExitCodeChanged(terminalId, exitCode)
    }
  }

  initializeTerminal(terminalId: string): void {
    if (!this.terminalExitCodes.has(terminalId)) {
      this.terminalExitCodes.set(terminalId, {
        terminalId,
        lastExitCode: null
      })
    }
  }

  removeTerminal(terminalId: string): void {
    this.terminalExitCodes.delete(terminalId)
  }

  onExitCodeChanged(callback: ExitCodeChangedCallback): () => void {
    this.exitCodeCallbacks.add(callback)
    return () => this.exitCodeCallbacks.delete(callback)
  }

  getExitCode(terminalId: string): number | null {
    const state = this.terminalExitCodes.get(terminalId)
    return state?.lastExitCode ?? null
  }

  private notifyExitCodeChanged(terminalId: string, exitCode: number): void {
    this.exitCodeCallbacks.forEach((callback) => {
      try {
        callback(terminalId, exitCode)
      } catch {
        // Ignore callback errors
      }
    })
  }

  shutdown(): void {
    if (this.dataCleanup) {
      this.dataCleanup()
      this.dataCleanup = null
    }
    this.terminalExitCodes.clear()
    this.exitCodeCallbacks.clear()
  }
}

let defaultTracker: ExitCodeTracker | null = null

export function getDefaultExitCodeTracker(): ExitCodeTracker {
  if (!defaultTracker) {
    defaultTracker = new ExitCodeTracker()
  }
  return defaultTracker
}

export function resetExitCodeTracker(): void {
  if (defaultTracker) {
    defaultTracker.shutdown()
    defaultTracker = null
  }
}
