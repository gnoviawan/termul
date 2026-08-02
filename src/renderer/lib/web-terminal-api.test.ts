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
    if (req.type === 'attach') {
      if (attachReply === 'not_found') {
        this.emitReply({
          id: req.id,
          success: false,
          error: 'terminal not found',
          code: 'TERMINAL_NOT_FOUND'
        })
        return
      }
      this.emitReply({ id: req.id, success: true, data: undefined })
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

/** Test knob: make `attach` replies fail with TERMINAL_NOT_FOUND. */
let attachReply: 'ok' | 'not_found' = 'ok'

type Tracker = { lastSeq: number; exited: boolean; refCount: number }

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
    // Track a terminal and advance its cursor past the initial 0.
    await client.attach('t1')
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
    // The new socket re-attached the tracker carrying its stored cursor.
    const attachReq = findSentRequest(internals.socket, 'attach')
    expect(attachReq).toBeDefined()
    expect(attachReq?.payload).toEqual({ terminalId: 't1', lastSeq: 7 })

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
    await client.attach('t1')
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

  it('marks a tracker exited when re-attach returns TERMINAL_NOT_FOUND', async () => {
    vi.useFakeTimers()
    const client = new WebTerminalClient(
      'ws://test/terminal/ws',
      FakeWebSocket as unknown as typeof WebSocket
    )
    const internals = client as unknown as ClientInternals
    await client.connect()
    await client.attach('t1')
    expect(internals.trackers.get('t1')?.exited).toBe(false)

    // The server tore the terminal down during AFK — the reconnect's re-attach
    // replies TERMINAL_NOT_FOUND.
    attachReply = 'not_found'

    dispatchVisibility('hidden')
    await vi.advanceTimersByTimeAsync(31_000)
    dispatchVisibility('visible')
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(600)
    // The TERMINAL_NOT_FOUND reply + the onopen re-attach `.then` mark it exited.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    expect(internals.trackers.get('t1')?.exited).toBe(true)

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
    await client.attach('t1')
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
    await client.attach('t1')
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
