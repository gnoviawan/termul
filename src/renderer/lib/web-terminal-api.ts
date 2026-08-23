import type {
  GitStatus,
  IpcResult,
  RotatedClaim,
  SpawnedTerminal,
  TerminalApi,
  TerminalAttachResult,
  TerminalCwdChangedCallback,
  TerminalDataCallback,
  TerminalExitCallback,
  TerminalExitCodeChangedCallback,
  TerminalGitBranchChangedCallback,
  TerminalGitStatusChangedCallback,
  TerminalSpawnOptions,
  TerminalStateSnapshot
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
  /**
   * CAP-3 lease credential for this terminal (in-memory only — never
   * persisted). Adopted ONLY on server-confirmed success (spawn reply or a
   * verified attach/rotate); dropped on any server rejection (the host returns
   * one generic UNAUTHORIZED for unknown terminal and bad/revoked credential
   * alike) — and never re-presented afterwards.
   */
  claim?: string
  /**
   * Terminal is unattachable from this client (no/invalid credential). Disconnected
   * terminals are skipped by the reconnect re-attach loop and do not drive
   * reconnect scheduling.
   */
  disconnected: boolean
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
        // CAP-3: re-attach ONLY terminals with a stored lease credential,
        // using their lastSeq cursor. Terminals without a claim cannot be
        // re-attached — mark them disconnected (no credential is ever
        // presented id-only, and a rejected credential is never re-presented).
        for (const [terminalId, tracker] of this.trackers) {
          if (tracker.exited) continue
          if (!tracker.claim) {
            tracker.disconnected = true
            continue
          }
          // CAP-3: capture the credential this re-attach is presenting. A
          // rotate (`severClaim`) that completes while this request is in
          // flight installs a FRESH claim; the in-flight attach then resolves
          // with the generic UNAUTHORIZED for the OLD claim. Clearing
          // unconditionally would discard the fresh claim and strand the
          // terminal (valid lease held but unattachable). Only clear when the
          // tracker still holds the SAME credential this attach presented.
          const presentedClaim = tracker.claim
          void this.request('attach', {
            terminalId,
            claim: tracker.claim,
            lastSeq: tracker.lastSeq
          }).then((r) => {
            if (r.success) {
              tracker.disconnected = false
              return
            }
            if (r.code !== 'NETWORK_ERROR') {
              // Server rejection (single generic UNAUTHORIZED — the host never
              // distinguishes terminal-gone from credential-gone): the lease is
              // invalid/rotated/revoked or the terminal no longer exists. Drop
              // the credential and stop re-presenting it — but ONLY when a
              // newer claim has not superseded it in the meantime.
              if (tracker.claim === presentedClaim) {
                tracker.claim = undefined
                tracker.disconnected = true
              }
            }
            // NETWORK_ERROR keeps the claim for the next reconnect attempt.
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
   * CAP-3 verified attach (always a server round trip). The credential is the
   * gate:
   * - with no credential available, fail locally and mark the terminal
   *   disconnected — an id-only attach is never presented;
   * - the claim and cursor are adopted ONLY on server-confirmed success;
   * - on server rejection the adopted claim is dropped and the terminal is
   *   marked disconnected (never re-present a rejected credential);
   * - refCount is only ever incremented on success — a concurrent slow-path
   *   attach must not reset an outstanding refCount.
   */
  private async performAttach(
    terminalId: string,
    claim: string | undefined,
    lastSeq: number | undefined
  ): Promise<IpcResult<TerminalAttachResult>> {
    const tracker = this.getOrCreate(terminalId)
    const credential = claim ?? tracker.claim
    if (!credential) {
      tracker.disconnected = true
      return { success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }
    }
    // Snapshot the claim held at request time. A rotate (`severClaim`) that
    // completes while this request is in flight installs a FRESH claim; the
    // in-flight attach then resolves with the generic UNAUTHORIZED for the
    // OLD credential. Clearing unconditionally would discard the fresh claim
    // and strand the terminal (valid lease held but unattachable). On
    // rejection, clear ONLY when `tracker.claim` is unchanged since the
    // snapshot — a newer claim installed by `severClaim` is preserved.
    const claimAtRequest = tracker.claim
    const result = await this.request<TerminalAttachResult>('attach', {
      terminalId,
      claim: credential,
      lastSeq: lastSeq ?? tracker.lastSeq
    })
    if (result.success) {
      // Increment — never `= 1`: in-flight attaches must not discard refs.
      tracker.refCount += 1
      tracker.claim = credential
      tracker.disconnected = false
    } else if (result.code !== 'NETWORK_ERROR') {
      // Server rejection (generic UNAUTHORIZED): drop the adopted claim and
      // stop re-presenting it on reconnect — but ONLY when no newer claim was
      // installed while this request was in flight.
      if (tracker.claim === claimAtRequest) {
        tracker.claim = undefined
        tracker.disconnected = true
      }
    }
    return result
  }

  /**
   * Attach using the stored cursor (spawn / renderer-ref flow). Fast path:
   * an already-attached terminal just increments the ref count.
   */
  async attach(terminalId: string, claim?: string): Promise<IpcResult<void>> {
    const tracker = this.getOrCreate(terminalId)
    if (tracker.refCount > 0 && claim === undefined) {
      // Already attached — just increment the ref count (no round trip).
      tracker.refCount++
      return { success: true, data: undefined }
    }
    const result = await this.performAttach(terminalId, claim, undefined)
    return result.success ? { success: true, data: undefined } : result
  }

  /** Attach with an explicit cursor (cross-client handoff / desktop parity). */
  async attachWithCursor(
    terminalId: string,
    claim: string,
    lastSeq: number
  ): Promise<IpcResult<TerminalAttachResult>> {
    return this.performAttach(terminalId, claim, lastSeq)
  }

  /**
   * Adopt a server-issued credential (spawn issuance / successful rotation).
   * Issuance is server-confirmed by definition, so adoption is immediate.
   */
  adoptClaim(terminalId: string, claim?: string): void {
    const tracker = this.getOrCreate(terminalId)
    tracker.claim = claim
    tracker.disconnected = claim === undefined
  }

  /**
   * Drop the credential and mark the terminal disconnected (revocation or
   * rotate/revoke teardown). The server has severed this connection's
   * attachment + authorization, so outstanding renderer refs can no longer be
   * counted as attached: the next attach must re-verify with a credential.
   */
  severClaim(terminalId: string, newClaim?: string): void {
    const tracker = this.trackers.get(terminalId)
    if (!tracker) return
    tracker.refCount = 0
    tracker.claim = newClaim
    tracker.disconnected = !newClaim
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
      tracker = { lastSeq: 0, exited: false, refCount: 0, disconnected: false }
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
      // Seed the terminal's lifecycle/metadata state from the attach snapshot
      // so a client that reattaches after the single change-only event emit
      // still learns branch/status/cwd/exit (closes the "detached" display gap).
      this.dispatchSnapshot(frame.terminalId, frame.snapshot)
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

  /**
   * Fan out an attach/replay snapshot through the same callbacks live events
   * use, so the store updaters (useGitBranch/useGitStatus/useCwd/useExitCode)
   * seed initial state on attach — not only on a change they might have missed.
   * `null` branch/status are meaningful (detached/unknown) and dispatched
   * verbatim; `null` cwd/exitCode are absent values and skipped.
   */
  private dispatchSnapshot(terminalId: string, snapshot: TerminalStateSnapshot): void {
    if (snapshot.cwd !== null) {
      for (const callback of this.cwdCallbacks) callback(terminalId, snapshot.cwd)
    }
    for (const callback of this.branchCallbacks) callback(terminalId, snapshot.gitBranch)
    for (const callback of this.statusCallbacks) callback(terminalId, snapshot.gitStatus)
    if (snapshot.exitCode !== null) {
      for (const callback of this.exitCodeCallbacks) callback(terminalId, snapshot.exitCode)
    }
    if (snapshot.exited) {
      this.markExited(terminalId)
      const exitCode = snapshot.exitCode ?? -1
      for (const callback of this.exitCallbacks) callback(terminalId, exitCode, undefined)
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
    // Stop reconnecting if no terminal is both live AND holds a lease
    // credential — exited/disconnected terminals are never re-presented.
    const activeCount = Array.from(this.trackers.values()).filter(
      (t) => !t.exited && !t.disconnected
    ).length
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
    async spawn(options: TerminalSpawnOptions = {}): Promise<IpcResult<SpawnedTerminal>> {
      const result = await client.request<SpawnedTerminal>(
        'spawn',
        options as Record<string, unknown>
      )
      if (result.success) {
        if (result.data.claim) {
          // Adopt the issued credential, then attach with it so output flows
          // immediately. Reconnect re-attach afterwards reuses the stored claim.
          client.adoptClaim(result.data.id, result.data.claim)
          const attachResult = await client.attach(result.data.id, result.data.claim)
          if (!attachResult.success) {
            // Attach failed — the PTY exists but we can't receive output.
            // Kill it to avoid orphaning, and return the attach failure.
            void client.request('kill', { terminalId: result.data.id })
            client.removeTracker(result.data.id)
            return { success: false, error: attachResult.error, code: attachResult.code }
          }
        } else {
          // Defensive: a claim-less spawn success cannot attach (no credential
          // to present). Return the spawn result WITHOUT killing the PTY — the
          // tracker stays claim-less and reconnect marks it disconnected. This
          // path is unreachable against a host that issues claims; it exists so
          // a malformed reply can never destroy a freshly spawned terminal.
          client.adoptClaim(result.data.id)
        }
      }
      return result
    },
    attach: (terminalId, claim, lastSeq) => client.attachWithCursor(terminalId, claim, lastSeq),
    async rotateClaim(terminalId: string, claim: string): Promise<IpcResult<RotatedClaim>> {
      const result = await client.request<RotatedClaim>('rotate_claim', { terminalId, claim })
      if (result.success) {
        // Teardown (amendment R1): the server detached this connection's
        // attachment and authorization. Adopt the fresh credential and force
        // a re-verified attach for any outstanding refs.
        client.severClaim(terminalId, result.data.claim)
      }
      return result
    },
    async revokeClaim(terminalId: string, claim: string): Promise<IpcResult<void>> {
      const result = await client.request<void>('revoke_claim', { terminalId, claim })
      if (result.success) {
        // Teardown (amendment R1): output stream + write/resize access gone.
        client.severClaim(terminalId)
      }
      return result
    },
    write: (terminalId, data) => client.request('write', { terminalId, data }),
    resize: (terminalId, cols, rows) => client.request('resize', { terminalId, cols, rows }),
    async kill(terminalId): Promise<IpcResult<void>> {
      const result = await client.request<void>('kill', { terminalId })
      // Kill is idempotent on the server (not_found = success).
      // Either way, stop tracking and detach (the claim goes with the tracker).
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
