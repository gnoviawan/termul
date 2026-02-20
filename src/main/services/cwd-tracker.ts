import { promises as fs } from 'fs'
import * as path from 'path'
import { getDefaultPtyManager } from './pty-manager'
import { getVisibilityState } from '../ipc/visibility.ipc'

export type CwdChangedCallback = (terminalId: string, cwd: string) => void

interface CwdState {
  terminalId: string
  pid: number
  lastKnownCwd: string
}

class CwdTracker {
  private trackedTerminals: Map<string, CwdState> = new Map()
  private callbacks: Set<CwdChangedCallback> = new Set()
  private pollInterval: NodeJS.Timeout | null = null
  private readonly POLL_INTERVAL_MS = 500
  // On Windows, CWD detection returns null, so skip polling to save CPU
  private readonly isWindows = process.platform === 'win32'

  startTracking(terminalId: string, pid: number, initialCwd: string): void {
    this.trackedTerminals.set(terminalId, {
      terminalId,
      pid,
      lastKnownCwd: initialCwd
    })

    // Skip polling on Windows since CWD detection always returns null
    if (this.isWindows) {
      return
    }

    if (!this.pollInterval && this.trackedTerminals.size > 0) {
      this.startPolling()
    }
  }

  stopTracking(terminalId: string): void {
    this.trackedTerminals.delete(terminalId)

    if (this.trackedTerminals.size === 0 && this.pollInterval) {
      this.stopPolling()
    }
  }

  onCwdChanged(callback: CwdChangedCallback): () => void {
    this.callbacks.add(callback)
    return () => this.callbacks.delete(callback)
  }

  async getCwd(terminalId: string): Promise<string | null> {
    const state = this.trackedTerminals.get(terminalId)
    if (!state) {
      return null
    }

    const cwd = await this.detectCwd(state.pid)
    return cwd || state.lastKnownCwd
  }

  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.pollAllTerminals()
    }, this.POLL_INTERVAL_MS)
  }

  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  private async pollAllTerminals(): Promise<void> {
    // Skip polling when app is not visible to save CPU
    if (!getVisibilityState()) {
      return
    }

    const promises = Array.from(this.trackedTerminals.values()).map(async (state) => {
      try {
        const currentCwd = await this.detectCwd(state.pid)
        if (currentCwd && currentCwd !== state.lastKnownCwd) {
          state.lastKnownCwd = currentCwd
          this.notifyCwdChanged(state.terminalId, currentCwd)
        }
      } catch {
        // Process may have exited, ignore errors
      }
    })

    await Promise.allSettled(promises)
  }

  private notifyCwdChanged(terminalId: string, cwd: string): void {
    this.callbacks.forEach((callback) => {
      try {
        callback(terminalId, cwd)
      } catch {
        // Ignore callback errors
      }
    })
  }

  private async detectCwd(pid: number): Promise<string | null> {
    if (this.isWindows) {
      return this.detectCwdWindows(pid)
    } else {
      return this.detectCwdUnix(pid)
    }
  }

  private async detectCwdUnix(pid: number): Promise<string | null> {
    try {
      const cwdPath = `/proc/${pid}/cwd`
      const realPath = await fs.readlink(cwdPath)
      return realPath
    } catch {
      return null
    }
  }

  private async detectCwdWindows(_pid: number): Promise<string | null> {
    // Windows CWD detection is complex and requires Windows API calls
    // For MVP, we return null and rely on initial CWD from spawn
    // Future enhancement: use wmic or PowerShell to get process CWD
    return null
  }

  shutdown(): void {
    this.stopPolling()
    this.trackedTerminals.clear()
    this.callbacks.clear()
  }
}

let defaultTracker: CwdTracker | null = null

export function getDefaultCwdTracker(): CwdTracker {
  if (!defaultTracker) {
    defaultTracker = new CwdTracker()
  }
  return defaultTracker
}

export function resetCwdTracker(): void {
  if (defaultTracker) {
    defaultTracker.shutdown()
    defaultTracker = null
  }
}

// Helper to register a terminal for CWD tracking after spawn
export function registerTerminalForCwdTracking(terminalId: string): void {
  const ptyManager = getDefaultPtyManager()
  const instance = ptyManager.get(terminalId)

  if (instance) {
    const tracker = getDefaultCwdTracker()
    const pid = instance.pty.pid
    const initialCwd = instance.cwd
    tracker.startTracking(terminalId, pid, initialCwd)
  }
}

// Helper to unregister a terminal from CWD tracking
export function unregisterTerminalFromCwdTracking(terminalId: string): void {
  const tracker = getDefaultCwdTracker()
  tracker.stopTracking(terminalId)
}
