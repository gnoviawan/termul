import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTerminalWsUrl, WebTerminalClient } from './web-terminal-api'

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

  readyState = FakeWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  send(data: string): void {
    this.sent.push(data)
    const req = JSON.parse(data) as { id: string; type: string; payload: Record<string, unknown> }
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
