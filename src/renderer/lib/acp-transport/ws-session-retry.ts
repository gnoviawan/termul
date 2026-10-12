/**
 * Per-session resubscribe retry (CLI-F1). After a reconnect, one session whose
 * `subscribe` fails must NOT tear the socket down or hold back the other
 * sessions: it is retried alone with its own bounded, jittered backoff.
 *
 * The first {@link SESSION_CURSOR_RETRY_ATTEMPTS} retries replay from the cursor
 * again (the failure may be transient); later attempts degrade the session to
 * snapshot + live (ARCHITECTURE-SPINE Conventions › Degradation). After
 * {@link SESSION_RETRY_MAX_ATTEMPTS} the session is handed back via `onGiveUp`.
 */
import { jitteredBackoffMs } from './ws-transport-timing'

export const SESSION_RETRY_BASE_MS = 1_000
export const SESSION_RETRY_MAX_MS = 30_000
export const SESSION_CURSOR_RETRY_ATTEMPTS = 2
export const SESSION_RETRY_MAX_ATTEMPTS = 6

export type SessionRetryMode = 'cursor' | 'degrade'

interface RetryEntry {
  attempt: number
  timer: ReturnType<typeof setTimeout> | null
}

export class SessionResubscribeRetry {
  private readonly entries = new Map<string, RetryEntry>()

  constructor(
    private readonly deps: {
      /** One retry attempt; reject to schedule the next one. */
      run: (sessionId: string, mode: SessionRetryMode) => Promise<void>
      /** The retry budget is exhausted. */
      onGiveUp: (sessionId: string, lastError: unknown) => void
      /** False while the socket is not authenticated + OPEN (the reconnect pass owns recovery). */
      canRun: () => boolean
      random?: () => number
    }
  ) {}

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  /** Arm (or advance) the retry for `sessionId`; a pending timer is left alone. */
  schedule(sessionId: string, lastError?: unknown): void {
    const entry = this.entries.get(sessionId) ?? { attempt: 0, timer: null }
    if (entry.timer) return
    if (entry.attempt >= SESSION_RETRY_MAX_ATTEMPTS) {
      this.entries.delete(sessionId)
      this.deps.onGiveUp(sessionId, lastError)
      return
    }
    const delay = jitteredBackoffMs(
      entry.attempt,
      SESSION_RETRY_BASE_MS,
      SESSION_RETRY_MAX_MS,
      this.deps.random
    )
    entry.attempt += 1
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.fire(sessionId, entry)
    }, delay)
    this.entries.set(sessionId, entry)
  }

  cancel(sessionId: string): void {
    const entry = this.entries.get(sessionId)
    if (entry?.timer) clearTimeout(entry.timer)
    this.entries.delete(sessionId)
  }

  cancelAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.entries.clear()
  }

  private async fire(sessionId: string, entry: RetryEntry): Promise<void> {
    if (this.entries.get(sessionId) !== entry) return
    if (!this.deps.canRun()) {
      this.entries.delete(sessionId)
      return
    }
    const mode: SessionRetryMode =
      entry.attempt <= SESSION_CURSOR_RETRY_ATTEMPTS ? 'cursor' : 'degrade'
    try {
      await this.deps.run(sessionId, mode)
      if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
    } catch (err) {
      if (this.entries.get(sessionId) !== entry) return
      this.schedule(sessionId, err)
    }
  }
}
