import { MAX_CLIENT_ID_LEN, WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mockAttachResult,
  mockPreservedPty,
  mockSpawnedTerminal,
  mockTerminalStateSnapshot
} from '@/lib/test-utils/terminal'
import { resolveTerminalWsUrl, WebTerminalClient } from './web-terminal-api'

const mockLogFrontendError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))

// Reconnect backoff carries ±25 % jitter; pin it to the neutral factor so the
// nominal 500ms/1s/2s delays are exact. The jitter bounds are covered in
// `acp-transport/ws-transport-timing.test.ts`.
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})
afterEach(() => {
  vi.mocked(Math.random).mockRestore()
})

const mockHandleProtocolVersionMismatch = vi.hoisted(() => vi.fn())
vi.mock('./web-protocol-reload', () => ({
  handleProtocolVersionMismatch: mockHandleProtocolVersionMismatch,
  clearProtocolMismatchLatch: vi.fn()
}))

/**
 * Host-side handshake validation, mirroring the Rust `/terminal/ws`
 * `authenticate` arm: version first, then identity. Returns the refusal code,
 * or null when the payload is a valid handshake.
 */
function validateHandshake(payload: Record<string, unknown>): string | null {
  if (payload.protocolVersion !== WS_PROTOCOL_VERSION) return 'PROTOCOL_VERSION_MISMATCH'
  for (const key of ['deviceId', 'clientInstanceId']) {
    const value = payload[key]
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      new TextEncoder().encode(value).length > MAX_CLIENT_ID_LEN
    ) {
      return 'INVALID_CLIENT_IDENTITY'
    }
  }
  return null
}

/**
 * Minimal FakeWebSocket for the terminal protocol (`{id,type,payload}` requests
 * → `{id,success,data}` / `{id,success:false,error,code}` replies). Mirrors the
 * FakeWebSocket shape in `acp-transport.test.ts`: auto-opens on construction so
 * `connect()` resolves, records sent frames, and can be driven to fail attach.
 */
class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  /** When false, constructed sockets never open (stalled-handshake tests). */
  static autoOpen = true
  /** When true, `write` frames are recorded but never replied (flush-failure
   * tests). */
  static holdWrite = false

  readyState = FakeWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    if (!FakeWebSocket.autoOpen) return
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  send(data: string): void {
    this.sent.push(data)
    const req = JSON.parse(data) as { id: string; type: string; payload: Record<string, unknown> }

    if (req.type === 'authenticate') {
      // Test knob: hold the reply so tests can observe the OPEN-but-pending
      // handshake window (the test emits the reply manually).
      if (holdAuthenticateReply) {
        heldAuthenticateId = req.id
        return
      }
      // Versioned handshake (AD-15): the host validates version + identity
      // BEFORE the token on every connection (gated or not). 'ok' — a valid
      // handshake is accepted; 'refuse' — the generic UNAUTHORIZED refusal
      // (bad token); 'mismatch' / 'identity' — force that refusal regardless
      // of the payload.
      const refusal =
        authenticateMode === 'mismatch'
          ? 'PROTOCOL_VERSION_MISMATCH'
          : authenticateMode === 'identity'
            ? 'INVALID_CLIENT_IDENTITY'
            : validateHandshake(req.payload)
      if (refusal) {
        this.emitReply({ id: req.id, success: false, error: refusal, code: refusal })
        return
      }
      if (authenticateMode === 'refuse') {
        this.emitReply({ id: req.id, success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
        return
      }
      this.emitReply({ id: req.id, success: true, data: {} })
      return
    }
    if (req.type === 'write' && FakeWebSocket.holdWrite) return
    if (req.type === 'spawn') {
      // CAP-3: spawn is the only issuance path — the reply carries the claim.
      this.emitReply({ id: req.id, success: true, data: spawnReplyData })
      return
    }
    if (req.type === 'attach') {
      if (holdAttachReply) return
      if (attachReply === 'unauthorized') {
        // The single generic rejection — no distinguishing detail. The real
        // host returns this for unknown terminal AND bad/rotated/revoked claim
        // alike (existence is never revealed).
        this.emitReply({
          id: req.id,
          success: false,
          error: 'Unauthorized',
          code: 'UNAUTHORIZED'
        })
        return
      }
      this.emitReply({
        id: req.id,
        success: true,
        data: mockAttachResult({
          id: req.payload.terminalId as string,
          cwd: '/tmp',
          latestSeq: (req.payload.lastSeq as number) ?? 0
        })
      })
      return
    }
    if (req.type === 'list_preserved') {
      if (listPreservedReply === 'refuse') {
        // The un-authed gate refusal: single generic UNAUTHORIZED, no list.
        this.emitReply({
          id: req.id,
          success: false,
          error: 'Unauthorized',
          code: 'UNAUTHORIZED'
        })
        return
      }
      this.emitReply({
        id: req.id,
        success: true,
        data: { projectId: req.payload.projectId, terminals: listPreservedEntries }
      })
      return
    }
    if (req.type === 'rotate_claim') {
      this.emitReply({ id: req.id, success: true, data: { claim: rotateReplyClaim } })
      return
    }
    this.emitReply({ id: req.id, success: true, data: undefined })
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  emit(obj: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) }))
  }

  emitReply(obj: unknown): void {
    queueMicrotask(() => this.emit(obj))
  }
}

/** Test knob (Story 5): the `list_preserved` reply posture. */
let listPreservedReply: 'ok' | 'refuse' = 'ok'
/** Test knob (Story 5): the terminals returned by `list_preserved`. */
let listPreservedEntries: Array<Record<string, unknown>> = []

/** Test knob: make `attach` replies fail with the generic UNAUTHORIZED. */
let attachReply: 'ok' | 'unauthorized' = 'ok'
/** Test knob: record `attach` frames but never reply (lost/late attach reply). */
let holdAttachReply = false

/** Test knob: the spawn reply data (CAP-3 issuance carries the claim). */
let spawnReplyData: Record<string, unknown> = mockSpawnedTerminal({
  id: 'pty-spawn-1',
  cwd: '/tmp',
  pid: 42,
  claim: 'issued-claim-64-hex'
}) as Record<string, unknown>

/** Test knob: credential returned by rotate_claim replies. */
let rotateReplyClaim = 'rotated-claim-64-hex'
/** Test knob: how the fake answers the connection `authenticate` handshake —
 * 'ok' validates the payload and accepts, 'refuse' answers UNAUTHORIZED (bad
 * token), 'mismatch' / 'identity' force the AD-15 handshake refusals. */
let authenticateMode: 'ok' | 'refuse' | 'mismatch' | 'identity' = 'ok'
/** Test knob: hold the `authenticate` reply (OPEN socket, pending handshake). */
let holdAuthenticateReply = false
/** The request id of the held `authenticate` frame (reply target). */
let heldAuthenticateId: string | null = null

type Tracker = {
  lastSeq: number
  exited: boolean
  refCount: number
  claim?: string
  disconnected: boolean
  attachedSocket?: FakeWebSocket | null
}

type ClientInternals = {
  socket: FakeWebSocket
  trackers: Map<string, Tracker>
  reconnectAttempt: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  lastHiddenAt: number | null
  visibilityHandler: (() => void) | null
  focusHandler: (() => void) | null
  inputBuffers: Map<string, string>
}

/** Override `document.visibilityState` + dispatch `visibilitychange` (jsdom's
 * default is not reliable for the hidden/visible transitions under test). */
function dispatchVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Restore an own `visibilityState = 'visible'` so later suites read visible. */
function restoreVisibility(): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible'
  })
}

/** Request `type`s sent on a FakeWebSocket, in wire order. */
function frameTypes(sock: FakeWebSocket): string[] {
  return sock.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)
}

/** Find the LAST sent request frame of a given type on a FakeWebSocket. */
function findSentRequest(
  sock: FakeWebSocket,
  type: string
): { id: string; type: string; payload: Record<string, unknown> } | undefined {
  for (const raw of [...sock.sent].reverse()) {
    const parsed = JSON.parse(raw) as {
      id: string
      type: string
      payload: Record<string, unknown>
    }
    if (parsed.type === type) return parsed
  }
  return undefined
}

describe('WebTerminalClient host-offline (Close 1001)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function closeWith(client: WebTerminalClient, code: number): FakeWebSocket {
    const sock = (client as unknown as ClientInternals).socket
    sock.readyState = FakeWebSocket.CLOSED
    sock.onclose?.(new CloseEvent('close', { code }))
    return sock
  }

  it('with a live terminal reports host-offline, stops the backoff and reconnects when /health answers', async () => {
    vi.useFakeTimers()
    let healthy = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: healthy }) as Response)
    )
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const states: string[] = []
    client.setConnectionStateListener((state) => states.push(state))
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const oldSocket = internals.socket

    closeWith(client, 1001)
    expect(states.at(-1)).toBe('host-offline')
    expect(internals.reconnectTimer).toBeNull()
    await expect(client.connect()).rejects.toThrow(/offline/i)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(internals.socket).toBeNull()

    healthy = true
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(internals.socket).not.toBe(oldSocket)
    expect(internals.socket?.readyState).toBe(FakeWebSocket.OPEN)
    expect(findSentRequest(internals.socket, 'attach')?.payload).toMatchObject({
      terminalId: 't1',
      claim: 'claim-t1'
    })
    client.dispose()
  })

  it('with no live terminal stays idle and connects lazily', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const states: string[] = []
    client.setConnectionStateListener((state) => states.push(state))
    await client.connect()
    closeWith(client, 1001)
    expect(states).not.toContain('host-offline')
    client.dispose()
  })
})

describe('WebTerminalClient visibility-triggered reconnect (AFK recovery)', () => {
  afterEach(() => {
    restoreVisibility()
    attachReply = 'ok'
    spawnReplyData = mockSpawnedTerminal({
      id: 'pty-spawn-1',
      cwd: '/tmp',
      pid: 42,
      claim: 'issued-claim-64-hex'
    }) as Record<string, unknown>
    rotateReplyClaim = 'rotated-claim-64-hex'
    vi.useRealTimers()
  })

  it('an explicit cursor goes out with the epoch the caller names, or as untrusted without one', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()

    await client.attachWithCursor('t1', 'lease-1', 40, 'epoch-caller')
    expect(findSentRequest(internals.socket, 'attach')?.payload).toEqual({
      terminalId: 't1',
      claim: 'lease-1',
      lastSeq: 40,
      logEpoch: 'epoch-caller'
    })

    // No epoch known for a nonzero cursor: '' matches no real epoch, so the
    // host replays everything with `reset` instead of trusting the cursor.
    await client.attachWithCursor('t2', 'lease-2', 40)
    expect(findSentRequest(internals.socket, 'attach')?.payload).toEqual({
      terminalId: 't2',
      claim: 'lease-2',
      lastSeq: 40,
      logEpoch: ''
    })

    // A zero cursor needs no epoch.
    await client.attachWithCursor('t3', 'lease-3', 0)
    expect(findSentRequest(internals.socket, 'attach')?.payload).toEqual({
      terminalId: 't3',
      claim: 'lease-3',
      lastSeq: 0
    })
    client.dispose()
  })

  it('re-attaches with the log epoch a replay frame set, alongside the cursor', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const oldSocket = internals.socket
    oldSocket.emit({
      type: 'replay',
      terminalId: 't1',
      chunks: [],
      gap: false,
      reset: false,
      logEpoch: 'epoch-t1',
      latestSeq: 0,
      snapshot: mockTerminalStateSnapshot()
    })
    oldSocket.emit({ type: 'data', terminalId: 't1', seq: 7, data: [65] })
    await Promise.resolve()

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()

    expect(internals.socket).not.toBe(oldSocket)
    expect(findSentRequest(internals.socket, 'attach')?.payload).toEqual({
      terminalId: 't1',
      claim: 'claim-t1',
      lastSeq: 7,
      logEpoch: 'epoch-t1'
    })

    // A cursor handed in by a caller never borrows the tracker's epoch, even
    // when its value equals the tracker's own cursor.
    await client.attachWithCursor('t1', 'claim-t1', 7)
    expect(findSentRequest(internals.socket, 'attach')?.payload).toEqual({
      terminalId: 't1',
      claim: 'claim-t1',
      lastSeq: 7,
      logEpoch: ''
    })

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('reconnects + re-attaches trackers with their lastSeq after a long hide', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    // Track a terminal with its lease credential and advance its cursor.
    await client.attach('t1', 'claim-t1')
    const oldSocket = internals.socket
    oldSocket.emit({ type: 'data', terminalId: 't1', seq: 7, data: [65] })
    await Promise.resolve() // flush handleFrame
    expect(internals.trackers.get('t1')?.lastSeq).toBe(7)

    // Long hide (> 30s threshold) → return → proactive force-reconnect.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    await Promise.resolve()

    // Advance past the 500ms backoff → connect re-opens + re-attaches.
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()

    expect(internals.socket).not.toBe(oldSocket) // torn down + replaced
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    // The new socket re-attached the tracker carrying its stored claim +
    // cursor (CAP-3: reattach requires the lease credential).
    const attachReq = findSentRequest(internals.socket, 'attach')
    expect(attachReq).toBeDefined()
    expect(attachReq?.payload).toEqual({
      terminalId: 't1',
      claim: 'claim-t1',
      lastSeq: 7,
      logEpoch: ''
    })

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('does not double-reconnect when a focus follows visibilitychange', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const forceSpy = vi.spyOn(
      client as unknown as { forceReconnect: (reason: string) => void },
      'forceReconnect'
    )

    // Long hide → visible triggers forceReconnect (consumes lastHiddenAt).
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    await Promise.resolve()
    expect(forceSpy).toHaveBeenCalledTimes(1)
    expect(internals.lastHiddenAt).toBeNull() // consumed

    // A `focus` right after (the fallback path) must NOT trigger a 2nd
    // forceReconnect — lastHiddenAt was consumed. `focus` is window-level.
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(forceSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()
    // Exactly one new socket opened (one reconnect, not two).
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(findSentRequest(internals.socket, 'attach')).toBeDefined()

    forceSpy.mockRestore()
    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('drops the claim and marks disconnected when re-attach is rejected (terminal torn down while AFK)', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')
    expect(internals.trackers.get('t1')?.exited).toBe(false)

    // The server tore the terminal down during AFK — the reconnect's re-attach
    // now receives the single generic UNAUTHORIZED (the host never distinguishes
    // terminal-gone from credential-gone, so TERMINAL_NOT_FOUND is never sent).
    attachReply = 'unauthorized'

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(600)
    // The rejection reply + the onopen re-attach `.then` settle.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    // CAP-3: the credential is dropped and never re-presented; the tracker is
    // marked disconnected. It is NOT marked exited — the generic rejection gives
    // the client no signal that the PTY is dead vs. the claim merely invalid.
    expect(internals.trackers.get('t1')?.claim).toBeUndefined()
    expect(internals.trackers.get('t1')?.disconnected).toBe(true)
    expect(internals.trackers.get('t1')?.exited).toBe(false)

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('visibility recovery reconnects but keeps climbing the backoff ladder (only 60 s stable resets it)', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const oldSocket = internals.socket

    // A flapping host: the ladder has climbed and the connection has not been
    // stable for 60 s (the stability timer would have reset it).
    internals.reconnectAttempt = 3
    internals.reconnectTimer = null

    // Long hide → return → visibility recovery path.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    await Promise.resolve()

    // forceReconnect did NOT reset the counter: scheduleReconnect advanced it
    // from 3 to 4 (a reset would have produced 1) and armed the backoff timer.
    expect(internals.reconnectAttempt).toBe(4)
    expect(internals.reconnectTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.resolve()

    // The terminal still recovers: a fresh socket re-attached.
    expect(internals.socket).not.toBe(oldSocket)
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(findSentRequest(internals.socket, 'attach')).toBeDefined()

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('attaches visibility listeners on first connect and detaches on dispose', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    expect(internals.visibilityHandler).toBeNull()
    expect(internals.focusHandler).toBeNull()

    await client.connect()
    expect(internals.visibilityHandler).not.toBeNull()
    expect(internals.focusHandler).not.toBeNull()

    client.dispose()
    expect(internals.visibilityHandler).toBeNull()
    expect(internals.focusHandler).toBeNull()
  })

  it('force-reconnects on a short hide when the socket is already down (socketDown branch)', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const oldSocket = internals.socket
    // The server tore the socket down during AFK (CLOSED), but the client
    // hasn't received onclose yet (suspended-tab / half-open link).
    oldSocket.readyState = FakeWebSocket.CLOSED

    const forceSpy = vi.spyOn(
      client as unknown as { forceReconnect: (reason: string) => void },
      'forceReconnect'
    )

    // SHORT hide (< 30s threshold) — only the `|| socketDown` clause carries.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5_000)
    dispatchVisibility('visible')
    await Promise.resolve()
    expect(forceSpy).toHaveBeenCalledTimes(1)

    // Advance past the 500ms backoff → a new socket opens + re-attaches.
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()
    expect(internals.socket).not.toBe(oldSocket)
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(findSentRequest(internals.socket, 'attach')).toBeDefined()

    forceSpy.mockRestore()
    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })
})

describe('resolveTerminalWsUrl', () => {
  // Pure mapping — no socket involved.
  it('maps https→wss and http→ws and appends /terminal/ws', () => {
    expect(resolveTerminalWsUrl({ protocol: 'https:', host: 'app.example.com' })).toBe(
      'wss://app.example.com/terminal/ws'
    )
    expect(resolveTerminalWsUrl({ protocol: 'http:', host: 'localhost:8080' })).toBe(
      'ws://localhost:8080/terminal/ws'
    )
  })
})

describe('WebTerminalClient frame handling & request lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers()
    attachReply = 'ok'
  })

  it('delivers a data frame as a Uint8Array to onData subscribers', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    const received: Array<{ terminalId: string; bytes: Uint8Array }> = []
    const off = client.onData((terminalId, bytes) => {
      received.push({ terminalId, bytes })
    })

    await client.connect()
    const sock = internals.socket
    sock.emit({ type: 'data', terminalId: 't1', seq: 1, data: [72, 101, 108, 108, 111] })

    expect(received).toHaveLength(1)
    expect(received[0].terminalId).toBe('t1')
    expect(received[0].bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(received[0].bytes)).toEqual([72, 101, 108, 108, 111])

    off()
    client.dispose()
  })

  it('resolves a request with the matching reply data (round-trip)', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    const sock = internals.socket

    // Stub send so it records the frame WITHOUT auto-replying — we drive the
    // reply manually to assert data round-trips.
    const sendStub = vi.spyOn(sock, 'send').mockImplementation((data: string) => {
      sock.sent.push(data)
    })

    const resultPromise = client.request<{ branch: string }>('get_git_branch', {
      terminalId: 't1'
    })
    // Flush past `await this.connect()` inside request() so the (stubbed) send runs.
    await vi.advanceTimersByTimeAsync(0)

    const sent = findSentRequest(sock, 'get_git_branch')
    expect(sent).toBeDefined()
    sock.emit({ id: sent!.id, success: true, data: { branch: 'main' } })
    sendStub.mockRestore()

    const result = await resultPromise
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ branch: 'main' })
    }

    client.dispose()
  })

  describe('CAP-3 claim lifecycle (issuance, adoption, rejection)', () => {
    function makeClient(): {
      client: WebTerminalClient
      internals: ClientInternals
    } {
      const client = new WebTerminalClient(
        'ws://test/terminal/ws',
        FakeWebSocket as unknown as typeof WebSocket
      )
      return { client, internals: client as unknown as ClientInternals }
    }

    afterEach(() => {
      attachReply = 'ok'
      vi.useRealTimers()
    })

    it('spawn reply carries the issued claim (round-trip shape)', async () => {
      vi.useFakeTimers()
      const { client } = makeClient()
      const result = await client.request<{ id: string; claim: string }>('spawn', {
        projectId: 'p1'
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.id).toBe('pty-spawn-1')
        expect(result.data.claim).toBe('issued-claim-64-hex')
      }
      client.dispose()
    })

    it('attaches with claim + lastSeq and adopts both only on server-confirmed success', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()
      const sock = internals.socket

      const result = await client.attach('t1', 'lease-abc')
      expect(result.success).toBe(true)
      const tracker = internals.trackers.get('t1')
      expect(tracker?.claim).toBe('lease-abc')
      expect(tracker?.refCount).toBe(1)
      expect(tracker?.disconnected).toBe(false)

      const attachReq = findSentRequest(sock, 'attach')
      expect(attachReq?.payload).toEqual({ terminalId: 't1', claim: 'lease-abc', lastSeq: 0 })
      client.dispose()
    })

    it('rejects an id-only attach locally (no round trip) and marks disconnected', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()
      const sock = internals.socket

      const result = await client.attach('t2')
      expect(result.success).toBe(false)
      if (!result.success) expect(result.code).toBe('UNAUTHORIZED')
      expect(internals.trackers.get('t2')?.disconnected).toBe(true)
      // No attach frame was presented to the server.
      expect(findSentRequest(sock, 'attach')).toBeUndefined()
      client.dispose()
    })

    it('rejection drops the adopted claim and never re-presents it on reconnect', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()
      attachReply = 'unauthorized'

      const result = await client.attach('t1', 'stolen-or-rotated-claim')
      expect(result.success).toBe(false)
      if (!result.success) expect(result.code).toBe('UNAUTHORIZED')
      expect(internals.trackers.get('t1')?.claim).toBeUndefined()
      expect(internals.trackers.get('t1')?.disconnected).toBe(true)
      expect(internals.trackers.get('t1')?.refCount).toBe(0)

      // Reconnect: the rejected credential must NOT be re-presented — a
      // disconnected terminal does not drive reconnect scheduling at all.
      attachReply = 'ok'
      internals.socket.close()
      await vi.advanceTimersByTimeAsync(600)
      await Promise.resolve()
      expect(internals.socket).toBeNull()
      expect(internals.reconnectTimer).toBeNull()

      client.dispose()
    })

    it('preserves outstanding refCounts across concurrent slow-path attaches', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()

      // Two renderers attach concurrently (both enter the slow path while
      // refCount is still 0). Success must INCREMENT, never reset to 1.
      const [a, b] = await Promise.all([
        client.attach('t1', 'lease-abc'),
        client.attach('t1', 'lease-abc')
      ])
      expect(a.success).toBe(true)
      expect(b.success).toBe(true)
      expect(internals.trackers.get('t1')?.refCount).toBe(2)

      // Fast path increments too.
      const c = await client.attach('t1')
      expect(c.success).toBe(true)
      expect(internals.trackers.get('t1')?.refCount).toBe(3)
      client.dispose()
    })

    it('reconnect re-attaches terminals with a stored claim only', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()

      // t1 holds a lease; t3 does not (e.g. a cross-client record without a
      // credential).
      await client.attach('t1', 'lease-abc')
      internals.trackers.set('t3', { lastSeq: 0, exited: false, refCount: 0, disconnected: false })

      internals.socket.close()
      await vi.advanceTimersByTimeAsync(600)
      await Promise.resolve()

      // Exactly one attach frame — for the credentialed terminal only.
      const attachFrames = internals.socket.sent
        .map((raw) => JSON.parse(raw) as { type: string; payload: { terminalId: string } })
        .filter((f) => f.type === 'attach')
      expect(attachFrames).toHaveLength(1)
      expect(attachFrames[0].payload.terminalId).toBe('t1')
      // The claim-less terminal is marked disconnected.
      expect(internals.trackers.get('t3')?.disconnected).toBe(true)

      if (internals.reconnectTimer) {
        clearTimeout(internals.reconnectTimer)
        internals.reconnectTimer = null
      }
      client.dispose()
    })

    it('rotate adopts the fresh credential and forces a re-verified attach', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()
      await client.attach('t1', 'lease-old')
      expect(internals.trackers.get('t1')?.refCount).toBe(1)

      const rotated = await client.request<{ claim: string }>('rotate_claim', {
        terminalId: 't1',
        claim: 'lease-old'
      })
      expect(rotated.success).toBe(true)
      if (rotated.success) expect(rotated.data.claim).toBe('rotated-claim-64-hex')

      // Facade-level teardown semantics (severClaim): fresh credential held,
      // outstanding refs require a fresh verified attach.
      client.severClaim('t1', rotated.success ? rotated.data.claim : undefined)
      const tracker = internals.trackers.get('t1')
      expect(tracker?.claim).toBe('rotated-claim-64-hex')
      expect(tracker?.refCount).toBe(0)
      expect(tracker?.disconnected).toBe(false)

      // Re-attach with the rotated credential succeeds.
      const reattach = await client.attach('t1', 'rotated-claim-64-hex')
      expect(reattach.success).toBe(true)
      expect(internals.trackers.get('t1')?.refCount).toBe(1)
      client.dispose()
    })

    it('revoke drops the credential and marks the terminal disconnected', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()
      await client.attach('t1', 'lease-old')

      const revoked = await client.request<void>('revoke_claim', {
        terminalId: 't1',
        claim: 'lease-old'
      })
      expect(revoked.success).toBe(true)

      client.severClaim('t1')
      const tracker = internals.trackers.get('t1')
      expect(tracker?.claim).toBeUndefined()
      expect(tracker?.refCount).toBe(0)
      expect(tracker?.disconnected).toBe(true)

      // The revoked terminal no longer drives reconnect scheduling.
      internals.socket.close()
      await vi.advanceTimersByTimeAsync(600)
      expect(internals.reconnectTimer).toBeNull()
      client.dispose()
    })

    it('re-attach with a supplied claim while refs are outstanding increments refCount (never resets)', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()

      // Renderer A attaches with the lease...
      const a = await client.attach('t1', 'lease-abc')
      expect(a.success).toBe(true)
      expect(internals.trackers.get('t1')?.refCount).toBe(1)

      // ...then renderer B re-attaches presenting the same claim while A's
      // ref is outstanding. Success must INCREMENT — a `refCount = 1` reset
      // would discard renderer A's reference and tear its stream down.
      const b = await client.attach('t1', 'lease-abc')
      expect(b.success).toBe(true)
      expect(internals.trackers.get('t1')?.refCount).toBe(2)
      expect(internals.trackers.get('t1')?.claim).toBe('lease-abc')
      expect(internals.trackers.get('t1')?.disconnected).toBe(false)
      client.dispose()
    })

    it('handoff attach with supplied claim + cursor adopts both for reconnect', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()
      const sock = internals.socket

      // Cross-client handoff: the facade attach (attachWithCursor) presents
      // the supplied claim + cursor to the server.
      const result = await client.attachWithCursor('t1', 'handoff-claim', 87)
      expect(result.success).toBe(true)
      // A nonzero cursor with no known epoch is untrusted (`''` matches no epoch).
      expect(findSentRequest(sock, 'attach')?.payload).toEqual({
        terminalId: 't1',
        claim: 'handoff-claim',
        lastSeq: 87,
        logEpoch: ''
      })

      // Server confirmed → the credential is adopted, terminal attachable.
      const tracker = internals.trackers.get('t1')
      expect(tracker?.claim).toBe('handoff-claim')
      expect(tracker?.refCount).toBe(1)
      expect(tracker?.disconnected).toBe(false)

      // Seq-tagged output delivery (bounded replay / live) advances the cursor.
      sock.emit({ type: 'data', terminalId: 't1', seq: 90, data: [104, 105] })
      expect(internals.trackers.get('t1')?.lastSeq).toBe(90)

      // A reconnect re-presents the adopted claim + cursor.
      sock.close()
      await vi.advanceTimersByTimeAsync(600)
      await Promise.resolve()
      expect(internals.socket).not.toBe(sock)
      expect(findSentRequest(internals.socket, 'attach')?.payload).toEqual({
        terminalId: 't1',
        claim: 'handoff-claim',
        lastSeq: 90,
        logEpoch: ''
      })

      if (internals.reconnectTimer) {
        clearTimeout(internals.reconnectTimer)
        internals.reconnectTimer = null
      }
      client.dispose()
    })

    it('rejected handoff attach (claim + cursor) drops the adopted claim and never re-presents it', async () => {
      vi.useFakeTimers()
      const { client, internals } = makeClient()
      await client.connect()
      attachReply = 'unauthorized'

      // Facade attach (attachWithCursor) with supplied claim + cursor — the
      // server rejects with the single generic UNAUTHORIZED error.
      const result = await client.attachWithCursor('t1', 'stolen-or-rotated-claim', 87)
      expect(result.success).toBe(false)
      if (!result.success) expect(result.code).toBe('UNAUTHORIZED')

      // No adopted credential survives the rejection.
      const tracker = internals.trackers.get('t1')
      expect(tracker?.claim).toBeUndefined()
      expect(tracker?.disconnected).toBe(true)
      expect(tracker?.refCount).toBe(0)

      // Reconnect: the rejected credential must never be re-presented — a
      // disconnected terminal does not drive reconnect scheduling at all.
      attachReply = 'ok'
      internals.socket.close()
      await vi.advanceTimersByTimeAsync(600)
      await Promise.resolve()
      expect(internals.socket).toBeNull()
      expect(internals.reconnectTimer).toBeNull()

      client.dispose()
    })
  })

  it('rejects a request awaiting connect to NETWORK_ERROR when forceReconnect fires mid-handshake', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals

    // Kick off a request — connect() opens a CONNECTING socket; the request
    // awaits the in-flight connect promise (15s timeout not yet armed).
    const reqPromise = client.request('spawn', { rows: 24, cols: 80 })
    // A real browser does NOT fire `onopen` for a socket closed mid-handshake;
    // detach the FakeWebSocket's queued `onopen` to model that (otherwise the
    // double's microtask would unconditionally resolve connect and mask the
    // hang the fix prevents).
    internals.socket.onopen = null
    // Synchronously force-reconnect BEFORE any socket event fires.
    ;(client as unknown as { forceReconnect: (reason: string) => void }).forceReconnect(
      'afk return'
    )

    // Flush: the in-flight connect promise rejects → request() catches →
    // NETWORK_ERROR (does NOT hang until the 15s timeout).
    await vi.advanceTimersByTimeAsync(0)
    const result = await reqPromise

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('NETWORK_ERROR')
    }

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })
})

describe('WebTerminalClient attach/replay snapshot dispatch', () => {
  // Closes the "detached for a branch that isn't" gap: a client that reattaches
  // after the single change-only git_branch_changed emit must still learn the
  // branch from the replay frame's snapshot. The snapshot fans out through the
  // same callbacks live events use, so the store updaters seed initial state.
  it('dispatches a replay snapshot through the branch/status/cwd/exit callbacks', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()

    const branchCb = vi.fn()
    const statusCb = vi.fn()
    const cwdCb = vi.fn()
    const exitCb = vi.fn()
    const exitCodeCb = vi.fn()
    client.onBranch(branchCb)
    client.onStatus(statusCb)
    client.onCwd(cwdCb)
    client.onExit(exitCb)
    client.onExitCode(exitCodeCb)

    const internals = client as unknown as ClientInternals
    internals.socket.emit({
      type: 'replay',
      terminalId: 't1',
      chunks: [],
      gap: false,
      latestSeq: 5,
      snapshot: mockTerminalStateSnapshot({
        cwd: '/home/pawbytes/termul',
        gitBranch: 'chore/prettify-server-help',
        gitStatus: {
          modified: 0,
          staged: 0,
          untracked: 0,
          ahead: 0,
          behind: 0,
          hasChanges: false
        }
      })
    })

    expect(branchCb).toHaveBeenCalledWith('t1', 'chore/prettify-server-help')
    expect(statusCb).toHaveBeenCalledWith('t1', expect.objectContaining({ hasChanges: false }))
    expect(cwdCb).toHaveBeenCalledWith('t1', '/home/pawbytes/termul')
    expect(exitCodeCb).not.toHaveBeenCalled()
    expect(exitCb).not.toHaveBeenCalled()

    client.dispose()
  })

  it('marks the terminal exited + dispatches exit when the snapshot says so', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()

    const exitCb = vi.fn()
    const exitCodeCb = vi.fn()
    client.onExit(exitCb)
    client.onExitCode(exitCodeCb)

    const internals = client as unknown as ClientInternals
    internals.socket.emit({
      type: 'replay',
      terminalId: 't2',
      chunks: [],
      gap: false,
      latestSeq: 0,
      snapshot: mockTerminalStateSnapshot({ exitCode: 0, exited: true })
    })

    expect(internals.trackers.get('t2')?.exited).toBe(true)
    expect(exitCodeCb).toHaveBeenCalledWith('t2', 0)
    expect(exitCb).toHaveBeenCalledWith('t2', 0, undefined)

    client.dispose()
  })

  it('dispatches a null gitBranch verbatim (detached/unknown, not swallowed)', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()

    const branchCb = vi.fn()
    client.onBranch(branchCb)

    const internals = client as unknown as ClientInternals
    internals.socket.emit({
      type: 'replay',
      terminalId: 't3',
      chunks: [],
      gap: false,
      latestSeq: 0,
      snapshot: mockTerminalStateSnapshot()
    })

    expect(branchCb).toHaveBeenCalledWith('t3', null)

    client.dispose()
  })

  it('a gap replay with no chunks moves the cursor to the head, so a reconnect does not repeat the gap', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    const internals = client as unknown as ClientInternals
    internals.trackers.set('t5', {
      lastSeq: 3,
      logEpoch: 'epoch-5',
      exited: false,
      refCount: 1,
      disconnected: false
    } as never)

    // Eviction emptied the log: output after seq 3 is gone and the head is 9.
    internals.socket.emit({
      type: 'replay',
      terminalId: 't5',
      chunks: [],
      gap: true,
      reset: false,
      logEpoch: 'epoch-5',
      latestSeq: 9,
      snapshot: mockTerminalStateSnapshot()
    })

    expect(internals.trackers.get('t5')?.lastSeq).toBe(9)
    client.dispose()
  })

  it('clears the terminal before a reset replay and adopts the new log epoch + cursor', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    await client.connect()
    const written: number[][] = []
    client.onData((_id, bytes) => written.push([...bytes]))
    const internals = client as unknown as ClientInternals
    // A cursor from a previous incarnation of the log.
    const tracker = internals.trackers.get('t4') ?? { lastSeq: 0 }
    internals.trackers.set('t4', {
      ...tracker,
      lastSeq: 90,
      logEpoch: 'epoch-old',
      exited: false,
      refCount: 1,
      disconnected: false
    } as never)

    internals.socket.emit({
      type: 'replay',
      terminalId: 't4',
      chunks: [
        { seq: 1, data: [0x61] },
        { seq: 2, data: [0x62] }
      ],
      gap: false,
      reset: true,
      logEpoch: 'epoch-new',
      latestSeq: 2,
      snapshot: mockTerminalStateSnapshot()
    })

    // RIS first (discard what the old log rendered), then the whole replay.
    expect(written).toEqual([[0x1b, 0x63], [0x61], [0x62]])
    expect(internals.trackers.get('t4')).toMatchObject({ lastSeq: 2, logEpoch: 'epoch-new' })

    client.dispose()
  })
})

describe('WebTerminalClient web auth handshake (CAP-1)', () => {
  afterEach(() => {
    window.localStorage.clear()
    authenticateMode = 'ok'
    holdAuthenticateReply = false
    heldAuthenticateId = null
    vi.useRealTimers()
  })

  function newClient(): { client: WebTerminalClient; internals: ClientInternals } {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    return { client, internals: client as unknown as ClientInternals }
  }

  it('sends authenticate with the resolved token BEFORE any terminal op', async () => {
    window.localStorage.setItem('termul.webAuthToken', 's3cret-token')
    const { client, internals } = newClient()
    const spawn = await client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    expect(spawn.success).toBe(true)

    const types = internals.socket.sent.map((s) => {
      // Test-local read of the recorded frame; the fake only writes request JSON.
      const frame = JSON.parse(s) as { type: string }
      return frame.type
    })
    expect(types[0]).toBe('authenticate')
    expect(types).toContain('spawn')
    const authReq = findSentRequest(internals.socket, 'authenticate')
    expect(authReq?.payload).toEqual({
      token: 's3cret-token',
      protocolVersion: WS_PROTOCOL_VERSION,
      deviceId: window.localStorage.getItem('termul.deviceId'),
      clientInstanceId: window.sessionStorage.getItem('termul.clientInstanceId')
    })
    client.dispose()
  })

  it('rejects connect when the gate refuses the token (no terminal op sent)', async () => {
    window.localStorage.setItem('termul.webAuthToken', 'wrong')
    authenticateMode = 'refuse'
    const { client, internals } = newClient()
    // The request starts connect() synchronously; capture the socket before
    // awaiting — a refused connect closes + nulls it.
    const pending = client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    const sock = internals.socket
    const spawn = await pending
    expect(spawn.success).toBe(false)
    const types = sock.sent.map((s) => {
      // Test-local read of the recorded frame; the fake only writes request JSON.
      const frame = JSON.parse(s) as { type: string }
      return frame.type
    })
    expect(types).toEqual(['authenticate'])
    client.dispose()
  })

  it('clears the reconnect budget only after authenticate completes AND the connection stays stable for 60s', async () => {
    vi.useFakeTimers()
    window.localStorage.setItem('termul.webAuthToken', 's3cret-token')
    const { client, internals } = newClient()
    // A live terminal with a claim keeps the reconnect loop engaged
    // (scheduleReconnect no-ops without one).
    await client.attach('t1', 'lease-abc')
    expect(internals.reconnectAttempt).toBe(0)

    // Drop the connection: the retry budget starts (attempt 0 → 1).
    internals.socket.close()
    expect(internals.reconnectTimer).not.toBeNull()
    expect(internals.reconnectAttempt).toBe(1)

    // The gate now REFUSES the token. The socket still opens — but a refused
    // handshake must NOT clear the budget (the failure is auth, not
    // transport): the next retry schedules at attempt 1 → 2, not back to 0.
    authenticateMode = 'refuse'
    await vi.advanceTimersByTimeAsync(600)
    expect(internals.reconnectAttempt).toBe(2)
    expect(internals.reconnectTimer).not.toBeNull()

    // The gate accepts again: a fully authenticated reconnect does NOT clear
    // the budget immediately — only 60 s of stable connection does.
    authenticateMode = 'ok'
    await vi.advanceTimersByTimeAsync(1100)
    expect(internals.socket).not.toBeNull()
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(internals.reconnectTimer).toBeNull()
    expect(internals.reconnectAttempt).toBe(2)
    await vi.advanceTimersByTimeAsync(58_000)
    expect(internals.reconnectAttempt).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(internals.reconnectAttempt).toBe(0)

    client.dispose()
  })

  it('a persistently refusing gate exhausts the reconnect budget instead of looping forever', async () => {
    vi.useFakeTimers()
    window.localStorage.setItem('termul.webAuthToken', 's3cret-token')
    const { client, internals } = newClient()
    await client.attach('t1', 'lease-abc')
    authenticateMode = 'refuse'
    internals.socket.close()
    // 10 attempts at ≤8s backoff: 0.5s + 1s + 2s + 4s + 8s×6 ≈ 55.5s of
    // scheduled retries. With the budget wrongly reset on every socket open
    // (the regression), this loop would NEVER end.
    await vi.advanceTimersByTimeAsync(70_000)
    // Exhausted: no further attempt is scheduled. Story 10 resets the counter
    // at exhaustion so a later user action (ensureReconnectArmed) starts a
    // full fresh cycle instead of sitting stale at max — the loop is still
    // bounded because nothing schedules until that user action.
    expect(internals.reconnectTimer).toBeNull()
    expect(internals.reconnectAttempt).toBe(0)
    // And it stays idle: another full window with no user action schedules
    // nothing (the regression's infinite loop would keep cycling).
    await vi.advanceTimersByTimeAsync(70_000)
    expect(internals.reconnectTimer).toBeNull()
    client.dispose()
  })

  it('ALWAYS authenticates, omitting the token when none is known (ungated host)', async () => {
    const { client, internals } = newClient()
    const spawn = await client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    expect(spawn.success).toBe(true)
    const authReq = findSentRequest(internals.socket, 'authenticate')
    expect(authReq).toBeDefined()
    expect(authReq?.payload).not.toHaveProperty('token')
    expect(authReq?.payload).toMatchObject({ protocolVersion: WS_PROTOCOL_VERSION })
    expect(frameTypes(internals.socket)[0]).toBe('authenticate')
    client.dispose()
  })

  it('a pre-gate server answering NOT_IMPLEMENTED is refused, not tolerated (no compat shim)', async () => {
    const { client, internals } = newClient()
    const origSend = FakeWebSocket.prototype.send
    FakeWebSocket.prototype.send = function (this: FakeWebSocket, data: string) {
      const req = JSON.parse(data) as { id: string; type: string }
      if (req.type === 'authenticate') {
        this.sent.push(data)
        this.emitReply({ id: req.id, success: false, error: 'x', code: 'NOT_IMPLEMENTED' })
        return
      }
      origSend.call(this, data)
    }
    try {
      const spawn = await client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
      expect(spawn.success).toBe(false)
      expect(mockHandleProtocolVersionMismatch).not.toHaveBeenCalled()
    } finally {
      FakeWebSocket.prototype.send = origSend
      client.dispose()
    }
    expect(internals.socket ?? null).toBeNull()
  })

  it('a concurrent connect() joins the in-flight authenticate handshake instead of the OPEN fast path', async () => {
    // Regression (CWE-862-adjacent race): while the socket is OPEN but the
    // authenticate reply is still pending, a concurrent connect() must NOT
    // resolve on the OPEN fast path — its request would race out pre-auth and
    // the gated server would answer UNAUTHORIZED.
    window.localStorage.setItem('termul.webAuthToken', 's3cret-token')
    holdAuthenticateReply = true
    const { client, internals } = newClient()

    const first = client.connect()
    // Flush the fake's auto-open microtask: socket OPEN, authenticate sent,
    // reply held — the exact in-flight window.
    await Promise.resolve()
    await Promise.resolve()
    const sock = internals.socket
    expect(sock.readyState).toBe(FakeWebSocket.OPEN)
    const authReq = findSentRequest(sock, 'authenticate')
    expect(authReq).toBeDefined()

    // Concurrent callers during the handshake: neither connect() resolves nor
    // does any terminal op go out before authentication completes.
    let secondSettled = false
    const second = client.connect().then(() => {
      secondSettled = true
    })
    const spawn = client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    expect(findSentRequest(sock, 'spawn')).toBeUndefined()

    // Complete the handshake: both connect() calls resolve and only THEN the
    // queued op is sent (authenticate strictly precedes spawn on the wire).
    sock.emitReply({ id: heldAuthenticateId, success: true, data: {} })
    await first
    await second
    expect(secondSettled).toBe(true)
    const result = await spawn
    expect(result.success).toBe(true)
    const types = sock.sent.map((s) => {
      // Test-local read of the recorded frame; the fake only writes request JSON.
      const frame = JSON.parse(s) as { type: string }
      return frame.type
    })
    expect(types[0]).toBe('authenticate')
    expect(types.indexOf('spawn')).toBeGreaterThan(types.indexOf('authenticate'))

    // Post-handshake: an already-open AND authenticated connection resolves
    // immediately (no new socket, no new handshake).
    await client.connect()
    expect(internals.socket).toBe(sock)

    client.dispose()
  })
})

describe('WebTerminalClient protocol handshake refusals (AD-15)', () => {
  beforeEach(() => {
    mockHandleProtocolVersionMismatch.mockClear()
    mockLogFrontendError.mockClear()
  })

  afterEach(() => {
    authenticateMode = 'ok'
    window.localStorage.clear()
    vi.useRealTimers()
  })

  function newClient(): { client: WebTerminalClient; internals: ClientInternals } {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    return { client, internals: client as unknown as ClientInternals }
  }

  it('PROTOCOL_VERSION_MISMATCH halts reconnecting, reports once, and surfaces disconnected', async () => {
    vi.useFakeTimers()
    const { client, internals } = newClient()
    // A live claimed terminal would normally drive an endless reconnect loop.
    await client.attach('t1', 'lease-abc')
    const states: string[] = []
    client.setConnectionStateListener((state) => states.push(state))

    authenticateMode = 'mismatch'
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(70_000)

    expect(mockHandleProtocolVersionMismatch).toHaveBeenCalledTimes(1)
    expect(mockHandleProtocolVersionMismatch).toHaveBeenCalledWith('WebTerminalClient')
    expect(internals.reconnectTimer).toBeNull()
    expect(client.getConnectionState()).toBe('disconnected')
    expect(states.at(-1)).toBe('disconnected')

    // Dormant: a later request fails fast without opening another socket.
    const spawn = await client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    expect(spawn.success).toBe(false)
    expect(mockHandleProtocolVersionMismatch).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('INVALID_CLIENT_IDENTITY is non-retryable and never reloads', async () => {
    vi.useFakeTimers()
    const { client, internals } = newClient()
    await client.attach('t1', 'lease-abc')
    authenticateMode = 'identity'
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(70_000)

    expect(mockHandleProtocolVersionMismatch).not.toHaveBeenCalled()
    expect(internals.reconnectTimer).toBeNull()
    expect(client.getConnectionState()).toBe('disconnected')
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        source: 'WebTerminalClient.handshake',
        message: expect.stringContaining('INVALID_CLIENT_IDENTITY')
      })
    )
    client.dispose()
  })

  it('a first-connect version mismatch fails the request with NETWORK_ERROR and no terminal op', async () => {
    authenticateMode = 'mismatch'
    const { client, internals } = newClient()
    const pending = client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    const sock = internals.socket
    const spawn = await pending
    expect(spawn).toMatchObject({ success: false, code: 'NETWORK_ERROR' })
    expect(frameTypes(sock)).toEqual(['authenticate'])
    expect(mockHandleProtocolVersionMismatch).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('never logs the web auth token on a refusal', async () => {
    window.localStorage.setItem('termul.webAuthToken', 'super-secret-token')
    authenticateMode = 'mismatch'
    const { client } = newClient()
    await client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    expect(JSON.stringify(mockLogFrontendError.mock.calls)).not.toContain('super-secret-token')
    client.dispose()
  })
})

describe('WebTerminalClient connect timeout (Story 10, F9)', () => {
  afterEach(() => {
    FakeWebSocket.autoOpen = true
    vi.useRealTimers()
  })

  it('fails a stalled handshake within 10s with NETWORK_ERROR instead of hanging', async () => {
    vi.useFakeTimers()
    FakeWebSocket.autoOpen = false // server accepted TCP but never completes the upgrade
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals

    let settled = false
    const reqPromise = client.request('spawn', { cols: 80, rows: 24 }).then((r) => {
      settled = true
      return r
    })

    // The 15s request timeout arms only after connect resolves — before the
    // fix this hung forever. Just under the 10s connect bound: still pending.
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const result = await reqPromise
    expect(settled).toBe(true)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.code).toBe('NETWORK_ERROR')
    // The stalled socket was torn down.
    expect(internals.socket).toBeNull()

    client.dispose()
  })

  it('a stalled handshake during the reconnect loop reschedules instead of stranding live terminals', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')

    // Drop → backoff (500ms) → the reconnect attempt's handshake stalls.
    internals.socket.close()
    FakeWebSocket.autoOpen = false
    await vi.advanceTimersByTimeAsync(600)
    expect(internals.socket).not.toBeNull() // stalled CONNECTING socket exists

    // The connect timeout tears it down and the loop schedules another
    // attempt (backoff 1000ms) instead of waiting forever.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(internals.reconnectTimer).not.toBeNull()

    // The server recovers: the next attempt opens and re-attaches.
    FakeWebSocket.autoOpen = true
    await vi.advanceTimersByTimeAsync(1_100)
    await vi.advanceTimersByTimeAsync(0)
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(findSentRequest(internals.socket, 'attach')?.payload).toEqual({
      terminalId: 't1',
      claim: 'claim-t1',
      lastSeq: 0
    })

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('bounds upgrade + authenticate by one ~10s handshake: a held authenticate reply fails at 10s', async () => {
    vi.useFakeTimers()
    window.localStorage.setItem('termul.webAuthToken', 's3cret-token')
    holdAuthenticateReply = true
    try {
      const client = new WebTerminalClient(
        'ws://test/terminal/ws',
        FakeWebSocket as unknown as typeof WebSocket
      )
      const internals = client as unknown as ClientInternals

      let settled = false
      const reqPromise = client.request('spawn', { cols: 80, rows: 24 }).then((r) => {
        settled = true
        return r
      })
      // Upgrade completed instantly; only `authenticate` is unanswered.
      await vi.advanceTimersByTimeAsync(9_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const result = await reqPromise
      expect(result.success).toBe(false)
      if (!result.success) expect(result.code).toBe('NETWORK_ERROR')
      expect(internals.socket).toBeNull()
      client.dispose()
    } finally {
      holdAuthenticateReply = false
      heldAuthenticateId = null
      window.localStorage.removeItem('termul.webAuthToken')
    }
  })

  it('recycles the connection when a re-attach times out on an OPEN socket, then re-attaches and flushes buffered input (D8-F1)', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')

    // Drop → reconnect whose `attach` reply never arrives.
    holdAttachReply = true
    try {
      internals.socket.close()
      await vi.advanceTimersByTimeAsync(600)
      const staleSocket = internals.socket
      expect(staleSocket.readyState).toBe(FakeWebSocket.OPEN)
      expect(findSentRequest(staleSocket, 'attach')).toBeDefined()

      // The attach request times out (15s) on a still-OPEN socket: the
      // connection is recycled so the reconnect cycle re-runs the attach —
      // it must not stay OPEN with `attachedSocket` stale and input buffering.
      await vi.advanceTimersByTimeAsync(15_000)
      expect(staleSocket.readyState).toBe(FakeWebSocket.CLOSED)
      expect(internals.socket).toBeNull()
      expect(internals.reconnectTimer).not.toBeNull()

      // Input typed meanwhile is buffered, never silently dropped.
      const write = await client.write('t1', 'ls\n')
      expect(write.success).toBe(true)
      expect(internals.inputBuffers.get('t1')).toBe('ls\n')

      // The server answers again: next cycle re-attaches and flushes.
      holdAttachReply = false
      await vi.advanceTimersByTimeAsync(1_100)
      await vi.advanceTimersByTimeAsync(0)
      expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
      expect(internals.trackers.get('t1')?.attachedSocket).toBe(internals.socket)
      expect(findSentRequest(internals.socket, 'write')?.payload).toEqual({
        terminalId: 't1',
        data: 'ls\n'
      })
      expect(internals.inputBuffers.get('t1')).toBeUndefined()
    } finally {
      holdAttachReply = false
      client.dispose()
    }
  })
})

describe('WebTerminalClient connection-state feed (Story 10, F1)', () => {
  afterEach(() => {
    FakeWebSocket.autoOpen = true
    vi.useRealTimers()
  })

  it('fires connecting → connected on a fresh connect', async () => {
    vi.useFakeTimers()
    const states: string[] = []
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    client.setConnectionStateListener((state) => states.push(state))
    await client.connect()
    expect(states).toEqual(['connecting', 'connected'])
    client.dispose()
  })

  it('fires reconnecting on drop and connected after the re-attach', async () => {
    vi.useFakeTimers()
    const states: string[] = []
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    client.setConnectionStateListener((state) => states.push(state))
    await client.connect()
    await client.attach('t1', 'claim-t1')
    states.length = 0

    internals.socket.close()
    expect(states).toEqual(['reconnecting'])

    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(0)
    // Reconnect cycle does NOT flap through 'connecting' — it stays
    // 'reconnecting' until the socket re-opens.
    expect(states).toEqual(['reconnecting', 'connected'])

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('fires disconnected when the retry budget is exhausted', async () => {
    vi.useFakeTimers()
    const states: string[] = []
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    client.setConnectionStateListener((state) => states.push(state))
    await client.connect()
    await client.attach('t1', 'claim-t1')
    states.length = 0

    // Simulate a backoff loop that already exhausted RECONNECT_MAX_ATTEMPTS.
    internals.reconnectAttempt = 10
    internals.socket.close()

    expect(states).toEqual(['disconnected'])
    expect(internals.reconnectTimer).toBeNull()
    client.dispose()
  })

  it('does NOT report disconnected when the idle socket closes with zero live terminals', async () => {
    // Kill the last terminal, then the server idle-closes the socket: nothing
    // is wrong — the channel is just unused. No red false alarm.
    const states: string[] = []
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    client.setConnectionStateListener((state) => states.push(state))
    await client.connect()
    await client.attach('t1', 'claim-t1')
    states.length = 0

    client.removeTracker('t1')
    internals.socket.close()

    expect(states).not.toContain('disconnected')
    expect(states[states.length - 1]).toBe('connected')
    expect(internals.reconnectTimer).toBeNull()
    client.dispose()
  })

  it('a keystroke after budget exhaustion re-arms the reconnect loop (input flushes again)', async () => {
    vi.useFakeTimers()
    const states: string[] = []
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    client.setConnectionStateListener((state) => states.push(state))
    await client.connect()
    await client.attach('t1', 'claim-t1')
    states.length = 0

    // Exhaust the retry budget → 'disconnected', nothing scheduled.
    internals.reconnectAttempt = 10
    internals.socket.close()
    expect(states).toEqual(['disconnected'])
    expect(internals.reconnectTimer).toBeNull()

    // The user keeps typing: input buffers AND the loop re-arms (the
    // keystroke is the user-present signal) — the outage is no longer a
    // one-way trap for accepted input.
    const r = await client.write('t1', 'x')
    expect(r.success).toBe(true)
    expect(states).toEqual(['disconnected', 'reconnecting'])
    expect(internals.reconnectTimer).not.toBeNull()

    // The re-armed cycle reconnects and the buffered keystroke flushes.
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(0)
    expect(findSentRequest(internals.socket, 'write')?.payload).toEqual({
      terminalId: 't1',
      data: 'x'
    })

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })
})

describe('WebTerminalClient offline input buffering (Story 10, F9/F10)', () => {
  afterEach(() => {
    FakeWebSocket.autoOpen = true
    FakeWebSocket.holdWrite = false
    vi.useRealTimers()
  })

  function makeClient(): { client: WebTerminalClient; internals: ClientInternals } {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    return { client, internals: client as unknown as ClientInternals }
  }

  it('buffers input while the socket is down and flushes it as one ordered write after re-attach', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')

    internals.socket.close()
    const r1 = await client.write('t1', 'ls ')
    const r2 = await client.write('t1', '-la\r')
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(internals.inputBuffers.get('t1')).toBe('ls -la\r')

    // Backoff → reconnect → re-attach succeeds → buffer flushes.
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(0)

    const writeReq = findSentRequest(internals.socket, 'write')
    expect(writeReq?.payload).toEqual({ terminalId: 't1', data: 'ls -la\r' })
    expect(internals.inputBuffers.has('t1')).toBe(false)

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('refuses new input with INPUT_BLOCKED past the 8K cap without dropping buffered data', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    internals.socket.close()

    const big = 'x'.repeat(8_192)
    const r1 = await client.write('t1', big)
    expect(r1.success).toBe(true)

    const r2 = await client.write('t1', 'y')
    expect(r2.success).toBe(false)
    if (!r2.success) expect(r2.code).toBe('INPUT_BLOCKED')
    // The buffered payload is intact — the cap refuses NEW input; it never
    // silently truncates what was already accepted.
    expect(internals.inputBuffers.get('t1')).toBe(big)

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('never buffers input for a terminal without a lease claim (no fake success)', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    // Claim-less tracker (e.g. a cross-client record this client cannot
    // re-attach) — buffering would strand the input forever.
    internals.trackers.set('t3', { lastSeq: 0, exited: false, refCount: 0, disconnected: false })
    internals.socket.close()

    await client.write('t3', 'x')
    expect(internals.inputBuffers.has('t3')).toBe(false)
    // The write fell through to a real request (fresh socket, real frame) —
    // the server decides its fate; nothing is faked locally.
    expect(findSentRequest(internals.socket, 'write')?.payload).toEqual({
      terminalId: 't3',
      data: 'x'
    })

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('re-buffers (order preserved) when the flush fails while the channel is still down', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    internals.socket.close()
    await client.write('t1', 'abc')

    // Reconnect succeeds, but the flush write gets no reply...
    FakeWebSocket.holdWrite = true
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(0)
    const newSock = internals.socket
    expect(findSentRequest(newSock, 'write')?.payload).toEqual({
      terminalId: 't1',
      data: 'abc'
    })
    expect(internals.inputBuffers.has('t1')).toBe(false) // in flight

    // ...because the socket died again mid-flush; a keystroke lands after the
    // drop but before the flush failure settles.
    newSock.close()
    const rz = await client.write('t1', 'Z')
    expect(rz.success).toBe(true)
    await vi.advanceTimersByTimeAsync(0)

    // The failed flush re-buffers AHEAD of the newer keystroke.
    expect(internals.inputBuffers.get('t1')).toBe('abcZ')

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('a flush that got no answer is resent under the SAME commandId (never typed twice), newer input under a new one', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    internals.socket.close()
    await client.write('t1', 'abc')

    FakeWebSocket.holdWrite = true
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(0)
    const firstFrame = findSentRequest(internals.socket, 'write') as { commandId?: string }
    expect(firstFrame.commandId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    // The channel dies mid-flush; a keystroke lands after the drop.
    internals.socket.close()
    await client.write('t1', 'Z')
    await vi.advanceTimersByTimeAsync(0)
    expect(internals.inputBuffers.get('t1')).toBe('abcZ')

    // Reconnect: the next flush resends 'abc' under the first id, then 'Z'.
    FakeWebSocket.holdWrite = false
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(0)
    const writes = internals.socket.sent
      .map(
        (frame: string) =>
          JSON.parse(frame) as { type: string; payload: { data?: string }; commandId?: string }
      )
      .filter((frame: { type: string }) => frame.type === 'write')
    expect(writes.map((frame: { payload: { data?: string } }) => frame.payload.data)).toEqual([
      'abc',
      'Z'
    ])
    expect(writes[0].commandId).toBe(firstFrame.commandId)
    expect(writes[1].commandId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(writes[1].commandId).not.toBe(writes[0].commandId)

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('drops the buffer when the terminal exits', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const sock = internals.socket
    sock.close()
    await client.write('t1', 'abc')
    expect(internals.inputBuffers.get('t1')).toBe('abc')

    // The exit event lands on the torn-down socket's still-attached handler
    // (models an exit delivered just as the channel dropped).
    sock.emit({
      type: 'event',
      payload: { type: 'exit', terminal_id: 't1', exit_code: 0, signal: null }
    })
    expect(internals.trackers.get('t1')?.exited).toBe(true)
    expect(internals.inputBuffers.has('t1')).toBe(false)

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('drops the buffer when the terminal is killed (removeTracker)', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    internals.socket.close()
    await client.write('t1', 'abc')
    expect(internals.inputBuffers.get('t1')).toBe('abc')

    client.removeTracker('t1')
    expect(internals.inputBuffers.has('t1')).toBe(false)

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })
})

describe('Story 10: severClaim buffering + durable recovery failure logs', () => {
  afterEach(() => {
    FakeWebSocket.autoOpen = true
    FakeWebSocket.holdWrite = false
    mockLogFrontendError.mockClear()
    vi.useRealTimers()
  })

  function makeClient(): { client: WebTerminalClient; internals: ClientInternals } {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    return { client, internals: client as unknown as ClientInternals }
  }

  it('severClaim buffers subsequent writes until a re-attach confirms (attachedSocket cleared)', async () => {
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const sock = internals.socket

    // Rotation teardown: the server severed this connection's attachment, so
    // the confirmed attach on the still-OPEN socket no longer holds.
    client.severClaim('t1', 'claim-t1-rotated')

    const r = await client.write('t1', 'echo hi\r')
    expect(r.success).toBe(true)
    expect(internals.inputBuffers.get('t1')).toBe('echo hi\r')
    // Nothing went direct on the severed attachment.
    expect(findSentRequest(sock, 'write')).toBeUndefined()
    client.dispose()
  })

  it('logs the handshake timeout with the operation and the 10s bound', async () => {
    vi.useFakeTimers()
    FakeWebSocket.autoOpen = false
    const { client } = makeClient()
    const reqPromise = client.request('spawn', { cols: 80, rows: 24 })

    await vi.advanceTimersByTimeAsync(10_000)
    await reqPromise

    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'WebTerminalClient.connect',
        message: expect.stringContaining('10000ms')
      })
    )
    client.dispose()
  })

  it('logs the input-buffer refusal without the refused input', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    internals.socket.close()

    await client.write('t1', 'x'.repeat(8_192))
    const r = await client.write('t1', 'secret-keystroke')
    expect(r.success).toBe(false)

    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'WebTerminalClient.write',
        message: expect.stringContaining('buffer full')
      })
    )
    const logged = mockLogFrontendError.mock.calls.map((c) => String(c[0]?.message)).join('\n')
    expect(logged).not.toContain('secret-keystroke')
    expect(logged).not.toContain('xxxx')

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('logs a buffered-input replay failure when the flush dies mid-flight', async () => {
    vi.useFakeTimers()
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')
    internals.socket.close()
    await client.write('t1', 'abc')

    FakeWebSocket.holdWrite = true
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(0)
    mockLogFrontendError.mockClear()
    // The socket dies mid-flush → the replay write fails NETWORK_ERROR and
    // the payload is re-buffered — that failure is logged.
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(0)

    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'WebTerminalClient.flushInputBuffer',
        message: expect.stringContaining('re-buffered')
      })
    )

    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('logs retry-budget exhaustion when the channel gives up', async () => {
    const { client, internals } = makeClient()
    await client.connect()
    await client.attach('t1', 'claim-t1')

    internals.reconnectAttempt = 10
    internals.socket.close()

    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        source: 'WebTerminalClient.scheduleReconnect',
        message: expect.stringContaining('budget exhausted')
      })
    )
    client.dispose()
  })
})

describe('Story 5: listPreserved (cross-reload reattach discovery)', () => {
  const entries = [
    mockPreservedPty({
      id: 'terminal-100-1',
      shell: '/bin/bash',
      cwd: '/projects/a',
      pid: 11,
      claim: 'fresh-claim-a-64hex'
    }),
    mockPreservedPty({
      id: 'terminal-100-2',
      shell: '/bin/bash',
      cwd: '/projects/a',
      pid: 12,
      claim: 'fresh-claim-b-64hex'
    })
  ]

  beforeEach(() => {
    listPreservedReply = 'ok'
    listPreservedEntries = entries
    authenticateMode = 'ok'
    attachReply = 'ok'
  })

  afterEach(() => {
    listPreservedReply = 'ok'
    listPreservedEntries = entries
    vi.useRealTimers()
  })

  /**
   * The singleton `listPreservedAndAdoptClaims` drives the module-level
   * `client`, whose WebSocket constructor was bound at import time — not
   * stubbable per-test. Instead drive the SAME op through a dedicated
   * `WebTerminalClient` instance bound to FakeWebSocket (matching every
   * other suite here), asserting the wire frames + claim adoption the
   * facade path performs.
   */
  async function listPreservedVia(
    client: WebTerminalClient,
    projectId: string
  ): Promise<IpcResult<unknown>> {
    return client.request('list_preserved', { projectId })
  }

  it('sends list_preserved {projectId} on the wire and the reply carries metadata + claims', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()

    const result = await listPreservedVia(client, 'project-a')
    expect(result.success).toBe(true)

    // Wire frame: authed op, payload is exactly {projectId}.
    const listReq = findSentRequest(internals.socket, 'list_preserved')
    expect(listReq?.payload).toEqual({ projectId: 'project-a' })

    client.dispose()
  })

  it('adopts the freshly issued claims in-memory so a plain attach reattaches', async () => {
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()

    // The listing reply carried fresh claims; the facade adopts them via
    // adoptClaim (mirrored here — the same call the facade makes).
    for (const entry of entries) {
      client.adoptClaim(entry.id, entry.claim)
    }
    expect(internals.trackers.get('terminal-100-1')?.claim).toBe('fresh-claim-a-64hex')
    expect(internals.trackers.get('terminal-100-1')?.disconnected).toBe(false)

    // Attach with the adopted claim + lastSeq=0 (full retained-window
    // scrollback replay) — the verified reattach round trip.
    const attach = await client.attach('terminal-100-1', 'fresh-claim-a-64hex')
    expect(attach.success).toBe(true)
    const attachReq = findSentRequest(internals.socket, 'attach')
    expect(attachReq?.payload).toEqual({
      terminalId: 'terminal-100-1',
      claim: 'fresh-claim-a-64hex',
      lastSeq: 0
    })

    client.dispose()
  })

  it('fails closed with the generic refusal shape when the gate refuses the listing', async () => {
    listPreservedReply = 'refuse'
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()

    const result = await listPreservedVia(client, 'project-a')
    expect(result.success).toBe(false)
    if (!result.success) {
      // Single generic collapse — no terminal count, no ids, no claims.
      expect(result.code).toBe('UNAUTHORIZED')
      expect(result.error).toBe('Unauthorized')
    }
    expect(internals.trackers.size).toBe(0)

    client.dispose()
  })

  it('does not retry list_preserved when it fails — the caller falls back to spawn', async () => {
    listPreservedReply = 'refuse'
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()

    await listPreservedVia(client, 'project-a')
    await listPreservedVia(client, 'project-a')

    // Exactly the two caller-driven listings, no internal retry loop.
    const listFrames = internals.socket.sent.filter(
      (frame) => (JSON.parse(frame) as { type: string }).type === 'list_preserved'
    )
    expect(listFrames).toHaveLength(2)

    client.dispose()
  })
})

// ---------------------------------------------------------------------------
// #850: session-loss events — after a server restart the channel reconnects
// and re-authenticates, but the stale claim is refused (generic
// UNAUTHORIZED) on re-attach. The client must SURFACE the loss (never
// silently swallow input): the tracker's claim is dropped and the
// session-lost listeners fire with the server-restarted reason.
// ---------------------------------------------------------------------------

describe('WebTerminalClient session loss (server restart)', () => {
  afterEach(() => {
    attachReply = 'ok'
    vi.useRealTimers()
  })

  it('fires session-lost (server-restarted) when the re-attach after reconnect is refused', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals

    const losses: Array<{ terminalId: string; reason: string }> = []
    const off = client.onSessionLost((terminalId, reason) => {
      losses.push({ terminalId, reason })
    })

    await client.connect()
    await client.attach('t1', 'claim-t1')
    expect(internals.trackers.get('t1')?.claim).toBe('claim-t1')

    // Server "restart": the socket dies, the reconnect succeeds, but the
    // re-attach with the stale claim is now UNAUTHORIZED.
    attachReply = 'unauthorized'
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()
    // Flush the re-attach round trip.
    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()
    await Promise.resolve()

    expect(internals.socket).not.toBeNull()
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    // The stale claim was dropped and the tracker is disconnected.
    expect(internals.trackers.get('t1')?.claim).toBeUndefined()
    expect(internals.trackers.get('t1')?.disconnected).toBe(true)
    // #850: the loss surfaced with the server-restart reason.
    expect(losses).toContainEqual({ terminalId: 't1', reason: 'server-restarted' })

    off()
    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('does not fire session-lost when the re-attach succeeds (normal reconnect)', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals

    const losses: string[] = []
    const off = client.onSessionLost((terminalId) => losses.push(terminalId))

    await client.connect()
    await client.attach('t1', 'claim-t1')

    // Plain disconnect + reconnect: the claim still verifies.
    internals.socket.close()
    await vi.advanceTimersByTimeAsync(600)
    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()

    expect(losses).toHaveLength(0)
    expect(internals.trackers.get('t1')?.claim).toBe('claim-t1')

    off()
    if (internals.reconnectTimer) {
      clearTimeout(internals.reconnectTimer)
      internals.reconnectTimer = null
    }
    client.dispose()
  })

  it('fires session-lost (claim-rejected) on a direct attach rejection', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const losses: Array<{ terminalId: string; reason: string }> = []
    const off = client.onSessionLost((terminalId, reason) => {
      losses.push({ terminalId, reason })
    })

    await client.connect()
    attachReply = 'unauthorized'
    const result = await client.attach('t2', 'claim-t2')
    expect(result.code).toBe('UNAUTHORIZED')
    // The direct rejection surfaces too — never silently swallowed.
    expect(losses).toContainEqual({ terminalId: 't2', reason: 'claim-rejected' })

    off()
    client.dispose()
  })
})

describe('ledgered terminal commands (AD-5)', () => {
  /**
   * Terminal carrier of the command ledger (AD-5): every spawn / kill / rotate /
   * revoke frame carries a client-minted `commandId`, a lost spawn reply is
   * resent under the SAME id and the replay's FRESH claim is the one attached
   * with, and a rotate whose reply was lost recovers via `list_preserved`.
   */

  interface ScriptedFrame {
    id: string
    type: string
    payload: Record<string, unknown>
    commandId?: string
  }

  class ScriptedWS {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSING = 2
    static CLOSED = 3
    static instances: ScriptedWS[] = []
    /** Per request type, the next replies (consumed in order); falls back to success. */
    static replies = new Map<string, unknown[]>()

    readyState = ScriptedWS.CONNECTING
    onopen: ((ev: Event) => void) | null = null
    onmessage: ((ev: MessageEvent) => void) | null = null
    onerror: ((ev: Event) => void) | null = null
    onclose: ((ev: CloseEvent) => void) | null = null
    frames: ScriptedFrame[] = []

    constructor(public url: string) {
      ScriptedWS.instances.push(this)
      queueMicrotask(() => {
        this.readyState = ScriptedWS.OPEN
        this.onopen?.(new Event('open'))
      })
    }

    send(data: string): void {
      const frame = JSON.parse(data) as ScriptedFrame
      this.frames.push(frame)
      const scripted = ScriptedWS.replies.get(frame.type)?.shift()
      const reply: unknown =
        scripted !== undefined
          ? scripted
          : frame.type === 'attach'
            ? { success: true, data: mockAttachResult({ id: String(frame.payload.terminalId) }) }
            : { success: true, data: undefined }
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({ id: frame.id, ...(reply as object) })
          })
        )
      )
    }

    close(): void {
      this.readyState = ScriptedWS.CLOSED
      this.onclose?.(new CloseEvent('close'))
    }
  }

  const framesOf = (type: string): ScriptedFrame[] =>
    ScriptedWS.instances.flatMap((socket) => socket.frames).filter((frame) => frame.type === type)

  const SPAWNED = mockSpawnedTerminal({ id: 'pty-1', cwd: '/w', pid: 7, claim: 'first-claim' })

  async function loadApi() {
    const { createWebTerminalApi } = await import('./web-terminal-api')
    return createWebTerminalApi()
  }

  describe('web terminal commands carry a commandId', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.stubGlobal('WebSocket', ScriptedWS)
      ScriptedWS.instances = []
      ScriptedWS.replies = new Map()
      window.localStorage.clear()
      const journal = await import('./command-journal')
      journal.__clearCommandJournalForTesting()
      const engine = await import('./command-engine')
      engine.__resetCommandEngineForTesting()
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    })

    it('spawn, rotate, revoke and kill each send a well-formed commandId; a direct write sends one per chunk', async () => {
      ScriptedWS.replies.set('rotate_claim', [{ success: true, data: { claim: 'rotated' } }])
      ScriptedWS.replies.set('spawn', [{ success: true, data: SPAWNED }])
      const api = await loadApi()

      const spawned = await api.spawn({ projectId: 'p1', cwd: '/w' })
      expect(spawned.success).toBe(true)
      await api.write('pty-1', 'a')
      await api.write('pty-1', 'b')
      await api.rotateClaim('pty-1', 'first-claim')
      await api.revokeClaim('pty-1', 'rotated')
      await api.kill('pty-1')

      const writes = framesOf('write')
      const ids = [
        framesOf('spawn')[0],
        framesOf('rotate_claim')[0],
        writes[0],
        writes[1],
        framesOf('revoke_claim')[0],
        framesOf('kill')[0]
      ].map((frame) => frame?.commandId)
      for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('a spawn answered "in progress" is resent with the SAME id and attaches with the replay\'s fresh claim', async () => {
      vi.useFakeTimers()
      ScriptedWS.replies.set('spawn', [
        { success: true, data: { receipt: 'in_progress' } },
        { success: true, data: { ...SPAWNED, claim: 'fresh-claim' } }
      ])
      const api = await loadApi()

      const pending = api.spawn({ projectId: 'p1', cwd: '/w' })
      await vi.advanceTimersByTimeAsync(1_000)
      const spawned = await pending

      expect(spawned).toMatchObject({ success: true, data: { id: 'pty-1', claim: 'fresh-claim' } })
      const spawns = framesOf('spawn')
      expect(spawns).toHaveLength(2)
      expect(spawns[1].commandId).toBe(spawns[0].commandId)
      expect(framesOf('attach')[0].payload).toMatchObject({
        terminalId: 'pty-1',
        claim: 'fresh-claim'
      })
    })

    it('a NEW spawn after an uncertain one is a new intent: it gets a different id (never the old PTY)', async () => {
      vi.useFakeTimers()
      ScriptedWS.replies.set(
        'spawn',
        Array.from({ length: 4 }, () => ({ success: true, data: { receipt: 'in_progress' } }))
      )
      const api = await loadApi()

      const first = api.spawn({ projectId: 'p1', cwd: '/w' })
      for (const delay of [1_000, 2_000, 4_000]) await vi.advanceTimersByTimeAsync(delay)
      await expect(first).resolves.toMatchObject({ success: false, code: 'COMMAND_IN_PROGRESS' })
      ScriptedWS.replies.set('spawn', [{ success: true, data: SPAWNED }])
      await api.spawn({ projectId: 'p1', cwd: '/w' })

      const ids = framesOf('spawn').map((frame) => frame.commandId)
      expect(new Set(ids.slice(0, 4)).size).toBe(1)
      expect(ids[4]).not.toBe(ids[0])
    })

    it('a spawn rejected with a definite code mints a NEW id on the next try', async () => {
      ScriptedWS.replies.set('spawn', [
        { success: false, error: 'no shell', code: 'SPAWN_FAILED' },
        { success: false, error: 'no shell', code: 'SPAWN_FAILED' }
      ])
      const api = await loadApi()

      await api.spawn({ projectId: 'p1', cwd: '/w' })
      await api.spawn({ projectId: 'p1', cwd: '/w' })

      const [first, second] = framesOf('spawn')
      expect(second.commandId).not.toBe(first.commandId)
    })

    it('a rotate whose reply was lost (OUTCOME_UNKNOWN) recovers the fresh claim through list_preserved', async () => {
      ScriptedWS.replies.set('spawn', [{ success: true, data: SPAWNED }])
      ScriptedWS.replies.set('rotate_claim', [
        { success: false, error: 'not retained', code: 'OUTCOME_UNKNOWN' }
      ])
      ScriptedWS.replies.set('list_preserved', [
        {
          success: true,
          data: { projectId: 'p1', terminals: [{ id: 'pty-1', claim: 'recovered-claim' }] }
        }
      ])
      const api = await loadApi()
      await api.spawn({ projectId: 'p1', cwd: '/w' })

      const rotated = await api.rotateClaim('pty-1', 'first-claim')

      expect(rotated).toEqual({ success: true, data: { claim: 'recovered-claim' } })
      expect(framesOf('list_preserved')[0].payload).toEqual({ projectId: 'p1' })
      // A resend is not made: the host would only answer OUTCOME_UNKNOWN again.
      expect(framesOf('rotate_claim')).toHaveLength(1)
    })
  })
})
