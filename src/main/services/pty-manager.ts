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
}

export type DataCallback = (terminalId: string, data: string) => void
export type ExitCallback = (terminalId: string, exitCode: number, signal?: number) => void

export class PtyManager {
  private terminals: Map<string, TerminalInstance> = new Map()
  private dataCallbacks: Set<DataCallback> = new Set()
  private exitCallbacks: Set<ExitCallback> = new Set()
  private idCounter = 0

  private generateId(): string {
    this.idCounter += 1
    return `terminal-${Date.now()}-${this.idCounter}`
  }

  spawn(options: SpawnOptions = {}): string {
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
      cwd
    }

    this.terminals.set(id, instance)

    ptyProcess.onData((data: string) => {
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
    instance.pty.write(data)
    return true
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const instance = this.terminals.get(terminalId)
    if (!instance) {
      return false
    }
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
    defaultManager.killAll()
    defaultManager = null
  }
}
