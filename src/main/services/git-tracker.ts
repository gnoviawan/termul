import { exec } from 'child_process'
import { promisify } from 'util'
import { getDefaultCwdTracker } from './cwd-tracker'

const execAsync = promisify(exec)

export type GitBranchChangedCallback = (terminalId: string, branch: string | null) => void
export type GitStatusChangedCallback = (terminalId: string, status: GitStatus | null) => void

const GIT_COMMAND_TIMEOUT_MS = 5000
const STATUS_POLL_INTERVAL_MS = 2000

export interface GitStatus {
  modified: number
  staged: number
  untracked: number
  hasChanges: boolean
}

interface GitState {
  terminalId: string
  lastKnownBranch: string | null
  lastKnownCwd: string
  lastKnownStatus: GitStatus | null
}

function parseGitStatus(output: string): GitStatus {
  const lines = output.split('\n').filter((l) => l.length > 0)
  let modified = 0
  let staged = 0
  let untracked = 0

  for (const line of lines) {
    if (line.length < 2) continue

    const indexStatus = line[0]
    const workTreeStatus = line[1]

    if (line.startsWith('??')) {
      untracked++
    } else {
      // Working tree modifications
      if (workTreeStatus === 'M' || workTreeStatus === 'D') {
        modified++
      }
      // Staged changes (anything in index that's not space or ?)
      if (indexStatus !== ' ' && indexStatus !== '?') {
        staged++
      }
    }
  }

  return {
    modified,
    staged,
    untracked,
    hasChanges: modified + staged + untracked > 0
  }
}

function statusEquals(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return (
    a.modified === b.modified &&
    a.staged === b.staged &&
    a.untracked === b.untracked
  )
}

class GitTracker {
  private terminalGitState: Map<string, GitState> = new Map()
  private branchCallbacks: Set<GitBranchChangedCallback> = new Set()
  private statusCallbacks: Set<GitStatusChangedCallback> = new Set()
  private cwdCleanup: (() => void) | null = null
  private statusPollInterval: NodeJS.Timeout | null = null

  constructor() {
    // Listen for CWD changes to update git info
    const cwdTracker = getDefaultCwdTracker()
    this.cwdCleanup = cwdTracker.onCwdChanged((terminalId: string, cwd: string) => {
      this.checkBranch(terminalId, cwd)
      this.checkStatus(terminalId, cwd)
    })
  }

  async checkBranch(terminalId: string, cwd: string): Promise<void> {
    const branch = await this.getGitBranch(cwd)
    const state = this.terminalGitState.get(terminalId)

    if (!state) {
      // First time seeing this terminal
      this.terminalGitState.set(terminalId, {
        terminalId,
        lastKnownBranch: branch,
        lastKnownCwd: cwd,
        lastKnownStatus: null
      })
      this.notifyBranchChanged(terminalId, branch)
      return
    }

    // Check if branch changed
    if (branch !== state.lastKnownBranch) {
      state.lastKnownBranch = branch
      state.lastKnownCwd = cwd
      this.notifyBranchChanged(terminalId, branch)
    }
  }

  async checkStatus(terminalId: string, cwd: string): Promise<void> {
    const status = await this.getGitStatus(cwd)
    const state = this.terminalGitState.get(terminalId)

    if (!state) {
      // Terminal should already be initialized by checkBranch
      return
    }

    // Check if status changed
    if (!statusEquals(status, state.lastKnownStatus)) {
      state.lastKnownStatus = status
      this.notifyStatusChanged(terminalId, status)
    }
  }

  async initializeTerminal(terminalId: string, cwd: string): Promise<void> {
    await this.checkBranch(terminalId, cwd)
    await this.checkStatus(terminalId, cwd)
    this.startStatusPolling()
  }

  removeTerminal(terminalId: string): void {
    this.terminalGitState.delete(terminalId)
    if (this.terminalGitState.size === 0) {
      this.stopStatusPolling()
    }
  }

  onGitBranchChanged(callback: GitBranchChangedCallback): () => void {
    this.branchCallbacks.add(callback)
    return () => this.branchCallbacks.delete(callback)
  }

  onGitStatusChanged(callback: GitStatusChangedCallback): () => void {
    this.statusCallbacks.add(callback)
    return () => this.statusCallbacks.delete(callback)
  }

  getBranch(terminalId: string): string | null {
    const state = this.terminalGitState.get(terminalId)
    return state?.lastKnownBranch ?? null
  }

  getStatus(terminalId: string): GitStatus | null {
    const state = this.terminalGitState.get(terminalId)
    return state?.lastKnownStatus ?? null
  }

  private startStatusPolling(): void {
    if (this.statusPollInterval) return

    this.statusPollInterval = setInterval(() => {
      this.pollAllStatus()
    }, STATUS_POLL_INTERVAL_MS)
  }

  private stopStatusPolling(): void {
    if (this.statusPollInterval) {
      clearInterval(this.statusPollInterval)
      this.statusPollInterval = null
    }
  }

  private async pollAllStatus(): Promise<void> {
    const promises = Array.from(this.terminalGitState.values()).map(async (state) => {
      try {
        await this.checkStatus(state.terminalId, state.lastKnownCwd)
      } catch {
        // Ignore errors during polling
      }
    })

    await Promise.allSettled(promises)
  }

  private notifyBranchChanged(terminalId: string, branch: string | null): void {
    this.branchCallbacks.forEach((callback) => {
      try {
        callback(terminalId, branch)
      } catch {
        // Ignore callback errors
      }
    })
  }

  private notifyStatusChanged(terminalId: string, status: GitStatus | null): void {
    this.statusCallbacks.forEach((callback) => {
      try {
        callback(terminalId, status)
      } catch {
        // Ignore callback errors
      }
    })
  }

  private async getGitBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        timeout: GIT_COMMAND_TIMEOUT_MS
      })
      const branch = stdout.trim()
      // 'HEAD' is returned when in detached HEAD state
      return branch === 'HEAD' ? null : branch
    } catch {
      // Not a git repository or git not installed
      return null
    }
  }

  private async getGitStatus(cwd: string): Promise<GitStatus | null> {
    try {
      const { stdout } = await execAsync('git status --porcelain', {
        cwd,
        timeout: GIT_COMMAND_TIMEOUT_MS
      })
      return parseGitStatus(stdout)
    } catch {
      // Not a git repository or git not installed
      return null
    }
  }

  shutdown(): void {
    if (this.cwdCleanup) {
      this.cwdCleanup()
      this.cwdCleanup = null
    }
    this.stopStatusPolling()
    this.terminalGitState.clear()
    this.branchCallbacks.clear()
    this.statusCallbacks.clear()
  }
}

let defaultTracker: GitTracker | null = null

export function getDefaultGitTracker(): GitTracker {
  if (!defaultTracker) {
    defaultTracker = new GitTracker()
  }
  return defaultTracker
}

export function resetGitTracker(): void {
  if (defaultTracker) {
    defaultTracker.shutdown()
    defaultTracker = null
  }
}

// Export parseGitStatus and statusEquals for testing
export { parseGitStatus, statusEquals }
