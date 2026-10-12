/**
 * Client of the host watch hub: the project list, the chat-history index and
 * the agent roster reach the renderer as watches instead of `seq = 0`
 * broadcasts.
 *
 * A watch starts with one full-state frame (revision `n = 1`), then deltas
 * under `n + 1`. The client applies a delta only when it is exactly the next
 * one for the `hostEpoch` it started with. A skipped revision, a different
 * epoch, or a `resync` marker means a frame was lost: it resubscribes and
 * rebuilds from fresh full state. A reconnect does the same for every watch.
 *
 * Frames are handled synchronously in wire order, so the state frame is
 * applied before the `watch` reply that follows it resolves.
 */

import type { WsWatchFrame, WsWatchName } from '@shared/types/web-protocol.types'
import { logFrontendError } from '@/lib/log-api'

/** Bound on one `watch` request. */
const WATCH_REQUEST_TIMEOUT_MS = 10_000
/** Retry delays after a refused or failed `watch`, doubling up to the cap. */
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

/** What the client needs from its transport. */
export interface WatchTransport {
  /** Send a `watch` / `unwatch` request on the live socket. */
  request(
    type: 'watch' | 'unwatch',
    payload: { watch: WsWatchName; scope: string },
    timeoutMs: number
  ): Promise<unknown>
  /** Whether the socket is open and authenticated. */
  isLive(): boolean
}

/** Receives one watch's state and deltas. */
export interface WatchHandlers<State = unknown, Delta = unknown> {
  /** The full state: on every (re)subscribe. Replace everything held for the watch. */
  onState(state: State): void
  /** One delta that follows the state contiguously. */
  onDelta?(delta: Delta): void
}

interface Revision {
  hostEpoch: string
  n: number
}

interface Entry {
  watch: WsWatchName
  scope: string
  handlers: Set<WatchHandlers>
  /** Revision of the last applied frame; `null` until a state frame arrived. */
  revision: Revision | null
  inFlight: boolean
  /** A resubscribe was requested while one was in flight. */
  again: boolean
  attempt: number
  retryTimer: ReturnType<typeof setTimeout> | null
}

function keyOf(watch: WsWatchName, scope: string): string {
  return `${watch}\u0000${scope}`
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export class WatchClient {
  private readonly entries = new Map<string, Entry>()
  private disposed = false

  constructor(private readonly transport: WatchTransport) {}

  /**
   * Watch `(watch, scope)`. The handlers get the full state now (or as soon as
   * the socket is up) and every change after it. Returns the unsubscribe.
   * Several handlers of one watch share the subscription; adding one refreshes
   * the state for all of them.
   */
  subscribe<State = unknown, Delta = unknown>(
    watch: WsWatchName,
    handlers: WatchHandlers<State, Delta>,
    scope = ''
  ): () => void {
    const key = keyOf(watch, scope)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        watch,
        scope,
        handlers: new Set(),
        revision: null,
        inFlight: false,
        again: false,
        attempt: 0,
        retryTimer: null
      }
      this.entries.set(key, entry)
    }
    const handler = handlers as WatchHandlers
    entry.handlers.add(handler)
    this.resubscribe(entry)
    return () => this.release(key, handler)
  }

  /** Route one top-level `watch` frame. */
  handleFrame(frame: WsWatchFrame): void {
    if (this.disposed) return
    const entry = this.entries.get(keyOf(frame.watch, frame.scope ?? ''))
    const revision = frame.revision
    if (
      !entry ||
      !revision ||
      typeof revision.n !== 'number' ||
      typeof revision.hostEpoch !== 'string'
    ) {
      return
    }
    if (frame.reset) {
      entry.revision = { hostEpoch: revision.hostEpoch, n: revision.n }
      entry.attempt = 0
      this.dispatch(entry, (handlers) => handlers.onState(frame.state))
      return
    }
    const last = entry.revision
    if (!last) return // the state this delta follows is still on its way
    if (revision.hostEpoch === last.hostEpoch && revision.n <= last.n) return // duplicate
    const delta = frame.delta as { resync?: unknown } | null | undefined
    if (
      revision.hostEpoch !== last.hostEpoch ||
      revision.n !== last.n + 1 ||
      delta?.resync === true
    ) {
      void logFrontendError({
        level: 'info',
        source: 'WatchClient.discontinuity',
        message: `watch ${entry.watch} lost continuity (have ${last.hostEpoch.slice(0, 8)}#${last.n}, got ${revision.hostEpoch.slice(0, 8)}#${revision.n}); resubscribing`
      })
      this.resubscribe(entry)
      return
    }
    entry.revision = { hostEpoch: revision.hostEpoch, n: revision.n }
    this.dispatch(entry, (handlers) => handlers.onDelta?.(frame.delta))
  }

  /** The socket is authenticated again: every watch rebuilds from fresh state. */
  onConnected(): void {
    for (const entry of this.entries.values()) {
      entry.attempt = 0
      this.resubscribe(entry)
    }
  }

  /** The socket closed: deltas stop, the next connect resubscribes. */
  onDisconnected(): void {
    for (const entry of this.entries.values()) {
      entry.revision = null
      this.clearRetry(entry)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) this.clearRetry(entry)
    this.entries.clear()
  }

  private release(key: string, handler: WatchHandlers): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.handlers.delete(handler)
    if (entry.handlers.size > 0) return
    this.clearRetry(entry)
    this.entries.delete(key)
    if (this.disposed || !this.transport.isLive()) return
    void this.transport
      .request('unwatch', { watch: entry.watch, scope: entry.scope }, WATCH_REQUEST_TIMEOUT_MS)
      .catch((error) => {
        void logFrontendError({
          level: 'info',
          source: 'WatchClient.unwatch',
          message: `unwatch ${entry.watch} failed: ${String(error)}`
        })
      })
  }

  private dispatch(entry: Entry, call: (handlers: WatchHandlers) => void): void {
    for (const handlers of [...entry.handlers]) {
      try {
        call(handlers)
      } catch (error) {
        void logFrontendError({
          level: 'warn',
          source: 'WatchClient.handler',
          message: `a ${entry.watch} watch handler threw: ${String(error)}`
        })
      }
    }
  }

  private clearRetry(entry: Entry): void {
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
  }

  /**
   * Ask the host for fresh state. Deltas are ignored until it arrives. One
   * request per watch is in flight; a trigger meanwhile queues one more.
   */
  private resubscribe(entry: Entry): void {
    // A watch released while its request was in flight must not be asked for again.
    if (this.disposed || this.entries.get(keyOf(entry.watch, entry.scope)) !== entry) return
    this.clearRetry(entry)
    entry.revision = null
    if (!this.transport.isLive()) return // onConnected retries
    if (entry.inFlight) {
      entry.again = true
      return
    }
    entry.inFlight = true
    entry.again = false
    this.transport
      .request('watch', { watch: entry.watch, scope: entry.scope }, WATCH_REQUEST_TIMEOUT_MS)
      .then(() => {
        entry.inFlight = false
        if (entry.again) this.resubscribe(entry)
      })
      .catch((error) => {
        entry.inFlight = false
        if (this.disposed || this.entries.get(keyOf(entry.watch, entry.scope)) !== entry) return
        if (entry.again) {
          this.resubscribe(entry)
          return
        }
        this.scheduleRetry(entry, error)
      })
  }

  private scheduleRetry(entry: Entry, error: unknown): void {
    // A refusal the host will repeat (unknown watch, no scope) is not retried.
    if (errorCode(error) === 'unsupported') {
      void logFrontendError({
        level: 'warn',
        source: 'WatchClient.subscribe',
        message: `the host refused the ${entry.watch} watch: ${String(error)}`
      })
      return
    }
    if (!this.transport.isLive()) return // onConnected retries
    const delay = Math.min(RETRY_BASE_MS * 2 ** entry.attempt, RETRY_MAX_MS)
    entry.attempt += 1
    void logFrontendError({
      level: 'info',
      source: 'WatchClient.subscribe',
      message: `watch ${entry.watch} failed (${String(error)}); retrying in ${delay} ms`
    })
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null
      this.resubscribe(entry)
    }, delay)
  }
}
