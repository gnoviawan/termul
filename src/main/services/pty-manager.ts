import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { getDefaultShell, getHomeDirectory, getCurrentPlatform, getShellByName } from './shell-detect'

export interface SpawnOptions {
  shell?: string
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export interface TerminalInstance {
  id: string
  pty: IPty
  shell: string
  cwd: string
  lastActivity: number
  rendererRefs: Set<string>
}

export type DataCallback = (terminalId: string, data: string) => void
export type ExitCallback = (terminalId: string, exitCode: number, signal?: number) => void

const GLOBAL_TERMINAL_LIMIT = 30
const ORPHAN_DETECTION_INTERVAL = 30000 // 30 seconds
const ORPHAN_TIMEOUT = 60000 // 1 minute without activity = potential orphan

// Options for PtyManager constructor
export interface PtyManagerOptions {
  /** Disable orphan detection (useful for tests) */
  disableOrphanDetection?: boolean
}

export class PtyManager {
  private terminals: Map<string, TerminalInstance> = new Map()
  private dataCallbacks: Set<DataCallback> = new Set()
  private exitCallbacks: Set<ExitCallback> = new Set()
  private idCounter = 0
  private orphanDetectionTimer: NodeJS.Timeout | null = null
  private readonly options: PtyManagerOptions

  constructor(options: PtyManagerOptions = {}) {
    this.options = options
    if (!this.options.disableOrphanDetection) {
      this.startOrphanDetection()
    }
  }

  private generateId(): string {
    this.idCounter += 1
    return `terminal-${Date.now()}-${this.idCounter}`
  }

  spawn(options: SpawnOptions = {}): string | null {
    // Enforce global terminal limit
    if (this.terminals.size >= GLOBAL_TERMINAL_LIMIT) {
      return null
    }

    const id = this.generateId()
    const currentPlatform = getCurrentPlatform()

    const defaultShell = getDefaultShell()
    // Resolve shell name to path (e.g., 'powershell' -> 'powershell.exe')
    let shell: string
    if (options.shell) {
      const shellInfo = getShellByName(options.shell)
      shell = shellInfo?.path || options.shell
    } else {
      shell = defaultShell?.path || (currentPlatform === 'win32' ? 'cmd.exe' : '/bin/sh')
    }
    const cwd = options.cwd || getHomeDirectory()
    const cols = options.cols || 80
    const rows = options.rows || 24

    const env = this.mergeEnvironment(options.env)

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })

    const instance: TerminalInstance = {
      id,
      pty: ptyProcess,
      shell,
      cwd,
      lastActivity: Date.now(),
      rendererRefs: new Set()
    }

    this.terminals.set(id, instance)

    ptyProcess.onData((data: string) => {
      // Update activity timestamp
      instance.lastActivity = Date.now()
      this.dataCallbacks.forEach((callback) => callback(id, data))
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.exitCallbacks.forEach((callback) => callback(id, exitCode, signal))
      this.terminals.delete(id)
    })

    return id
  }

  write(terminalId: string, data: string): boolean {
    const instance = this.terminals.get(terminalId)
    if (!instance) {
      return false
    }
    instance.lastActivity = Date.now()
    instance.pty.write(data)
    return true
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const instance = this.terminals.get(terminalId)
    if (!instance) {
      return false
    }
    instance.lastActivity = Date.now()
    instance.pty.resize(cols, rows)
    return true
  }

  kill(terminalId: string): boolean {
    const instance = this.terminals.get(terminalId)
    if (!instance) {
      return false
    }
    instance.pty.kill()
    this.terminals.delete(terminalId)
    return true
  }

  get(terminalId: string): TerminalInstance | undefined {
    return this.terminals.get(terminalId)
  }

  getAll(): TerminalInstance[] {
    return Array.from(this.terminals.values())
  }

  getAllIds(): string[] {
    return Array.from(this.terminals.keys())
  }

  // Register a renderer reference for a terminal (used to track orphans)
  addRendererRef(terminalId: string, rendererId: string): void {
    const instance = this.terminals.get(terminalId)
    if (instance) {
      instance.rendererRefs.add(rendererId)
    }
  }

  // Remove a renderer reference for a terminal
  removeRendererRef(terminalId: string, rendererId: string): void {
    const instance = this.terminals.get(terminalId)
    if (instance) {
      instance.rendererRefs.delete(rendererId)
    }
  }

  // Get current terminal count
  getTerminalCount(): number {
    return this.terminals.size
  }

  // Check if terminal limit is reached
  isTerminalLimitReached(): boolean {
    return this.terminals.size >= GLOBAL_TERMINAL_LIMIT
  }

  onData(callback: DataCallback): () => void {
    this.dataCallbacks.add(callback)
    return () => this.dataCallbacks.delete(callback)
  }

  onExit(callback: ExitCallback): () => void {
    this.exitCallbacks.add(callback)
    return () => this.exitCallbacks.delete(callback)
  }

  killAll(): void {
    const ids = Array.from(this.terminals.keys())
    for (const id of ids) {
      this.kill(id)
    }
  }

  // Start orphan detection - periodically checks for terminals without renderer references
  private startOrphanDetection(): void {
    this.orphanDetectionTimer = setInterval(() => {
      this.detectOrphans()
    }, ORPHAN_DETECTION_INTERVAL)
  }

  // Detect and clean up orphaned terminals
  private detectOrphans(): void {
    const now = Date.now()
    const orphans: string[] = []

    Array.from(this.terminals.entries()).forEach(([id, instance]) => {
      // A terminal is considered orphaned if it's been inactive for longer than the timeout
      // (Inactivity-based detection - terminals that haven't received data/writes/resize recently)
      if ((now - instance.lastActivity) > ORPHAN_TIMEOUT) {
        orphans.push(id)
      }
    })

    // Clean up orphans
    for (const id of orphans) {
      console.log(`Cleaning up orphaned terminal: ${id}`)
      this.kill(id)
    }
  }

  // Clean up timer on destruction
  destroy(): void {
    if (this.orphanDetectionTimer) {
      clearInterval(this.orphanDetectionTimer)
      this.orphanDetectionTimer = null
    }
    this.killAll()
  }

  private mergeEnvironment(customEnv?: Record<string, string>): Record<string, string> {
    const baseEnv = { ...process.env } as Record<string, string>

    if (!customEnv) {
      return baseEnv
    }

    const currentPlatform = getCurrentPlatform()

    if (currentPlatform === 'win32') {
      const lowerCaseBaseKeys = new Map<string, string>()
      for (const key of Object.keys(baseEnv)) {
        lowerCaseBaseKeys.set(key.toLowerCase(), key)
      }

      for (const [key, value] of Object.entries(customEnv)) {
        const existingKey = lowerCaseBaseKeys.get(key.toLowerCase())
        if (existingKey) {
          baseEnv[existingKey] = value
        } else {
          baseEnv[key] = value
        }
      }
    } else {
      Object.assign(baseEnv, customEnv)
    }

    return baseEnv
  }
}

let defaultManager: PtyManager | null = null

export function getDefaultPtyManager(): PtyManager {
  if (!defaultManager) {
    defaultManager = new PtyManager()
  }
  return defaultManager
}

export function resetDefaultPtyManager(): void {
  if (defaultManager) {
    defaultManager.destroy()
    defaultManager = null
  }
}
