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
import type { AcpConnectionState } from './acp-transport'

const REQUEST_TIMEOUT_MS = 15_000
/** Bound on the WS handshake (socket create → `onopen`). The 15s request
 * timeout arms only AFTER `connect()` resolves, so without this a spawn
 * against a stalled `/terminal/ws` upgrade would hang forever. Tunable. */
const CONNECT_TIMEOUT_MS = 10_000
/** Per-terminal cap (characters) on input buffered while `/terminal/ws` is
 * down. Bounded so an outage can never grow memory without limit; overflow
 * refuses new input with INPUT_BLOCKED (buffered data is never silently
 * truncated). */
const INPUT_BUFFER_MAX_CHARS = 8_192
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
   * Story 10: the socket instance this terminal's attach is confirmed on.
   * Attachments live server-side per-connection, so a new socket invalidates
   * every prior attach — comparing against the client's current socket makes
   * the check self-invalidating on reconnect (no per-close reset needed).
   * `undefined` = not attached on the current socket → input buffers instead
   * of writing directly.
   */
  attachedSocket?: WebSocket | null
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
  /** Story 10 (F9): handshake bound for the in-flight `connect()` — torn
   * down socket's timer is cleared on open/error/close/forceReconnect. */
  private connectTimer: ReturnType<typeof setTimeout> | null = null
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
  /**
   * Story 10 (F9/F10): per-terminal pending input while `/terminal/ws` is
   * down (in-memory only — never persisted). Flushed as a single ordered
   * `write` frame per terminal after the reconnect's re-attach succeeds;
   * dropped on terminal exit/kill. Bounded per terminal by
   * INPUT_BUFFER_MAX_CHARS.
   */
  private readonly inputBuffers = new Map<string, string>()
  /**
   * Story 10 (F1): coarse terminal-channel health listener (feeds the
   * connection-status store). Fired on fresh connects ('connecting'), on
   * `onopen` ('connected'), when the backoff loop engages ('reconnecting'),
   * and when the retry budget is exhausted ('disconnected'); a close with
   * nothing live to recover is idle → 'connected'. Web-only in practice —
   * the desktop terminal API is direct Tauri IPC and never constructs this
   * client.
   */
  private onConnectionStateChange?: (state: AcpConnectionState) => void

  constructor(
    private readonly url = resolveTerminalWsUrl(),
    private readonly WebSocketImpl: typeof WebSocket = WebSocket
  ) {}
  /** Story 10: register the terminal-channel connection-health listener. */
  setConnectionStateListener(listener: (state: AcpConnectionState) => void): void {
    this.onConnectionStateChange = listener
  }

  /**
   * Story 10: whether a `write` to this terminal while the channel is down
   * would be BUFFERED (live, claim-held, attachable) rather than fail — the
   * same predicate the write path's buffering branch uses. Drives the
   * ConnectedTerminal outage-overlay copy ("input buffered" is only promised
   * when true).
   */
  isBufferableWhileOffline(terminalId: string): boolean {
    const tracker = this.trackers.get(terminalId)
    return !!tracker && !tracker.exited && !tracker.disconnected && !!tracker.claim
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private emitConnectionState(state: AcpConnectionState): void {
    this.onConnectionStateChange?.(state)
  }

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
      // Story 10 (F1): a fresh connect (initial or manual). Reconnect-cycle
      // attempts run with reconnectAttempt >= 1 and were already signalled
      // 'reconnecting' by scheduleReconnect — don't flap the indicator.
      if (this.reconnectAttempt === 0) this.emitConnectionState('connecting')
      // Story 10 (F9): bound the handshake. Without this, a socket whose
      // upgrade never completes (server accepted TCP but never answers the
      // WS handshake) leaves `connect()` pending forever — the 15s request
      // timeout arms only AFTER connect resolves. On timeout: tear down the
      // socket, mirror the onclose teardown so live terminals keep their
      // reconnect loop, and reject so awaiting requests (e.g. spawn) fail
      // with NETWORK_ERROR (→ the caller's "Failed to create terminal"
      // toast) instead of hanging.
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        try {
          socket.close()
        } catch {
          // ignore — already closed
        }
        if (this.socket === socket) this.socket = null
        this.connecting = null
        this.connectingReject = null
        this.rejectPending('Terminal websocket connect timed out')
        this.scheduleReconnect()
        reject(new Error('Terminal websocket connect timed out'))
      }, CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        this.clearConnectTimer()
        this.reconnectAttempt = 0
        this.connecting = null
        this.connectingReject = null
        this.emitConnectionState('connected')
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
              // Story 10: mark the attach confirmed on THIS socket (writes
              // can go direct again) and replay any input buffered while
              // the channel was down — one ordered write frame per terminal.
              tracker.attachedSocket = socket
              this.flushInputBuffer(terminalId)
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
                // Story 10: the terminal can never be re-attached from this
                // client — its buffered input is undeliverable; drop it
                // rather than stranding it (memory + false hope).
                this.inputBuffers.delete(terminalId)
              }
            }
            // NETWORK_ERROR keeps the claim for the next reconnect attempt.
          })
        }
        resolve()
      }
      socket.onmessage = (event) => this.handleFrame(String(event.data))
      socket.onerror = () => {
        this.clearConnectTimer()
        this.connecting = null
        this.connectingReject = null
        reject(new Error('Terminal websocket connection failed'))
      }
      socket.onclose = () => {
        this.clearConnectTimer()
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
      // Story 10: attach confirmed on the current socket — writes may go
      // direct again, and any input buffered while the channel was down
      // replays now (ordered, single write frame).
      tracker.attachedSocket = this.socket
      this.flushInputBuffer(terminalId)
    } else if (result.code !== 'NETWORK_ERROR') {
      // Server rejection (generic UNAUTHORIZED): drop the adopted claim and
      // stop re-presenting it on reconnect — but ONLY when no newer claim was
      // installed while this request was in flight.
      if (tracker.claim === claimAtRequest) {
        tracker.claim = undefined
        tracker.disconnected = true
        // Story 10: undeliverable input for a terminal whose claim was
        // dropped is discarded, not stranded.
        this.inputBuffers.delete(terminalId)
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
      if (tracker.exited) {
        this.trackers.delete(terminalId)
        // Story 10: an exited terminal's buffer is dropped with its tracker.
        this.inputBuffers.delete(terminalId)
      }
    }
  }

  /** Remove a terminal from tracking (used after kill/exit). */
  removeTracker(terminalId: string): void {
    void this.request('detach', { terminalId }).catch(() => {})
    this.trackers.delete(terminalId)
    // Story 10: a killed terminal's buffered input is dropped with it.
    this.inputBuffers.delete(terminalId)
  }
  /**
   * Story 10 (F9/F10): write terminal input. When the socket is down (or this
   * terminal's attach on the current socket isn't confirmed yet) and the
   * terminal is live with a held lease claim, buffer the input — bounded at
   * INPUT_BUFFER_MAX_CHARS per terminal — and report success; the buffer
   * flushes as one ordered `write` frame after the reconnect's re-attach
   * succeeds. Anything else (exited terminal, no claim, terminal unknown)
   * falls through to a real `request()` — which first `await`s `connect()`
   * and may therefore reconnect and still deliver, or fail NETWORK_ERROR; it
   * never reports a fake success. Overflow refuses the NEW input with
   * INPUT_BLOCKED — buffered data is never silently truncated.
   */
  async write(terminalId: string, data: string): Promise<IpcResult<void>> {
    const tracker = this.trackers.get(terminalId)
    const socketOpen = this.socket?.readyState === this.WebSocketImpl.OPEN
    if (socketOpen && (!tracker || tracker.exited || tracker.attachedSocket === this.socket)) {
      return this.request('write', { terminalId, data })
    }
    if (tracker && !tracker.exited && !tracker.disconnected && tracker.claim) {
      const buffered = this.inputBuffers.get(terminalId) ?? ''
      if (buffered.length + data.length > INPUT_BUFFER_MAX_CHARS) {
        return failure(
          'INPUT_BLOCKED',
          `Terminal input buffer is full (${INPUT_BUFFER_MAX_CHARS} characters) while disconnected — waiting for reconnect`
        )
      }
      this.inputBuffers.set(terminalId, buffered + data)
      // Accepted input MUST eventually flush: if the backoff loop gave up
      // (budget exhausted → 'disconnected') and nothing is scheduled, a live
      // keystroke is the user-present signal that re-arms a fresh cycle.
      this.ensureReconnectArmed()
      return { success: true, data: undefined }
    }
    return this.request('write', { terminalId, data })
  }

  /**
   * Story 10: re-arm the reconnect loop when user input arrives after the
   * retry budget was exhausted (state 'disconnected', no timer pending).
   * No-op while a socket is open, a connect is in flight, or an attempt is
   * already scheduled. Resets the backoff counter so the new cycle starts
   * fast (user is actively typing — they are present and waiting).
   */
  private ensureReconnectArmed(): void {
    if (this.disposed) return
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return
    if (this.connecting || this.reconnectTimer) return
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) this.reconnectAttempt = 0
    this.scheduleReconnect()
  }

  /**
   * Story 10: replay a terminal's buffered input as ONE ordered `write`
   * frame (called after a successful attach/re-attach). Flush semantics are
   * AT-LEAST-ONCE: a NETWORK_ERROR failure can mean the server executed the
   * write but the reply was lost (socket died mid-flight), in which case the
   * re-buffered payload is delivered twice. Duplicate terminal input is
   * visible (echoed) and user-correctable; silently dropping it is not —
   * at-least-once is the deliberate choice. A re-buffer can temporarily
   * exceed INPUT_BUFFER_MAX_CHARS (failed payload + arrivals, bounded ~2x);
   * subsequent writes refuse until the flush succeeds, so growth is bounded.
   * Re-buffering is skipped entirely when the terminal exited or lost its
   * claim while the flush was in flight (input for a dead terminal is moot).
   */
  private flushInputBuffer(terminalId: string): void {
    const buffered = this.inputBuffers.get(terminalId)
    if (!buffered) return
    this.inputBuffers.delete(terminalId)
    void this.request<void>('write', { terminalId, data: buffered }).then((result) => {
      if (!result.success && result.code === 'NETWORK_ERROR') {
        const tracker = this.trackers.get(terminalId)
        if (!tracker || tracker.exited || tracker.disconnected || !tracker.claim) return
        const arrived = this.inputBuffers.get(terminalId) ?? ''
        this.inputBuffers.set(terminalId, buffered + arrived)
      }
    })
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
    // Story 10: an exited terminal never resumes — drop its buffer.
    this.inputBuffers.delete(terminalId)
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
    this.clearConnectTimer()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.rejectPending()
    // Story 10: dispose drops every buffered input (in-memory only).
    this.inputBuffers.clear()
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
    if (activeCount === 0) {
      // Story 10: the socket closed with nothing live to recover (e.g. the
      // last terminal was killed and the server idle-closed the channel).
      // Idle is HEALTHY — the channel connects lazily on next use — so this
      // is 'connected', never a false-alarm 'disconnected'. Skip while a
      // fresh connect (e.g. a spawn) is in flight: it owns the state.
      if (!this.connecting) this.emitConnectionState('connected')
      return
    }
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      // Story 10: retry budget exhausted — lamp/overlay go Disconnected (red).
      // Reset the attempt counter so a later user-triggered reconnect (a fresh
      // spawn, or the first keystroke into a live terminal — see
      // `ensureReconnectArmed`) starts a full new backoff cycle AND reports
      // its 'connecting' progress instead of jumping straight from stale red.
      this.reconnectAttempt = 0
      this.emitConnectionState('disconnected')
      return
    }
    // Story 10: a reconnect attempt is scheduled — the channel is actively
    // recovering (buffered input flushes on the next successful re-attach).
    this.emitConnectionState('reconnecting')
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
    this.clearConnectTimer()
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
    // Story 10: routed through the client's buffering write — while
    // `/terminal/ws` is down, input for live claim-held terminals is buffered
    // (bounded) and replayed after re-attach instead of failing.
    write: (terminalId, data) => client.write(terminalId, data),
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

/**
 * Story 10: register the terminal-channel connection-health listener on the
 * singleton client. Used by the connection-status store wiring (web only).
 */
export function setWebTerminalConnectionStateListener(
  listener: (state: AcpConnectionState) => void
): void {
  client.setConnectionStateListener(listener)
}

/**
 * Story 10: whether input written to `terminalId` while the channel is down
 * would be BUFFERED (live, claim-held, attachable terminal) rather than fail.
 * Drives the ConnectedTerminal outage-overlay copy — "input buffered" is only
 * promised when it is true. Always false on Tauri desktop (no trackers).
 */
export function isWebTerminalBufferable(terminalId: string): boolean {
  return client.isBufferableWhileOffline(terminalId)
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
