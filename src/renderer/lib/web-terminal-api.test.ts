import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWebTerminalApi,
  listPreservedAndAdoptClaims,
  resolveTerminalWsUrl,
  WebTerminalClient
} from './web-terminal-api'

const mockLogFrontendError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLogFrontendError }))

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
      // CAP-1 interim gate (Story 1): the connection-level handshake. 'ok' —
      // gate accepts (or ungated no-op); 'refuse' — the generic UNAUTHORIZED
      // refusal; 'legacy' — a pre-gate server without the arm answers
      // NOT_IMPLEMENTED and the client must proceed.
      if (authenticateMode === 'refuse') {
        this.emitReply({ id: req.id, success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
        return
      }
      if (authenticateMode === 'legacy') {
        this.emitReply({
          id: req.id,
          success: false,
          error: 'unknown terminal request',
          code: 'NOT_IMPLEMENTED'
        })
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
        data: {
          id: req.payload.terminalId,
          shell: 'bash',
          cwd: '/tmp',
          pid: 1,
          cols: 80,
          rows: 24,
          latestSeq: (req.payload.lastSeq as number) ?? 0,
          gap: false,
          snapshot: { cwd: null, gitBranch: null, gitStatus: null, exitCode: null, exited: false }
        }
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

/** Test knob: the spawn reply data (CAP-3 issuance carries the claim). */
let spawnReplyData: Record<string, unknown> = {
  id: 'pty-spawn-1',
  shell: 'bash',
  cwd: '/tmp',
  pid: 42,
  cols: 80,
  rows: 24,
  claim: 'issued-claim-64-hex'
}

/** Test knob: credential returned by rotate_claim replies. */
let rotateReplyClaim = 'rotated-claim-64-hex'
/** Test knob (CAP-1): how the fake answers the connection `authenticate`
 * handshake — 'ok' accepts, 'refuse' answers UNAUTHORIZED, 'legacy' answers
 * NOT_IMPLEMENTED (pre-gate server without the arm). */
let authenticateMode: 'ok' | 'refuse' | 'legacy' = 'ok'
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

describe('WebTerminalClient visibility-triggered reconnect (AFK recovery)', () => {
  afterEach(() => {
    restoreVisibility()
    attachReply = 'ok'
    spawnReplyData = {
      id: 'pty-spawn-1',
      shell: 'bash',
      cwd: '/tmp',
      pid: 42,
      cols: 80,
      rows: 24,
      claim: 'issued-claim-64-hex'
    }
    rotateReplyClaim = 'rotated-claim-64-hex'
    vi.useRealTimers()
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
    expect(attachReq?.payload).toEqual({ terminalId: 't1', claim: 'claim-t1', lastSeq: 7 })

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

  it('resets reconnectAttempt on visibility recovery so AFK never strands the terminal', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1', 'claim-t1')
    const oldSocket = internals.socket

    // Simulate prior suspensions having exhausted the backoff ceiling. At MAX,
    // a normal `scheduleReconnect` (e.g. from `onclose`) would no-op.
    internals.reconnectAttempt = 10 // RECONNECT_MAX_ATTEMPTS
    internals.reconnectTimer = null

    // Long hide → return → visibility recovery path.
    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    await Promise.resolve()

    // forceReconnect reset the counter (MAX → 0) and scheduleReconnect then
    // scheduled a fresh reconnect (0 → 1) — at MAX this would have been a no-op.
    expect(internals.reconnectAttempt).toBe(1)
    expect(internals.reconnectTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(600)
    await Promise.resolve()

    // A fresh socket re-opened despite the prior exhaustion.
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
      expect(findSentRequest(sock, 'attach')?.payload).toEqual({
        terminalId: 't1',
        claim: 'handoff-claim',
        lastSeq: 87
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
        lastSeq: 90
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
      snapshot: {
        cwd: '/home/pawbytes/termul',
        gitBranch: 'chore/prettify-server-help',
        gitStatus: { modified: 0, staged: 0, untracked: 0, ahead: 0, behind: 0, hasChanges: false },
        exitCode: null,
        exited: false
      }
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
      snapshot: { cwd: null, gitBranch: null, gitStatus: null, exitCode: 0, exited: true }
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
      snapshot: { cwd: null, gitBranch: null, gitStatus: null, exitCode: null, exited: false }
    })

    expect(branchCb).toHaveBeenCalledWith('t3', null)

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
    expect(authReq?.payload).toEqual({ token: 's3cret-token' })
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

  it('clears the reconnect budget only after authenticate completes, never on socket open', async () => {
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

    // The gate accepts again: a fully authenticated reconnect clears the
    // budget back to 0.
    authenticateMode = 'ok'
    await vi.advanceTimersByTimeAsync(1100)
    expect(internals.socket).not.toBeNull()
    expect(internals.socket.readyState).toBe(FakeWebSocket.OPEN)
    expect(internals.reconnectAttempt).toBe(0)
    expect(internals.reconnectTimer).toBeNull()

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

  it('proceeds without auth when a pre-gate server answers NOT_IMPLEMENTED', async () => {
    window.localStorage.setItem('termul.webAuthToken', 'any')
    authenticateMode = 'legacy'
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
    client.dispose()
  })

  it('never sends authenticate when no token is known (legacy ungated path)', async () => {
    const { client, internals } = newClient()
    const spawn = await client.request('spawn', { projectId: 'p1', cwd: '/tmp' })
    expect(spawn.success).toBe(true)
    expect(findSentRequest(internals.socket, 'authenticate')).toBeUndefined()
    client.dispose()
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
    {
      id: 'terminal-100-1',
      shell: '/bin/bash',
      cwd: '/projects/a',
      pid: 11,
      cols: 80,
      rows: 24,
      claim: 'fresh-claim-a-64hex'
    },
    {
      id: 'terminal-100-2',
      shell: '/bin/bash',
      cwd: '/projects/a',
      pid: 12,
      cols: 80,
      rows: 24,
      claim: 'fresh-claim-b-64hex'
    }
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
