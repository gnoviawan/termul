import { invoke } from '@tauri-apps/api/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebCommandEditorTransport } from './command-editor-transport'
import { CompletionScheduler } from './command-lifecycle/completion'
import { createTauriTerminalApi } from './tauri-terminal-api'
import { WebTerminalClient } from './web-terminal-api'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: vi.fn()
}))

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: string[] = []

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN
      this.onopen?.(new Event('open'))
    })
  }

  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as { id: string; type: string }
    if (frame.type === 'authenticate') this.reply(frame.id, null)
  }

  reply(id: string, data: unknown): void {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify({ id, success: true, data }) })
    )
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
}

const clients: WebTerminalClient[] = []
afterEach(() => {
  for (const client of clients) client.dispose()
  clients.length = 0
  FakeWebSocket.instances.length = 0
  vi.useRealTimers()
})

function setup() {
  const client = new WebTerminalClient(
    'ws://localhost/terminal/ws',
    FakeWebSocket as unknown as typeof WebSocket
  )
  clients.push(client)
  const internals = client as unknown as {
    inputBuffers: Map<string, string>
    unconfirmedChunks: Map<string, { commandId: string; data: string }>
    trackers: Map<
      string,
      {
        attachedSocket?: FakeWebSocket | null
        exited: boolean
        disconnected: boolean
        claim?: string
        lastSeq: number
        refCount: number
      }
    >
    connecting: Promise<void> | null
    pending: Map<string, unknown>
  }
  internals.inputBuffers.set('terminal-1', 'existing input')
  return { client, internals, transport: createWebCommandEditorTransport(client) }
}

/** Clear queued input so a session RPC is allowed to send. Does not require a tracker. */
function readyForSession(internals: ReturnType<typeof setup>['internals']): void {
  internals.inputBuffers.delete('terminal-1')
  internals.unconfirmedChunks.delete('terminal-1')
}

const completion = {
  requestId: 'completion-1',
  draft: 'git sta -- "東京"\\path\n',
  bufferRevision: 7,
  cursor: 7,
  promptGeneration: 3,
  cwd: '/repo'
}

it.each([
  'web',
  'tauri'
] as const)('%s completion request carries the full draft unchanged', async (surface) => {
  vi.useFakeTimers()
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const fakeInvoke = vi.mocked(invoke).mockReset().mockResolvedValue('NotStarted')
  const host = surface === 'web' ? transport : createTauriTerminalApi()
  const result = host.requestCompletion('terminal-1', completion)

  if (surface === 'web') {
    expect(socket.sent).toHaveLength(1)
    const frame = JSON.parse(socket.sent[0]) as { id: string; payload: unknown }
    expect(frame.payload).toEqual({ terminalId: 'terminal-1', ...completion })
    socket.reply(frame.id, 'NotStarted')
  } else {
    expect(fakeInvoke.mock.calls).toEqual([
      ['command_editor_request_completion', { terminalId: 'terminal-1', request: completion }]
    ])
  }
  expect(await result).toEqual({ result: 'NotStarted' })
})

it('open socket sends restorePrompt', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const before = new Map(internals.inputBuffers)

  const result = transport.restorePrompt('terminal-1')
  if (socket.sent.length > 0) {
    const frame = JSON.parse(socket.sent[0]) as { id: string }
    expect(internals.pending.has(frame.id)).toBe(true)
    socket.reply(frame.id, 'Accepted')
  }

  expect(await result).toBe('Accepted')
  expect(socket.sent).toHaveLength(1)
  expect(JSON.parse(socket.sent[0])).toEqual({
    id: expect.any(String),
    type: 'command_editor_restore_prompt',
    payload: { terminalId: 'terminal-1' }
  })
  expect(internals.pending.size).toBe(0)
  expect(internals.inputBuffers).toEqual(before)
})

it('closed socket does not queue restorePrompt', async () => {
  const { client, internals, transport } = setup()
  const before = new Map(internals.inputBuffers)

  expect(await transport.restorePrompt('terminal-1')).toBe('PreWrite')
  expect(FakeWebSocket.instances).toHaveLength(0)

  await client.connect()
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  socket.close()

  expect(await transport.restorePrompt('terminal-1')).toBe('PreWrite')
  expect(internals.inputBuffers).toEqual(before)
  expect(internals.pending.size).toBe(0)
  expect(socket.sent).toEqual([])
  expect(FakeWebSocket.instances).toHaveLength(1)
})

it('lost reply is unknown delivery', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const before = new Map(internals.inputBuffers)

  const pendingResult = transport.submitCommand('terminal-1', 'echo hello')
  expect(socket.sent).toHaveLength(1)
  expect(JSON.parse(socket.sent[0])).toEqual({
    id: expect.any(String),
    type: 'command_editor_submit',
    payload: { terminalId: 'terminal-1', draft: 'echo hello' }
  })
  socket.close()
  socket.onclose?.(new CloseEvent('close', { code: 1006 }))

  const result = await pendingResult
  expect(internals.inputBuffers).toEqual(before)
  expect(internals.pending.size).toBe(0)
  expect(result).not.toBe('Accepted')
  expect(result).toBe('Partial')
  expect(socket.sent).toHaveLength(1)
})

it('session RPC timeout resolves Partial and clears pending', async () => {
  vi.useFakeTimers()
  const { client, internals, transport } = setup()
  try {
    await client.connect()
    readyForSession(internals)
    const socket = FakeWebSocket.instances[0]
    const before = new Map(internals.inputBuffers)
    const requests = [
      { send: () => transport.submitCommand('terminal-1', 'echo hello'), result: 'Partial' },
      {
        send: () => transport.requestCompletion('terminal-1', completion),
        result: { result: 'Partial' }
      }
    ]

    for (const request of requests) {
      socket.sent.length = 0
      const result = request.send()
      expect(socket.sent).toHaveLength(1)
      expect(internals.pending.size).toBe(1)
      await vi.advanceTimersByTimeAsync(15_000)

      expect(await result).toEqual(request.result)
      expect(internals.pending.size).toBe(0)
      expect(internals.inputBuffers).toEqual(before)
      expect(socket.sent).toHaveLength(1)
      expect(FakeWebSocket.instances).toHaveLength(1)
    }
  } finally {
    client.dispose()
    vi.useRealTimers()
  }
})

it('session RPC send throw resolves PreWrite and clears pending and timer', async () => {
  vi.useFakeTimers()
  const { client, internals, transport } = setup()
  try {
    await client.connect()
    readyForSession(internals)
    const socket = FakeWebSocket.instances[0]
    socket.sent.length = 0
    const before = new Map(internals.inputBuffers)
    const send = vi.spyOn(socket, 'send').mockImplementation(() => {
      throw new Error('Socket send failed')
    })
    const requests = [
      { send: () => transport.submitCommand('terminal-1', 'echo hello'), result: 'PreWrite' },
      {
        send: () => transport.requestCompletion('terminal-1', completion),
        result: { result: 'PreWrite' }
      }
    ]

    for (const request of requests) {
      const timerCount = vi.getTimerCount()
      expect(await request.send()).toEqual(request.result)
      expect(internals.pending.size).toBe(0)
      expect(vi.getTimerCount()).toBe(timerCount)
      expect(internals.inputBuffers).toEqual(before)
      expect(socket.sent).toEqual([])
      expect(FakeWebSocket.instances).toHaveLength(1)
    }
    expect(send).toHaveBeenCalledTimes(2)
  } finally {
    client.dispose()
    vi.useRealTimers()
  }
})

it('desktop invoke sends restorePrompt', async () => {
  const fakeInvoke = vi.mocked(invoke).mockReset().mockResolvedValue('Accepted')
  const api = createTauriTerminalApi()

  expect(await api.restorePrompt('terminal-1')).toBe('Accepted')
  expect(fakeInvoke.mock.calls).toEqual([
    ['command_editor_restore_prompt', { terminalId: 'terminal-1' }]
  ])
  expect(fakeInvoke.mock.calls.some(([command]) => command === 'terminal_write')).toBe(false)
})

it('desktop invoke names match the host', async () => {
  const fakeInvoke = vi.mocked(invoke)
  fakeInvoke.mockReset()
  fakeInvoke.mockResolvedValueOnce('Accepted')
  fakeInvoke.mockResolvedValueOnce('NotStarted')
  fakeInvoke.mockResolvedValueOnce('PreWrite')
  const api = createTauriTerminalApi()

  expect(await api.submitCommand('terminal-1', 'echo hello')).toBe('Accepted')
  expect(await api.requestCompletion('terminal-1', completion)).toEqual({ result: 'NotStarted' })
  expect(await api.cancelCompletion('terminal-1', 'completion-1')).toBe('PreWrite')
  expect(fakeInvoke.mock.calls).toEqual([
    ['command_editor_submit', { terminalId: 'terminal-1', draft: 'echo hello' }],
    ['command_editor_request_completion', { terminalId: 'terminal-1', request: completion }],
    ['command_editor_cancel_completion', { terminalId: 'terminal-1', requestId: 'completion-1' }]
  ])
  expect(fakeInvoke.mock.calls.some(([command]) => command === 'terminal_write')).toBe(false)
})

it.each([
  'Accepted',
  'PreWrite',
  'Partial',
  'NotStarted'
])('desktop preserves the known result %s', async (result) => {
  vi.mocked(invoke).mockReset().mockResolvedValue(result)
  const api = createTauriTerminalApi()
  expect(await api.submitCommand('terminal-1', 'echo hello')).toBe(result)
  expect(await api.requestCompletion('terminal-1', completion)).toEqual({ result })
  expect(await api.cancelCompletion('terminal-1', 'completion-1')).toBe(result)
})

it.each([
  undefined,
  null,
  'Unknown',
  { success: true, data: 'Accepted' }
])('desktop maps an unknown result %j to Partial', async (result) => {
  vi.mocked(invoke).mockReset().mockResolvedValue(result)
  const api = createTauriTerminalApi()
  expect(await api.submitCommand('terminal-1', 'echo hello')).toBe('Partial')
  expect(await api.requestCompletion('terminal-1', completion)).toEqual({ result: 'Partial' })
  expect(await api.cancelCompletion('terminal-1', 'completion-1')).toBe('Partial')
})

it('desktop maps a thrown invoke to PreWrite without retrying', async () => {
  const fakeInvoke = vi.mocked(invoke).mockReset().mockRejectedValue(new Error('invoke rejected'))
  const api = createTauriTerminalApi()
  expect(await api.submitCommand('terminal-1', 'echo hello')).toBe('PreWrite')
  expect(await api.requestCompletion('terminal-1', completion)).toEqual({ result: 'PreWrite' })
  expect(await api.cancelCompletion('terminal-1', 'completion-1')).toBe('PreWrite')
  expect(fakeInvoke.mock.calls.map(([command]) => command)).toEqual([
    'command_editor_submit',
    'command_editor_request_completion',
    'command_editor_cancel_completion'
  ])
})

describe('closed socket does not queue submit', () => {
  it('fails before send for every session method without connecting or changing buffered input', async () => {
    const { client, internals, transport } = setup()
    const before = new Map(internals.inputBuffers)
    const assertPreWrite = async () => {
      expect(await transport.submitCommand('terminal-1', 'echo hello')).toBe('PreWrite')
      expect(await transport.requestCompletion('terminal-1', completion)).toEqual({
        result: 'PreWrite'
      })
      expect(await transport.cancelCompletion('terminal-1', 'completion-1')).toBe('PreWrite')
      expect(internals.inputBuffers).toEqual(before)
      expect(internals.pending.size).toBe(0)
    }
    await assertPreWrite()
    expect(FakeWebSocket.instances).toHaveLength(0)

    await client.connect()
    const socket = FakeWebSocket.instances[0]
    socket.sent.length = 0
    for (const state of [FakeWebSocket.CONNECTING, FakeWebSocket.CLOSING, FakeWebSocket.CLOSED]) {
      socket.readyState = state
      await assertPreWrite()
      expect(socket.sent).toEqual([])
      expect(FakeWebSocket.instances).toHaveLength(1)
    }
  })

  it('sends one fresh correlated non-ledgered frame per ready-socket session request', async () => {
    const { client, internals, transport } = setup()
    await client.connect()
    readyForSession(internals)
    const socket = FakeWebSocket.instances[0]
    socket.sent.length = 0
    const before = new Map(internals.inputBuffers)
    const requests = [
      {
        type: 'command_editor_submit',
        payload: { terminalId: 'terminal-1', draft: 'echo hello' },
        send: () => transport.submitCommand('terminal-1', 'echo hello'),
        result: 'Accepted'
      },
      {
        type: 'command_editor_request_completion',
        payload: { terminalId: 'terminal-1', ...completion },
        send: () => transport.requestCompletion('terminal-1', completion),
        result: 'NotStarted'
      },
      {
        type: 'command_editor_cancel_completion',
        payload: { terminalId: 'terminal-1', requestId: 'completion-1' },
        send: () => transport.cancelCompletion('terminal-1', 'completion-1'),
        result: 'Accepted'
      }
    ]
    const ids = new Set<string>()
    for (const [index, request] of requests.entries()) {
      const result = request.send()
      expect(socket.sent).toHaveLength(index + 1)
      const frame = JSON.parse(socket.sent[index]) as { id: string }
      expect(frame).toEqual({
        id: expect.any(String),
        type: request.type,
        payload: request.payload
      })
      expect(frame.id).not.toBe('')
      expect(ids.has(frame.id)).toBe(false)
      ids.add(frame.id)
      expect(internals.pending.has(frame.id)).toBe(true)
      socket.reply(frame.id, request.result)
      expect(await result).toEqual(
        request.type === 'command_editor_request_completion'
          ? { result: request.result }
          : request.result
      )
      expect(internals.pending.size).toBe(0)
      expect(internals.inputBuffers).toEqual(before)
    }
  })
})

it('completion reply carries the completer output', async () => {
  const fields = {
    request_id: 'r1',
    buffer_revision: 7,
    cursor: 7,
    prompt_generation: 3,
    cwd: '/repo',
    output: '737461747573'
  }
  const completed = { result: 'Accepted', outcome: 'Completed', completion: fields }
  const partial = { result: 'Partial' }
  const cases: [unknown, unknown][] = [
    ['NotStarted', { result: 'NotStarted' }],
    [completed, completed],
    [
      { ...completed, result: 'Partial' },
      { ...completed, result: 'Partial' }
    ],
    [
      { result: 'Partial', outcome: 'TimedOut' },
      { result: 'Partial', outcome: 'TimedOut' }
    ],
    [
      { ...completed, completion: { ...fields, nonce: 'ignored', session_id: 'ignored' } },
      completed
    ],
    [{ result: 'Accepted' }, { result: 'Accepted' }],
    ...['TimedOut', 'Cancelled', 'Dropped'].map((outcome): [unknown, unknown] => [
      { result: 'Accepted', outcome },
      { result: 'Accepted', outcome }
    ]),
    ...['Accepted', 'PreWrite', 'Partial'].map((result): [unknown, unknown] => [
      result,
      { result }
    ]),
    [null, partial],
    [undefined, partial],
    [42, partial],
    [[], partial],
    ['Unknown', partial],
    [{ result: 'Unknown' }, partial],
    [{ result: 'Accepted', outcome: 'Unknown' }, partial],
    [{ result: 'Accepted', outcome: null }, partial],
    [{ result: 'Accepted', outcome: 'Completed' }, partial],
    [{ ...completed, completion: null }, partial],
    [{ result: 'Accepted', completion: fields }, partial],
    ...['TimedOut', 'Cancelled', 'Dropped', 'Unknown'].map((outcome): [unknown, unknown] => [
      { ...completed, outcome },
      partial
    ]),
    [{ result: 'Accepted', completion: null }, partial],
    ...Object.keys(fields).flatMap((key): [unknown, unknown][] => {
      const missing = { ...fields } as Record<string, unknown>
      delete missing[key]
      return [
        [{ ...completed, completion: missing }, partial],
        [{ ...completed, completion: { ...fields, [key]: null } }, partial],
        [
          {
            ...completed,
            completion: {
              ...fields,
              [key]: typeof fields[key as keyof typeof fields] === 'string' ? 42 : '7'
            }
          },
          partial
        ]
      ]
    }),
    ...['buffer_revision', 'cursor', 'prompt_generation'].flatMap((key): [unknown, unknown][] =>
      [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5].map((value) => [
        { ...completed, completion: { ...fields, [key]: value } },
        partial
      ])
    )
  ]
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const before = new Map(internals.inputBuffers)
  const api = createTauriTerminalApi()
  for (const [reply, expected] of cases) {
    const pending = transport.requestCompletion('terminal-1', completion)
    const frame = JSON.parse(socket.sent[socket.sent.length - 1]) as { id: string }
    socket.reply(frame.id, reply)
    expect(await pending).toEqual(expected)
    vi.mocked(invoke).mockReset().mockResolvedValue(reply)
    expect(await api.requestCompletion('terminal-1', completion)).toEqual(expected)
    expect(internals.pending.size).toBe(0)
    expect(internals.inputBuffers).toEqual(before)
  }
})

it('completion transport failures preserve delivery meaning', async () => {
  const { client, internals, transport } = setup()
  const before = new Map(internals.inputBuffers)
  expect(await transport.requestCompletion('terminal-1', completion)).toEqual({
    result: 'PreWrite'
  })
  expect(internals.inputBuffers).toEqual(before)
  await client.connect()
  readyForSession(internals)
  const ready = new Map(internals.inputBuffers)
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const pending = transport.requestCompletion('terminal-1', completion)
  expect(socket.sent).toHaveLength(1)
  socket.close()
  socket.onclose?.(new CloseEvent('close', { code: 1006 }))
  expect(await pending).toEqual({ result: 'Partial' })
  expect(internals.pending.size).toBe(0)
  expect(internals.inputBuffers).toEqual(ready)
  const fakeInvoke = vi.mocked(invoke).mockReset().mockRejectedValue(new Error('invoke rejected'))
  expect(await createTauriTerminalApi().requestCompletion('terminal-1', completion)).toEqual({
    result: 'PreWrite'
  })
  expect(fakeInvoke).toHaveBeenCalledTimes(1)
})

it('buffered input blocks a session RPC before any frame is sent', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const before = new Map(internals.inputBuffers)

  const pending = transport.submitCommand('terminal-1', 'echo hello')
  expect(socket.sent).toEqual([])
  expect(await pending).toBe('PreWrite')
  expect(await transport.requestCompletion('terminal-1', completion)).toEqual({
    result: 'PreWrite'
  })
  expect(internals.pending.size).toBe(0)
  expect(internals.inputBuffers).toEqual(before)
})

it('an in-flight handshake blocks a session RPC on an open socket', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  internals.connecting = new Promise(() => {})
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0

  const pending = transport.restorePrompt('terminal-1')
  expect(socket.sent).toEqual([])
  expect(await pending).toBe('PreWrite')
  expect(internals.pending.size).toBe(0)
})

it('an unattached live terminal blocks a session RPC', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  internals.trackers.set('terminal-1', {
    lastSeq: 0,
    exited: false,
    refCount: 0,
    disconnected: false,
    attachedSocket: null
  })
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0

  const pending = transport.submitCommand('terminal-1', 'echo hello')
  expect(socket.sent).toEqual([])
  expect(await pending).toBe('PreWrite')
})

it('an already-sent unconfirmed chunk does not block a ready session RPC', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  internals.unconfirmedChunks.set('terminal-1', { commandId: 'chunk-1', data: 'ls' })
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0

  const pending = transport.submitCommand('terminal-1', 'echo hello')
  expect(socket.sent).toHaveLength(1)
  const frame = JSON.parse(socket.sent[0]) as { id: string }
  socket.reply(frame.id, 'Accepted')
  expect(await pending).toBe('Accepted')
})

it('does not send a session RPC while buffered input is queued for replay', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  const socket = FakeWebSocket.instances[0]
  internals.trackers.set('terminal-1', {
    lastSeq: 0,
    exited: false,
    refCount: 0,
    disconnected: false,
    claim: 'claim-1'
  })
  const connect = client.connect.bind(client)
  let connectCalls = 0
  let releaseConnect: (() => Promise<void>) | undefined
  client.connect = () => {
    connectCalls += 1
    if (connectCalls === 1) return connect()
    return new Promise<void>((resolve, reject) => {
      releaseConnect = async () => {
        try {
          await connect()
          resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
  }
  const attach = client.attach('terminal-1', 'claim-1')
  await Promise.resolve()
  const attachFrame = socket.sent
    .map((raw) => JSON.parse(raw) as { id: string; type: string })
    .find((frame) => frame.type === 'attach')
  expect(attachFrame).toBeDefined()
  socket.reply(attachFrame?.id ?? '', {})
  await Promise.resolve()
  socket.sent.length = 0

  const pending = transport.submitCommand('terminal-1', 'echo hello')
  expect(socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)).not.toContain(
    'command_editor_submit'
  )
  expect(await pending).toBe('PreWrite')
  expect(internals.inputBuffers.has('terminal-1')).toBe(false)
  await releaseConnect?.()
  await attach
})

it('does not let a keystroke overtake an unsent replay chunk', async () => {
  const { client, internals } = setup()
  await client.connect()
  const socket = FakeWebSocket.instances[0]
  internals.trackers.set('terminal-1', {
    lastSeq: 0,
    exited: false,
    refCount: 0,
    disconnected: false,
    claim: 'claim-1',
    attachedSocket: null
  })
  internals.unconfirmedChunks.set('terminal-1', { commandId: 'chunk-1', data: 'ls' })
  internals.inputBuffers.set('terminal-1', 'ls -la\r')
  const attach = client.attach('terminal-1', 'claim-1')
  await vi.waitFor(
    () => {
      const types = socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)
      expect(types, types.join(',')).toContain('attach')
    },
    { timeout: 1000, interval: 10 }
  )
  const attachFrame = socket.sent
    .map((raw) => JSON.parse(raw) as { id: string; type: string })
    .find((frame) => frame.type === 'attach')
  socket.reply(attachFrame?.id ?? '', {})
  await attach
  await vi.waitFor(() => {
    expect(socket.sent.some((raw) => (JSON.parse(raw) as { type: string }).type === 'write')).toBe(
      true
    )
  })
  const before = socket.sent.length
  const written = client.write('terminal-1', 'x')
  await Promise.resolve()
  const added = socket.sent
    .slice(before)
    .map((raw) => JSON.parse(raw) as { type: string; payload?: { data?: string } })
  expect(added.filter((frame) => frame.type === 'write')).toEqual([])
  await expect(written).resolves.toMatchObject({ success: true })

  const frames = () =>
    socket.sent.map(
      (raw) => JSON.parse(raw) as { id: string; type: string; payload?: { data?: string } }
    )
  const replied = new Set<string>()
  await vi.waitFor(() => {
    for (const frame of frames()) {
      if (frame.type !== 'write' || replied.has(frame.id)) continue
      replied.add(frame.id)
      socket.reply(frame.id, null)
    }
    expect(
      frames()
        .filter((frame) => frame.type === 'write')
        .map((frame) => frame.payload?.data)
    ).toEqual(['ls', ' -la\r', 'x'])
  })

  const held = client as unknown as { replayHolds: Map<string, number> }
  await vi.waitFor(() => {
    expect(held.replayHolds.get('terminal-1') ?? 0).toBe(0)
  })
  socket.sent.length = 0
  const pending = createWebCommandEditorTransport(client).submitCommand('terminal-1', 'echo hello')
  await Promise.resolve()
  expect(socket.sent).toHaveLength(1)
  const frame = JSON.parse(socket.sent[0]) as { id: string }
  socket.reply(frame.id, 'Accepted')
  expect(await pending).toBe('Accepted')
})

it('refuses a non-u64 completion request before send', async () => {
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const fakeInvoke = vi.mocked(invoke).mockReset()
  const pending = transport.requestCompletion('terminal-1', { ...completion, bufferRevision: -1 })
  if (socket.sent.length > 0) {
    const frame = JSON.parse(socket.sent[0]) as { id: string }
    socket.reply(frame.id, 'PreWrite')
  }
  expect(socket.sent).toEqual([])
  expect(await pending).toEqual({ result: 'PreWrite' })
  expect(
    await createTauriTerminalApi().requestCompletion('terminal-1', { ...completion, cursor: 1.5 })
  ).toEqual({ result: 'PreWrite' })
  expect(fakeInvoke).not.toHaveBeenCalled()
})

it.each([
  'web',
  'tauri'
] as const)('%s scheduler forwards the full draft unchanged', async (surface) => {
  vi.useFakeTimers()
  const { client, internals, transport } = setup()
  await client.connect()
  readyForSession(internals)
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const fakeInvoke = vi.mocked(invoke).mockReset().mockResolvedValue('NotStarted')
  const scheduler = new CompletionScheduler({
    host: surface === 'web' ? transport : createTauriTerminalApi(),
    createRequestId: () => completion.requestId,
    settings: { automaticCompletionRefresh: false }
  })

  scheduler.requestCompletion({
    ...completion,
    terminalId: 'terminal-1',
    sessionId: 'session-1',
    mode: 'Editor',
    phase: 'AtPrompt'
  })

  if (surface === 'web') {
    expect(socket.sent).toHaveLength(1)
    const frame = JSON.parse(socket.sent[0]) as { id: string; payload: unknown }
    expect(frame.payload).toEqual({ terminalId: 'terminal-1', ...completion })
    socket.reply(frame.id, 'NotStarted')
  } else {
    expect(fakeInvoke.mock.calls).toEqual([
      ['command_editor_request_completion', { terminalId: 'terminal-1', request: completion }]
    ])
  }
})
