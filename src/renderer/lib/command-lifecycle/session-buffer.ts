import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { logFrontendError } from '@/lib/log-api'

// Pre-bind replay memory, bounded per PTY and across PTYs.
// Lifecycle is state-like: the host's own replay is InitShell plus the latest phase
// event, so reaching MAX_PENDING_EVENTS compacts the queue to that shape instead of
// discarding the registration (CommandFinished is dropped; the host exit-code tracker
// reports exit codes separately).
export const MAX_PENDING_EVENTS = 64
// Reaching MAX_PENDING_PTYS evicts the oldest unbound PTY; PENDING_TTL_MS expires a
// PTY whose record never appears. Both discard history, so the PTY is remembered in a
// bounded set (MAX_DISCARDED_PTYS) and accepts nothing but a host InitShell until then.
// Discard invalidates the owning terminal's snapshot once: immediately if lookup
// resolves, otherwise on the first later bind (flush or a blocked suffix).
// Tombstone overflow invalidates unbound Editors before forgetting an obligation.
export const MAX_PENDING_PTYS = 128
export const MAX_DISCARDED_PTYS = 128
// Absolute lifetime from the first event, never extended by subsequent arrivals.
export const PENDING_TTL_MS = 30_000

const PHASE_KINDS = new Set(['PromptReady', 'CommandStarted', 'Desync'])

type Lookup = (ptyId: string) => { id: string } | undefined
type Invalidate = (terminalId: string) => void
type Pending = { events: SessionLifecyclePayload[]; timer: ReturnType<typeof setTimeout> }

function log(level: 'info' | 'warn', message: string): void {
  void logFrontendError({ level, source: 'sessionLifecycle', message })
}

/** Most recent InitShell, then the most recent phase event after it, in that order. */
export function compactLifecycle(events: SessionLifecyclePayload[]): SessionLifecyclePayload[] {
  let init = -1
  for (let i = events.length - 1; i >= 0 && init < 0; i--) {
    if (events[i]?.kind === 'InitShell') init = i
  }
  for (let i = events.length - 1; i > init; i--) {
    const event = events[i]
    if (event && PHASE_KINDS.has(event.kind)) {
      return init < 0 ? [event] : [events[init] as SessionLifecyclePayload, event]
    }
  }
  return init < 0 ? [] : [events[init] as SessionLifecyclePayload]
}

/** One synchronous FIFO per PTY, including arrivals during import and reentrant store notifications. */
export class LifecycleBuffer {
  private readonly pending = new Map<string, Pending>()
  private readonly draining = new Set<string>()
  private readonly discarded = new Set<string>()
  private readonly invalidatePending = new Set<string>()
  private lookup: Lookup | undefined

  constructor(
    private readonly apply: (id: string, event: SessionLifecyclePayload) => void,
    private readonly invalidateOwner?: Invalidate,
    private readonly invalidateUnbound?: () => void
  ) {}

  connect(lookup: Lookup): void {
    this.lookup = lookup
    this.flush()
  }

  forward(event: SessionLifecyclePayload): void {
    const ptyId = event.terminal_id
    if (!this.admit(event)) return
    const terminal = this.lookup?.(ptyId)
    if (terminal && !this.pending.has(ptyId) && !this.draining.has(ptyId)) {
      this.apply(terminal.id, event)
      return
    }
    const entry = this.pending.get(ptyId)
    if (entry) {
      if (entry.events.length >= MAX_PENDING_EVENTS) this.compact(entry)
      entry.events.push(event)
    } else {
      this.createPending(ptyId, event)
    }
    this.drain(ptyId)
  }

  flush(): void {
    for (const ptyId of [...this.invalidatePending]) this.tryInvalidate(ptyId)
    for (const ptyId of this.pending.keys()) this.drain(ptyId)
  }

  /** A PTY whose history was discarded resumes only at a host InitShell. */
  private admit(event: SessionLifecyclePayload): boolean {
    if (!this.discarded.has(event.terminal_id)) return true
    if (event.kind !== 'InitShell') {
      this.tryInvalidate(event.terminal_id)
      log('warn', 'lifecycle event ignored: history discarded, awaiting InitShell')
      return false
    }
    this.discarded.delete(event.terminal_id)
    this.invalidatePending.delete(event.terminal_id)
    log('info', 'lifecycle resumed at InitShell after discard')
    return true
  }

  private compact(entry: Pending): void {
    const kept = compactLifecycle(entry.events)
    log('warn', `lifecycle buffer compacted; dropped=${entry.events.length - kept.length}`)
    entry.events.splice(0, entry.events.length, ...kept)
  }

  private createPending(ptyId: string, event: SessionLifecyclePayload): void {
    const entry: Pending = {
      events: [event],
      timer: setTimeout(() => this.discard(ptyId, 'expired'), PENDING_TTL_MS)
    }
    // Reserve the slot with its first event before callbacks can refill or drain it.
    this.pending.set(ptyId, entry)
    while (this.pending.size > MAX_PENDING_PTYS) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.discard(oldest, 'pty cap')
    }
    log('info', 'buffering before bind')
  }

  private drain(ptyId: string): void {
    if (this.draining.has(ptyId)) return
    const entry = this.pending.get(ptyId)
    if (!entry || !this.lookup?.(ptyId)) return
    this.draining.add(ptyId)
    try {
      while (this.pending.get(ptyId) === entry && entry.events.length) {
        // Re-resolve per event: a reentrant store notification may rebind or unbind the PTY.
        const terminal = this.lookup?.(ptyId)
        if (!terminal) break
        const event = entry.events.shift()
        if (event) this.apply(terminal.id, event)
      }
    } finally {
      this.draining.delete(ptyId)
      if (this.pending.get(ptyId) === entry && entry.events.length === 0)
        this.drop(ptyId, 'drained')
    }
  }

  private discard(ptyId: string, reason: string): void {
    if (!this.drop(ptyId, reason)) return
    this.rememberDiscarded(ptyId)
    this.tryInvalidate(ptyId)
  }

  private rememberDiscarded(ptyId: string): void {
    // A nested discard may enter with cap + 1 entries while fallback is notifying.
    this.trimDiscarded()
    this.discarded.delete(ptyId)
    this.discarded.add(ptyId)
    this.invalidatePending.add(ptyId)
    this.trimDiscarded()
  }

  private trimDiscarded(): void {
    while (this.discarded.size > MAX_DISCARDED_PTYS) {
      const oldest = this.discarded.values().next().value
      if (oldest === undefined) return
      // Nested fallback scans enqueue newly stale Editors before returning. The outer
      // drain invalidates them before external control resumes, even after deletion here.
      if (this.invalidatePending.has(oldest)) this.invalidateUnbound?.()
      // A nested trim or host InitShell may already have removed this tombstone.
      if (this.discarded.size <= MAX_DISCARDED_PTYS) return
      if (this.discarded.values().next().value !== oldest) continue
      this.discarded.delete(oldest)
      this.invalidatePending.delete(oldest)
    }
  }

  private tryInvalidate(ptyId: string): void {
    if (!this.invalidatePending.has(ptyId)) return
    const terminal = this.lookup?.(ptyId)
    if (!terminal) return
    this.invalidatePending.delete(ptyId)
    this.invalidateOwner?.(terminal.id)
  }

  private drop(ptyId: string, reason: string): boolean {
    const entry = this.pending.get(ptyId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(ptyId)
    log(
      reason === 'drained' ? 'info' : 'warn',
      `lifecycle buffer ${reason}; events=${entry.events.length}`
    )
    return true
  }

  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
    this.discarded.clear()
    this.invalidatePending.clear()
    this.lookup = undefined
  }
}
