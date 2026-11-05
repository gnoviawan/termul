import { logFrontendError } from '@/lib/log-api'

export const MAX_HELD_EXIT_CODES = 64

type Lookup = (ptyId: string) => { id: string } | undefined
type Apply = (id: string, exitCode: number) => void

function log(level: 'info' | 'warn', message: string): void {
  void logFrontendError({ level, source: 'exitCodeBuffer', message })
}

/** Latest exit code per unbound PTY, flushed once on bind. */
export class ExitCodeBuffer {
  private readonly held = new Map<string, number>()
  private unsubscribe: (() => void) | undefined
  private lookup: Lookup | undefined
  private apply: Apply | undefined
  private flushing = false

  connect(lookup: Lookup, apply: Apply, subscribe: (listener: () => void) => () => void): void {
    this.unsubscribe?.()
    this.lookup = lookup
    this.apply = apply
    this.unsubscribe = subscribe(() => this.flush())
    this.flush()
  }

  handle(ptyId: string, exitCode: number): void {
    const terminal = this.lookup?.(ptyId)
    if (terminal) {
      this.held.delete(ptyId)
      this.apply?.(terminal.id, exitCode)
      return
    }
    this.hold(ptyId, exitCode)
  }

  flush(): void {
    if (this.flushing) return
    this.flushing = true
    let applied = false
    try {
      for (const ptyId of [...this.held.keys()]) {
        const exitCode = this.held.get(ptyId)
        if (exitCode === undefined) continue
        const terminal = this.lookup?.(ptyId)
        if (!terminal) continue
        this.held.delete(ptyId)
        this.apply?.(terminal.id, exitCode)
        applied = true
      }
    } finally {
      this.flushing = false
      if (applied) log('info', 'exit codes applied on bind')
    }
  }

  size(): number {
    return this.held.size
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.held.clear()
    this.lookup = undefined
    this.apply = undefined
  }

  private hold(ptyId: string, exitCode: number): void {
    this.held.set(ptyId, exitCode)
    while (this.held.size > MAX_HELD_EXIT_CODES) {
      const oldest = this.held.keys().next().value
      if (oldest === undefined) break
      this.held.delete(oldest)
      log('warn', 'exit code buffer evicted oldest pty at cap')
    }
  }
}

export const exitCodeBuffer = new ExitCodeBuffer()

export function heldExitCodeCount(): number {
  return exitCodeBuffer.size()
}

export function disposeExitCodeBuffer(): void {
  exitCodeBuffer.dispose()
}

if (import.meta.hot) import.meta.hot.dispose(disposeExitCodeBuffer)
