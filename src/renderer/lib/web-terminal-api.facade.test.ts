import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockAttachResult, mockSpawnedTerminal } from '@/lib/test-utils/terminal'

/**
 * Story 10 (F9/F10) — facade-level guard: `createWebTerminalApi().write` must
 * route through `WebTerminalClient.write` (the buffering path), NOT bare
 * `client.request('write')`. The observable difference: for a live claim-held
 * terminal with a down socket, the buffering path returns success WITHOUT
 * opening a new socket or sending a frame; bare request() would `await
 * connect()` — constructing a NEW FakeWS instance (the assertion signal).
 */

class FakeWS {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWS[] = []

  readyState = FakeWS.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  sent: string[] = []
  /** When set, `spawn` requests answer with this failure instead of success. */
  static spawnRefusal: { error: string; code: string } | null = null

  constructor(public url: string) {
    FakeWS.instances.push(this)
    queueMicrotask(() => {
      this.readyState = FakeWS.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  send(data: string): void {
    this.sent.push(data)
    const req = JSON.parse(data) as { id: string; type: string; payload: Record<string, unknown> }
    if (req.type === 'spawn' && FakeWS.spawnRefusal) {
      this.reply({ id: req.id, success: false, ...FakeWS.spawnRefusal })
      return
    }
    if (req.type === 'spawn') {
      this.reply({
        id: req.id,
        success: true,
        data: mockSpawnedTerminal({
          id: 'pty-facade-1',
          cwd: '/tmp',
          pid: 7,
          claim: 'facade-claim'
        })
      })
      return
    }
    if (req.type === 'attach') {
      this.reply({
        id: req.id,
        success: true,
        data: mockAttachResult({ id: req.payload.terminalId as string, cwd: '/tmp', pid: 7 })
      })
      return
    }
    this.reply({ id: req.id, success: true, data: undefined })
  }

  close(): void {
    this.readyState = FakeWS.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  private reply(obj: unknown): void {
    queueMicrotask(() =>
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) }))
    )
  }
}

afterEach(() => {
  FakeWS.spawnRefusal = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('createWebTerminalApi write delegation (Story 10)', () => {
  it('buffers offline writes instead of opening a fresh socket (no bare request passthrough)', async () => {
    vi.stubGlobal('WebSocket', FakeWS)
    FakeWS.instances = []
    // Fresh module graph → the singleton client binds the stubbed WebSocket.
    const { createWebTerminalApi } = await import('./web-terminal-api')
    const api = createWebTerminalApi()

    const spawn = await api.spawn({ cols: 80, rows: 24 })
    expect(spawn.success).toBe(true)
    const ptyId = spawn.success ? spawn.data.id : ''
    expect(FakeWS.instances).toHaveLength(1)

    // Channel drops. A facade write for the live claim-held terminal must be
    // accepted into the buffer — without a new socket (connect) and without a
    // write frame on any socket.
    FakeWS.instances[0].close()
    const result = await api.write(ptyId, 'echo hi\r')

    expect(result.success).toBe(true)
    expect(FakeWS.instances).toHaveLength(1)
    const writeFrames = FakeWS.instances[0].sent.filter(
      (frame) => (JSON.parse(frame) as { type: string }).type === 'write'
    )
    expect(writeFrames).toHaveLength(0)
  })
})

describe('createWebTerminalApi spawn refused by a host terminal cap', () => {
  it('surfaces the TERMINAL_LIMIT code and message verbatim and attaches nothing', async () => {
    // A fresh client: the one an earlier test spawned through would re-attach
    // its own terminal on this socket.
    vi.resetModules()
    vi.stubGlobal('WebSocket', FakeWS)
    FakeWS.instances = []
    FakeWS.spawnRefusal = {
      error: 'Terminal limit reached (10 per project, 30 total): this project is at its limit',
      code: 'TERMINAL_LIMIT'
    }
    const { createWebTerminalApi } = await import('./web-terminal-api')
    const api = createWebTerminalApi()

    const result = await api.spawn({ projectId: 'p1', cols: 80, rows: 24 })

    expect(result).toEqual({
      success: false,
      error: 'Terminal limit reached (10 per project, 30 total): this project is at its limit',
      code: 'TERMINAL_LIMIT'
    })
    const types = FakeWS.instances.flatMap((socket) =>
      socket.sent.map((frame) => (JSON.parse(frame) as { type: string }).type)
    )
    expect(types).not.toContain('attach')
    expect(types).not.toContain('kill')
  })
})
