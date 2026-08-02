import type {
  GitStatus,
  IpcResult,
  TerminalApi,
  TerminalCwdChangedCallback,
  TerminalDataCallback,
  TerminalExitCallback,
  TerminalExitCodeChangedCallback,
  TerminalGitBranchChangedCallback,
  TerminalGitStatusChangedCallback,
  TerminalInfo,
  TerminalSpawnOptions
} from '@shared/types/ipc.types'
import type {
  WebTerminalEventPayload,
  WebTerminalFrame,
  WebTerminalReply,
  WebTerminalRequestType
} from '@shared/types/web-terminal-protocol.types'

const REQUEST_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8_000
const RECONNECT_MAX_ATTEMPTS = 10
/** How long the page must stay hidden before a return triggers a proactive
 * reconnect. Mobile browsers suspend JS in backgrounded tabs, so the server's
 * keepalive tears the terminal WS down at its Pong-timeout — but the client
 * only learns this when `onclose` is finally delivered on resume (late, or
 * never on a half-open link). Mirrors `WsAcpTransport`: 30s sits between the
 * server's Ping interval and its Pong-timeout. Tunable. */
const VISIBILITY_STALE_THRESHOLD_MS = 30_000

export function resolveTerminalWsUrl(
  locationLike: { protocol: string; host: string } = window.location
): string {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${locationLike.host}/terminal/ws`
}

type Pending = {
  resolve: (reply: WebTerminalReply<unknown>) => void
  timer: ReturnType<typeof setTimeout>
}

/** Tracks per-terminal cursor and attachment state. */
interface TerminalTracker {
  /** Last received output sequence number (0 = no output yet). */
  lastSeq: number
  /** Whether the terminal has exited (stop reconnecting). */
  exited: boolean
  /** Active renderer reference count (detach when it reaches 0). */
  refCount: number
}

export class WebTerminalClient {
  private socket: WebSocket | null = null
  private connecting: Promise<void> | null = null
  /** Reject fn for the in-flight `connect()` promise (executor pattern), so
   * `forceReconnect` can settle it when tearing down a CONNECTING socket —
   * otherwise an awaiting `request()` hangs until its 15s timeout (which only
   * arms AFTER connect resolves). Mirrors WsAcpTransport's teardown approach. */
  private connectingReject: ((error: Error) => void) | null = null
  private disposed = false
  private nextId = 0
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** When the page became hidden (epoch-ms), or null while visible. Drives the
   * visibility-triggered proactive reconnect on mobile idle/background resume. */
  private lastHiddenAt: number | null = null
  /** Bound DOM-listener refs so `dispose()` can detach them. */
  private visibilityHandler: (() => void) | null = null
  private focusHandler: (() => void) | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly trackers = new Map<string, TerminalTracker>()
  private readonly dataCallbacks = new Set<TerminalDataCallback>()
  private readonly exitCallbacks = new Set<TerminalExitCallback>()
  private readonly cwdCallbacks = new Set<TerminalCwdChangedCallback>()
  private readonly branchCallbacks = new Set<TerminalGitBranchChangedCallback>()
  private readonly statusCallbacks = new Set<TerminalGitStatusChangedCallback>()
  private readonly exitCodeCallbacks = new Set<TerminalExitCodeChangedCallback>()

  constructor(
    private readonly url = resolveTerminalWsUrl(),
    private readonly WebSocketImpl: typeof WebSocket = WebSocket
  ) {}

  async request<T>(
    type: WebTerminalRequestType,
    payload: Record<string, unknown>
  ): Promise<IpcResult<T>> {
    try {
      await this.connect()
    } catch (error) {
      return failure('NETWORK_ERROR', error)
    }
    const socket = this.socket
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) {
      return failure('NETWORK_ERROR', 'Terminal websocket is not open')
    }
    const id = `terminal-${++this.nextId}`
    return new Promise<IpcResult<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(failure('NETWORK_ERROR', `Terminal request ${type} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        timer,
        resolve: (reply) => {
          if (reply.success) resolve({ success: true, data: reply.data as T })
          else resolve({ success: false, error: reply.error, code: reply.code })
        }
      })
      socket.send(JSON.stringify({ id, type, payload }))
    })
  }

  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Terminal client disposed'))
    this.attachVisibilityListeners()
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url)
      this.socket = socket
      this.connectingReject = reject
      socket.onopen = () => {
        this.reconnectAttempt = 0
        this.connecting = null
        this.connectingReject = null
        // Re-attach only terminals that haven't exited, using their lastSeq.
        for (const [terminalId, tracker] of this.trackers) {
          if (tracker.exited) continue
          void this.request('attach', { terminalId, lastSeq: tracker.lastSeq }).then((r) => {
            if (!r.success && r.code === 'TERMINAL_NOT_FOUND') {
              // Terminal gone — stop reconnecting it and notify exit.
              this.markExited(terminalId)
            }
          })
        }
        resolve()
      }
      socket.onmessage = (event) => this.handleFrame(String(event.data))
      socket.onerror = () => {
        this.connecting = null
        this.connectingReject = null
        reject(new Error('Terminal websocket connection failed'))
      }
      socket.onclose = () => {
        this.connecting = null
        this.connectingReject = null
        this.socket = null
        this.rejectPending()
        this.scheduleReconnect()
      }
    })
    return this.connecting
  }

  /**
   * Attach to a terminal's output stream. Only marks the terminal as tracked
   * after the server confirms the attachment. Uses the stored lastSeq so
   * reconnect doesn't duplicate output.
   */
  async attach(terminalId: string): Promise<IpcResult<void>> {
    const tracker = this.getOrCreate(terminalId)
    if (tracker.refCount > 0) {
      // Already attached — just increment the ref count.
      tracker.refCount++
      return { success: true, data: undefined }
    }
    const result = await this.request<void>('attach', {
      terminalId,
      lastSeq: tracker.lastSeq
    })
    if (result.success) {
      tracker.refCount = 1
    }
    return result
  }

  /** Detach from a terminal's output stream when ref count reaches 0. */
  detach(terminalId: string): void {
    const tracker = this.trackers.get(terminalId)
    if (!tracker) return
    tracker.refCount = Math.max(0, tracker.refCount - 1)
    if (tracker.refCount <= 0) {
      void this.request('detach', { terminalId }).catch(() => {})
      if (tracker.exited) this.trackers.delete(terminalId)
    }
  }

  /** Remove a terminal from tracking (used after kill/exit). */
  removeTracker(terminalId: string): void {
    void this.request('detach', { terminalId }).catch(() => {})
    this.trackers.delete(terminalId)
  }

  private getOrCreate(terminalId: string): TerminalTracker {
    let tracker = this.trackers.get(terminalId)
    if (!tracker) {
      tracker = { lastSeq: 0, exited: false, refCount: 0 }
      this.trackers.set(terminalId, tracker)
    }
    return tracker
  }

  private markExited(terminalId: string): void {
    const tracker = this.trackers.get(terminalId)
    if (tracker) tracker.exited = true
  }

  onData(callback: TerminalDataCallback): () => void {
    this.dataCallbacks.add(callback)
    return () => this.dataCallbacks.delete(callback)
  }
  onExit(callback: TerminalExitCallback): () => void {
    this.exitCallbacks.add(callback)
    return () => this.exitCallbacks.delete(callback)
  }
  onCwd(callback: TerminalCwdChangedCallback): () => void {
    this.cwdCallbacks.add(callback)
    return () => this.cwdCallbacks.delete(callback)
  }
  onBranch(callback: TerminalGitBranchChangedCallback): () => void {
    this.branchCallbacks.add(callback)
    return () => this.branchCallbacks.delete(callback)
  }
  onStatus(callback: TerminalGitStatusChangedCallback): () => void {
    this.statusCallbacks.add(callback)
    return () => this.statusCallbacks.delete(callback)
  }
  onExitCode(callback: TerminalExitCodeChangedCallback): () => void {
    this.exitCodeCallbacks.add(callback)
    return () => this.exitCodeCallbacks.delete(callback)
  }

  dispose(): void {
    this.disposed = true
    this.detachVisibilityListeners()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.rejectPending()
    this.socket?.close()
  }

  private handleFrame(text: string): void {
    let frame: WebTerminalFrame
    try {
      frame = JSON.parse(text) as WebTerminalFrame
    } catch {
      return
    }
    if ('id' in frame) {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      pending.resolve(frame as WebTerminalReply<unknown>)
      return
    }
    if (frame.type === 'data') {
      const tracker = this.trackers.get(frame.terminalId)
      if (tracker && frame.seq !== undefined) {
        tracker.lastSeq = frame.seq
      }
      const bytes = Uint8Array.from(frame.data)
      for (const callback of this.dataCallbacks) callback(frame.terminalId, bytes)
      return
    }
    if (frame.type === 'replay') {
      // Sequenced replay: write each chunk in order, update cursor.
      const tracker = this.getOrCreate(frame.terminalId)
      for (const chunk of frame.chunks) {
        const bytes = Uint8Array.from(chunk.data)
        for (const callback of this.dataCallbacks) callback(frame.terminalId, bytes)
        tracker.lastSeq = chunk.seq
      }
      // If a gap was reported, write a visible marker.
      if (frame.gap) {
        const marker = new Uint8Array([
          0x1b,
          0x5b,
          0x33,
          0x33,
          0x6d, // ESC[33m (yellow)
          ...new TextEncoder().encode('\r\n[output gap — some history was evicted]\r\n'),
          0x1b,
          0x5b,
          0x30,
          0x6d // ESC[0m (reset)
        ])
        for (const callback of this.dataCallbacks) callback(frame.terminalId, marker)
      }
      return
    }
    if (frame.type === 'gap') {
      // Server reported a broadcast lag — output may have been lost.
      const marker = new Uint8Array([
        0x1b,
        0x5b,
        0x33,
        0x33,
        0x6d,
        ...new TextEncoder().encode('\r\n[output lag — some bytes were dropped]\r\n'),
        0x1b,
        0x5b,
        0x30,
        0x6d
      ])
      for (const callback of this.dataCallbacks) callback(frame.terminalId, marker)
      return
    }
    if (frame.type === 'event') this.handleEvent(frame.payload)
  }

  private handleEvent(event: WebTerminalEventPayload): void {
    switch (event.type) {
      case 'exit':
        this.markExited(event.terminal_id)
        for (const callback of this.exitCallbacks)
          callback(event.terminal_id, event.exit_code ?? -1, event.signal ?? undefined)
        break
      case 'cwd_changed':
        for (const callback of this.cwdCallbacks) callback(event.terminal_id, event.cwd)
        break
      case 'git_branch_changed':
        for (const callback of this.branchCallbacks) callback(event.terminal_id, event.branch)
        break
      case 'git_status_changed':
        for (const callback of this.statusCallbacks) callback(event.terminal_id, event.status)
        break
      case 'exit_code_changed':
        for (const callback of this.exitCodeCallbacks) callback(event.terminal_id, event.exit_code)
        break
    }
  }

  private rejectPending(reason?: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({
        id: 'closed',
        success: false,
        error: reason ?? 'Terminal websocket disconnected',
        code: 'NETWORK_ERROR'
      })
    }
    this.pending.clear()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    // Stop reconnecting if all terminals have exited.
    const activeCount = Array.from(this.trackers.values()).filter((t) => !t.exited).length
    if (activeCount === 0) return
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt++, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch(() => this.scheduleReconnect())
    }, delay)
  }

  /**
   * Attach `visibilitychange` + `focus` listeners (web only) so a return from
   * a backgrounded mobile tab proactively reconnects instead of waiting for an
   * `onclose` the suspended browser delivers late or never. Mirrors
   * `WsAcpTransport`: same threshold, coalescing, and `forceReconnect`
   * semantics. Idempotent; detached in `dispose`.
   */
  private attachVisibilityListeners(): void {
    if (this.visibilityHandler || typeof document === 'undefined') return
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        this.lastHiddenAt = Date.now()
        return
      }
      // visible — a backgrounded tab returning to the foreground.
      this.maybeReconnectOnReturn()
    }
    const onFocus = (): void => {
      // Fallback for platforms where `visibilitychange` is unreliable; only
      // acts when a hide was previously recorded so normal use is a no-op.
      this.maybeReconnectOnReturn()
    }
    this.visibilityHandler = onVisibility
    this.focusHandler = onFocus
    document.addEventListener('visibilitychange', onVisibility)
    // `focus` is a window-level event that does NOT bubble — attach to `window`.
    window.addEventListener('focus', onFocus)
  }

  /** Detach the visibility/focus listeners (called from `dispose`). */
  private detachVisibilityListeners(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    if (this.focusHandler && typeof window !== 'undefined') {
      window.removeEventListener('focus', this.focusHandler)
      this.focusHandler = null
    }
  }

  /**
   * On a return-to-foreground, if the page was hidden past the staleness
   * threshold OR the socket is not OPEN, force a reconnect so a half-open
   * socket killed server-side during AFK is recovered. After reopen, `connect`
   * re-attaches non-exited trackers via their stored `lastSeq`, replaying
   * missed output. Consumes `lastHiddenAt` so a `focus` following a
   * `visibilitychange` does not double-trigger.
   */
  private maybeReconnectOnReturn(): void {
    if (this.disposed) return
    const hiddenAt = this.lastHiddenAt
    this.lastHiddenAt = null
    if (hiddenAt == null) return // never recorded a hide — nothing to recover
    const hiddenFor = Date.now() - hiddenAt
    const socketDown = this.socket?.readyState !== this.WebSocketImpl.OPEN
    if (hiddenFor > VISIBILITY_STALE_THRESHOLD_MS || socketDown) {
      this.forceReconnect(
        socketDown ? 'socket closed while page was hidden' : 'visibility return after idle'
      )
    }
  }

  /**
   * Force a clean reconnect, bypassing the `connect()` fast path that trusts
   * `readyState === OPEN`. Tears down the suspect socket (detaching its
   * handlers so its eventual close does not double-fire `scheduleReconnect`),
   * resets `reconnectAttempt` so AFK never strands the terminal at the backoff
   * ceiling, clears any pending reconnect timer, then reuses `scheduleReconnect`
   * so the existing backoff + `onopen` re-attach machinery runs unchanged.
   */
  private forceReconnect(reason: string): void {
    if (this.disposed) return
    const old = this.socket
    // Capture the in-flight connect promise's reject BEFORE nulling so it can
    // be settled after the socket teardown. Without this, a `request()`
    // awaiting `connect()` (socket CONNECTING) hangs — its 15s timeout only
    // arms AFTER connect resolves, and forceReconnect nulls `connecting`
    // without rejecting the in-flight promise.
    const inflightReject = this.connectingReject
    this.socket = null
    this.connecting = null
    this.connectingReject = null
    this.rejectPending(reason)
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    if (old) {
      // Detach ALL handlers (incl. onopen) so a late CONNECTING→open on the
      // torn-down socket doesn't fire `onopen` against shared `this` state
      // (would clobber reconnectAttempt + null connecting).
      old.onopen = null
      old.onclose = null
      old.onerror = null
      old.onmessage = null
      try {
        old.close()
      } catch {
        // ignore — already closed
      }
    }
    // Settle the in-flight connect promise so awaiters throw → request()
    // catches → returns NETWORK_ERROR (mirrors WsAcpTransport).
    inflightReject?.(new Error(reason))
    this.scheduleReconnect()
  }
}

function failure(code: string, error: unknown): IpcResult<never> {
  return {
    success: false,
    code,
    error: error instanceof Error ? error.message : String(error)
  }
}

const client = new WebTerminalClient()

export function createWebTerminalApi(): TerminalApi {
  return {
    async spawn(options: TerminalSpawnOptions = {}): Promise<IpcResult<TerminalInfo>> {
      const result = await client.request<TerminalInfo>('spawn', options as Record<string, unknown>)
      if (result.success) {
        // Attach after spawn succeeds so output flows immediately.
        const attachResult = await client.attach(result.data.id)
        if (!attachResult.success) {
          // Attach failed — the PTY exists but we can't receive output.
          // Kill it to avoid orphaning, and return the attach failure.
          void client.request('kill', { terminalId: result.data.id })
          client.removeTracker(result.data.id)
          return { success: false, error: attachResult.error, code: attachResult.code }
        }
      }
      return result
    },
    write: (terminalId, data) => client.request('write', { terminalId, data }),
    resize: (terminalId, cols, rows) => client.request('resize', { terminalId, cols, rows }),
    async kill(terminalId): Promise<IpcResult<void>> {
      const result = await client.request<void>('kill', { terminalId })
      // Kill is idempotent on the server (not_found = success).
      // Either way, stop tracking and detach.
      client.removeTracker(terminalId)
      return result
    },
    onData: (callback) => client.onData(callback),
    onExit: (callback) => client.onExit(callback),
    onCwdChanged: (callback) => client.onCwd(callback),
    getCwd: (terminalId) => client.request('get_cwd', { terminalId }),
    onGitBranchChanged: (callback) => client.onBranch(callback),
    getGitBranch: (terminalId) => client.request('get_git_branch', { terminalId }),
    onGitStatusChanged: (callback) => client.onStatus(callback),
    getGitStatus: (terminalId) =>
      client.request<GitStatus | null>('get_git_status', { terminalId }),
    onExitCodeChanged: (callback) => client.onExitCode(callback),
    getExitCode: (terminalId) => client.request('get_exit_code', { terminalId }),
    updateOrphanDetection: (enabled, timeout) =>
      client.request('update_orphan_detection', { enabled, timeout })
  }
}

export const webTerminalInternals = {
  async addRendererRef(terminalId: string, rendererId: string): Promise<IpcResult<void>> {
    const attached = await client.attach(terminalId)
    if (!attached.success) return attached
    return client.request<void>('add_renderer_ref', { terminalId, rendererId })
  },
  removeRendererRef: (terminalId: string, rendererId: string) => {
    client.detach(terminalId)
    return client.request<void>('remove_renderer_ref', { terminalId, rendererId })
  },
  setProtected: (terminalId: string, protectedState: boolean) =>
    client.request<void>('set_protected', { terminalId, protected: protectedState })
}
