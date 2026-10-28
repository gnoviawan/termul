import { readFileSync } from 'node:fs'
import type { SessionRpcResult } from '@shared/types/command-session'
import type { TerminalApi } from '@shared/types/ipc.types'
import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { listen } from '@tauri-apps/api/event'
import { cleanup, render } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWebCommandEditorTransport } from '@/lib/command-editor-transport'
import { createTauriTerminalApi } from '@/lib/tauri-terminal-api'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { WebTerminalClient } from '@/lib/web-terminal-api'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { bindSessionClient, useBindSessionClient } from './bind-session'
import { CompletionScheduler } from './completion'
import { commandDraftStore } from './draft-store'
import { sessionStore } from './session-store'

const { mockPersistenceWrite } = vi.hoisted(() => ({
  mockPersistenceWrite: vi.fn(async () => ({ success: true as const, data: undefined }))
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: { ...actual.persistenceApi, write: mockPersistenceWrite }
  }
})

type SessionTransport = Pick<
  TerminalApi,
  'submitCommand' | 'requestCompletion' | 'cancelCompletion' | 'restorePrompt'
>

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  static submitReply: SessionRpcResult = 'Accepted'
  static cancelReply: SessionRpcResult = 'Accepted'
  static holdSubmit = false
  static holdCancel = false
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
    if (frame.type === 'authenticate') {
      this.reply(frame.id, null)
    } else if (frame.type === 'command_editor_cancel_completion' && !FakeWebSocket.holdCancel) {
      this.reply(frame.id, FakeWebSocket.cancelReply)
    } else if (frame.type === 'command_editor_submit' && !FakeWebSocket.holdSubmit) {
      this.reply(frame.id, FakeWebSocket.submitReply)
    }
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

beforeEach(() => {
  openTrustedSession()
})

afterEach(() => {
  cleanup()
  sessionStore.reset()
  useTerminalStore.getState().setTerminals([])
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  useCommandHistoryStore.setState({ entries: [] })
  mockPersistenceWrite.mockClear()
  for (const client of clients) client.dispose()
  clients.length = 0
  FakeWebSocket.instances.length = 0
  FakeWebSocket.holdSubmit = false
  FakeWebSocket.holdCancel = false
  commandDraftStore.processExited('t1')
  FakeWebSocket.submitReply = 'Accepted'
  FakeWebSocket.cancelReply = 'Accepted'
})

function lifecyclePayload(
  overrides: Partial<SessionLifecyclePayload> & Pick<SessionLifecyclePayload, 'kind'>
): SessionLifecyclePayload {
  return {
    type: 'session_lifecycle',
    terminal_id: 'pty-9',
    session_id: 's1',
    nonce: 'n1',
    prompt_suppressed: false,
    line_empty: false,
    exit_code: null,
    prompt_generation: null,
    cwd: null,
    ...overrides
  }
}

async function flushAdapterLifecycle(): Promise<void> {
  await import('@/stores/terminal-store')
  await Promise.resolve()
  await Promise.resolve()
}

async function applyThroughWebAdapter(event: SessionLifecyclePayload): Promise<void> {
  const client = new WebTerminalClient('ws://localhost/terminal/ws')
  ;(client as unknown as { handleEvent(payload: SessionLifecyclePayload): void }).handleEvent(event)
  await flushAdapterLifecycle()
}

async function applyThroughTauriAdapter(event: SessionLifecyclePayload): Promise<void> {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  vi.mocked(listen).mockClear()
  const api = createTauriTerminalApi()
  const stop = api.onCwdChanged(() => {})
  try {
    const call = vi
      .mocked(listen)
      .mock.calls.find(([eventName]) => eventName === 'terminal-session-lifecycle')
    const handler = call?.[1] as ((event: { payload: SessionLifecyclePayload }) => void) | undefined
    expect(handler).toBeTypeOf('function')
    handler?.({ payload: event })
    await flushAdapterLifecycle()
  } finally {
    stop()
  }
}

async function createConnectedWebTransport() {
  const client = new WebTerminalClient(
    'ws://localhost/terminal/ws',
    FakeWebSocket as unknown as typeof WebSocket
  )
  clients.push(client)
  await client.connect()
  const socket = FakeWebSocket.instances[0]
  socket.sent.length = 0
  const transport = createWebCommandEditorTransport(client)
  return { client, socket, transport }
}

function createOrderRecordingHost(transport: SessionTransport) {
  const order: string[] = []
  const host: SessionTransport = {
    requestCompletion(terminalId, request) {
      order.push('requestCompletion')
      return transport.requestCompletion(terminalId, request)
    },
    cancelCompletion(terminalId, requestId) {
      order.push('cancelCompletion')
      return transport.cancelCompletion(terminalId, requestId)
    },
    submitCommand(terminalId, draft) {
      order.push('submitCommand')
      return transport.submitCommand(terminalId, draft)
    },
    restorePrompt(terminalId) {
      order.push('restorePrompt')
      return transport.restorePrompt(terminalId)
    }
  }
  return { host, order }
}

it('Enter is one ordered submit', async () => {
  const { socket, transport } = await createConnectedWebTransport()
  const { host, order } = createOrderRecordingHost(transport)
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'req-1',
    settings: { automaticCompletionRefresh: false }
  })

  scheduler.requestCompletion({
    terminalId: 'pty-9',
    sessionId: 's1',
    mode: 'Editor',
    phase: 'AtPrompt',
    draft: 'git sta',
    bufferRevision: 1,
    cursor: 7,
    promptGeneration: 1,
    cwd: '/repo'
  })

  expect(order).toEqual(['requestCompletion'])
  socket.sent.length = 0
  order.length = 0

  const binder = bindSessionClient({
    host,
    scheduler,
    terminalId: 't1',
    ptyId: () => 'pty-9'
  })

  await binder.submit('git sta')

  expect(order).toEqual(['cancelCompletion', 'submitCommand'])
  const frames = socket.sent.map(
    (raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> }
  )
  expect(frames.map((frame) => frame.type)).toEqual([
    'command_editor_cancel_completion',
    'command_editor_submit'
  ])
  expect(frames[0]?.payload).toEqual({ terminalId: 'pty-9', requestId: 'req-1' })
  expect(frames[1]?.payload).toEqual({ terminalId: 'pty-9', draft: 'git sta' })
  expect(frames.some((frame) => frame.type === 'write')).toBe(false)
})

it('a partial result stays down across the binder', async () => {
  FakeWebSocket.submitReply = 'Partial'
  const { transport } = await createConnectedWebTransport()
  const history: Array<[string, string, string, string]> = []
  const binder = bindSessionClient({
    host: transport,
    terminalId: 't1',
    ptyId: () => 'pty-9',
    terminalName: 'local',
    projectId: 'p1',
    addCommand: async (command, terminalName, terminalId, projectId) => {
      history.push([command, terminalName, terminalId, projectId])
    }
  })

  await binder.submit('git sta')

  expect(history).toEqual([])
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
  expect(sessionStore.read('t1').committedSubmit).toBe(false)
})

it('an accepted submit records the committed flag', async () => {
  FakeWebSocket.submitReply = 'Accepted'
  const id = 't1'
  expect(sessionStore.read(id).committedSubmit).toBe(false)

  const { transport } = await createConnectedWebTransport()
  const binder = bindSessionClient({
    host: transport,
    terminalId: id,
    ptyId: () => 'pty-9'
  })

  await binder.submit('git status')

  expect(sessionStore.read(id).committedSubmit).toBe(true)
})

it('one enter records one history entry', async () => {
  FakeWebSocket.submitReply = 'Accepted'
  const { transport } = await createConnectedWebTransport()
  let submit: ((draft: string) => Promise<unknown>) | undefined
  function Probe() {
    const binder = useBindSessionClient({
      host: transport,
      terminalId: 't1',
      ptyId: () => 'pty-9',
      terminalName: 'local',
      projectId: 'p1'
    })
    useEffect(() => {
      submit = binder.submit
    }, [binder.submit])
    return null
  }
  render(createElement(Probe))
  await submit!('git sta')
  const entries = useCommandHistoryStore
    .getState()
    .entries.filter(
      (entry) =>
        entry.command === 'git sta' &&
        entry.terminalName === 'local' &&
        entry.terminalId === 't1' &&
        entry.projectId === 'p1'
    )
  expect(entries).toHaveLength(1)
})

it('accepted enter does not paint the command', async () => {
  FakeWebSocket.submitReply = 'Accepted'
  const { transport } = await createConnectedWebTransport()
  const writes: string[] = []
  const term = {
    write(data: string) {
      writes.push(data)
    }
  }
  const binder = bindSessionClient({
    host: transport,
    terminalId: 't1',
    ptyId: () => 'pty-9',
    term
  })
  await binder.submit('git remote -v')
  expect(writes.filter((data) => data.includes('git remote -v'))).toHaveLength(0)
})

it('completion uses the session binder', () => {
  const source = readFileSync('src/renderer/lib/command-lifecycle/bind-session.ts', 'utf8')
  expect(source).toMatch(/requestCompletion/)
  expect(source).toMatch(/CompletionScheduler/)
  expect(source).not.toMatch(/terminalApi\.write/)
})

it('a settled edit requests completion on the socket', async () => {
  const { client, socket, transport } = await createConnectedWebTransport()
  const timers: Array<{ handler: () => void; id: number }> = []
  let nextTimer = 1
  const clock = {
    setTimeout(handler: () => void, _ms: number) {
      const id = nextTimer++
      timers.push({ handler, id })
      return id
    },
    clearTimeout(id: unknown) {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index >= 0) timers.splice(index, 1)
    }
  }
  const binder = bindSessionClient({
    host: {
      ...transport,
      write: (terminalId, data) => client.write(terminalId, data)
    },
    terminalId: 't1',
    ptyId: () => 'pty-9',
    clock,
    createRequestId: () => 'req-1'
  })
  binder.updateContext({
    terminalId: 't1',
    sessionId: 's1',
    mode: 'Editor',
    phase: 'AtPrompt',
    draft: 'git sta',
    bufferRevision: 1,
    cursor: 7,
    promptGeneration: 1,
    cwd: '/repo'
  })
  for (const timer of [...timers]) timer.handler()
  await Promise.resolve()
  await Promise.resolve()
  const frames = socket.sent.map((raw) => JSON.parse(raw) as { type: string })
  expect(frames.filter((frame) => frame.type === 'command_editor_request_completion')).toHaveLength(
    1
  )
  expect(frames.some((frame) => frame.type === 'write')).toBe(false)
})

it('enter does not leave a completion frame', async () => {
  const { socket, transport } = await createConnectedWebTransport()
  const binder = bindSessionClient({
    host: transport,
    terminalId: 't1',
    ptyId: () => 'pty-9',
    createRequestId: () => 'req-1'
  })
  binder.requestCompletion({
    terminalId: 'pty-9',
    sessionId: 's1',
    mode: 'Editor',
    phase: 'AtPrompt',
    draft: 'git sta',
    bufferRevision: 1,
    cursor: 7,
    promptGeneration: 1,
    cwd: '/repo'
  })
  socket.sent.length = 0
  await binder.submit('git sta')
  const types = socket.sent.map((raw) => (JSON.parse(raw) as { type: string }).type)
  expect(types).toEqual(['command_editor_cancel_completion', 'command_editor_submit'])
})

it('two settled edits use different request ids', async () => {
  const { socket, transport } = await createConnectedWebTransport()
  vi.useFakeTimers()
  try {
    const binder = bindSessionClient({ host: transport, terminalId: 't1', ptyId: () => 'pty-9' })
    const context = {
      terminalId: 't1',
      sessionId: 's1',
      mode: 'Editor' as const,
      phase: 'AtPrompt' as const,
      draft: 'git sta',
      bufferRevision: 1,
      cursor: 7,
      promptGeneration: 1,
      cwd: '/repo'
    }
    binder.updateContext(context)
    await vi.advanceTimersByTimeAsync(100)
    const first = JSON.parse(socket.sent[0])
    socket.reply(first.id, { result: 'Accepted', outcome: 'TimedOut' })
    await Promise.resolve()
    binder.updateContext({ ...context, draft: 'git stat', cursor: 8, bufferRevision: 2 })
    await vi.advanceTimersByTimeAsync(100)
    const second = JSON.parse(socket.sent[1])
    expect(second.payload.requestId).not.toBe(first.payload.requestId)
  } finally {
    vi.useRealTimers()
  }
})

it('rerender preserves binder and scheduler with current history metadata', async () => {
  const { transport } = await createConnectedWebTransport()
  let current!: ReturnType<typeof useBindSessionClient>
  function Probe({ name }: { name: string }) {
    current = useBindSessionClient({
      host: transport,
      terminalId: 't1',
      ptyId: () => 'pty-9',
      terminalName: name,
      projectId: 'p1'
    })
    return null
  }
  const view = render(createElement(Probe, { name: 'old' }))
  const first = current
  first.requestCompletion({
    terminalId: 't1',
    sessionId: 's1',
    mode: 'Editor',
    phase: 'AtPrompt',
    draft: 'git sta',
    bufferRevision: 1,
    cursor: 7,
    promptGeneration: 1,
    cwd: '/repo'
  })
  const requestId = first.scheduler.inFlightRequestId
  view.rerender(createElement(Probe, { name: 'new' }))
  expect(current).toBe(first)
  expect(current.scheduler).toBe(first.scheduler)
  expect(current.scheduler.inFlightRequestId).toBe(requestId)
  await current.submit('git status')
  expect(useCommandHistoryStore.getState().entries).toEqual([
    expect.objectContaining({ command: 'git status', terminalName: 'new' })
  ])
})

it('binder refresh off waits for Tab', async () => {
  const { socket, transport } = await createConnectedWebTransport()
  vi.useFakeTimers()
  useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', false)
  try {
    const binder = bindSessionClient({ host: transport, terminalId: 't1', ptyId: () => 'pty-9' })
    const context = {
      terminalId: 't1',
      sessionId: 's1',
      mode: 'Editor' as const,
      phase: 'AtPrompt' as const,
      draft: 'git sta',
      bufferRevision: 1,
      cursor: 7,
      promptGeneration: 1,
      cwd: '/repo'
    }
    binder.updateContext(context)
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.sent).toHaveLength(0)
    binder.requestCompletion(context)
    expect(socket.sent).toHaveLength(1)
  } finally {
    useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', true)
    vi.useRealTimers()
  }
})

it('completion carries the prompt context', async () => {
  useTerminalStore
    .getState()
    .setTerminals([mockTerminal({ id: 't1', ptyId: 'pty-9', cwd: '/stale' })])
  const { socket, transport } = await createConnectedWebTransport()

  for (const applyAdapter of [applyThroughWebAdapter, applyThroughTauriAdapter]) {
    sessionStore.reset()
    socket.sent.length = 0
    await applyAdapter(lifecyclePayload({ kind: 'InitShell' }))
    await applyAdapter(
      lifecyclePayload({
        kind: 'PromptReady',
        prompt_generation: 3,
        line_empty: true,
        prompt_suppressed: true,
        cwd: '/repo'
      })
    )

    const timers: Array<{ handler: () => void; id: number }> = []
    let nextTimer = 1
    const clock = {
      setTimeout(handler: () => void, _ms: number) {
        const id = nextTimer++
        timers.push({ handler, id })
        return id
      },
      clearTimeout(id: unknown) {
        const index = timers.findIndex((timer) => timer.id === id)
        if (index >= 0) timers.splice(index, 1)
      }
    }
    const binder = bindSessionClient({
      host: transport,
      terminalId: 't1',
      ptyId: () => 'pty-9',
      clock,
      createRequestId: () => 'req-1'
    })
    binder.updateContext({
      terminalId: 't1',
      sessionId: 's1',
      mode: 'Editor',
      phase: 'AtPrompt',
      draft: 'git sta',
      bufferRevision: 1,
      cursor: 7,
      promptGeneration: 1
    })
    for (const timer of [...timers]) timer.handler()
    await Promise.resolve()
    await Promise.resolve()

    const frames = socket.sent.map(
      (raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> }
    )
    const request = frames.find((frame) => frame.type === 'command_editor_request_completion')
    expect(request?.payload).toEqual({
      terminalId: 'pty-9',
      requestId: 'req-1',
      draft: 'git sta',
      bufferRevision: 1,
      cursor: 7,
      promptGeneration: 3,
      cwd: '/repo'
    })
  }
})

function openTrustedSession(sessionId = 's1', nonce = 'n1') {
  sessionStore.apply('t1', { type: 'InitShell', session_id: sessionId, nonce })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: sessionId,
    nonce,
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
}

async function pendingSubmit(addCommand?: () => Promise<void>) {
  openTrustedSession()
  commandDraftStore.offer('t1', 'Editor', 'git status')
  FakeWebSocket.holdSubmit = true
  const { socket, transport } = await createConnectedWebTransport()
  const binder = bindSessionClient({
    host: transport,
    terminalId: 't1',
    ptyId: () => 'pty-9',
    terminalName: 'local',
    projectId: 'p1',
    addCommand
  })
  const pending = binder.submit('git status')
  const reply = async (result: SessionRpcResult) => {
    await Promise.resolve()
    await Promise.resolve()
    const frame = socket.sent
      .map((raw) => JSON.parse(raw) as { id: string; type: string })
      .find((frame) => frame.type === 'command_editor_submit')
    expect(frame).toBeDefined()
    socket.reply(frame!.id, result)
  }
  for (let i = 0; i < 12; i++) await Promise.resolve()
  return { socket, binder, pending, reply }
}

it('enter unmounts the editor before the reply', async () => {
  const { pending, reply } = await pendingSubmit()
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
  expect(sessionStore.read('t1').phase).toBe('Submitting')
  await reply('Accepted')
  await pending
})

it('second enter while submitting sends one rpc', async () => {
  const { socket, binder, pending, reply } = await pendingSubmit()
  const second = binder.submit('extra keys')
  await Promise.resolve()
  expect(
    socket.sent.filter((raw) => JSON.parse(raw).type === 'command_editor_submit')
  ).toHaveLength(1)
  await reply('Accepted')
  await pending
  await second
})

it('command started before the reply leaves the editor closed', async () => {
  const { pending, reply } = await pendingSubmit()
  sessionStore.apply('t1', { type: 'CommandStarted', session_id: 's1', nonce: 'n1' })
  expect(sessionStore.read('t1').phase).toBe('Executing')
  await reply('Accepted')
  await pending
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
  expect(sessionStore.read('t1').committedSubmit).toBe(true)
  expect(commandDraftStore.read('t1')).toBe('')
})

it('slow history does not hold the session', async () => {
  let finish!: () => void
  const history = new Promise<void>((resolve) => {
    finish = resolve
  })
  const { pending, reply } = await pendingSubmit(() => history)
  await reply('Accepted')
  for (let i = 0; i < 12; i++) await Promise.resolve()
  expect(sessionStore.read('t1').committedSubmit).toBe(true)
  expect(commandDraftStore.read('t1')).toBe('')
  finish()
  await pending
})

it('late reply after exit does not reopen the editor', async () => {
  const { pending, reply } = await pendingSubmit()
  sessionStore.processExited('t1')
  const previous = sessionStore.read('t1')
  await reply('PreWrite')
  await pending
  expect(sessionStore.read('t1')).toEqual(previous)
})

it('late reply after respawn keeps the new draft', async () => {
  const { pending, reply } = await pendingSubmit()
  openTrustedSession('s2', 'n2')
  commandDraftStore.offer('t1', 'Editor', 'new draft')
  const previous = sessionStore.read('t1')
  await reply('Accepted')
  await pending
  expect(commandDraftStore.read('t1')).toBe('new draft')
  expect(sessionStore.read('t1')).toEqual(previous)
})

it('prewrite after desync stays raw', async () => {
  const { pending, reply } = await pendingSubmit()
  sessionStore.apply('t1', { type: 'Desync', session_id: 's1', nonce: 'n1' })
  const previous = sessionStore.read('t1')
  await reply('PreWrite')
  await pending
  expect(sessionStore.read('t1')).toEqual(previous)
  expect(sessionStore.read('t1').mode).toBe('raw')
})

it('session change during completion cancellation does not submit to respawn', async () => {
  const { socket, transport } = await createConnectedWebTransport()
  FakeWebSocket.holdCancel = true
  let pty = 'pty-9'
  const binder = bindSessionClient({ host: transport, terminalId: 't1', ptyId: () => pty })
  binder.requestCompletion({ draft: 'git st', cursor: 6, revision: 1 })
  const pending = binder.submit('git st')
  sessionStore.processExited('t1')
  pty = 'pty-new'
  openTrustedSession('s2', 'n2')
  commandDraftStore.offer('t1', 'Editor', 'new draft')
  const cancel = socket.sent
    .map((raw) => JSON.parse(raw) as { id: string; type: string })
    .find((frame) => frame.type === 'command_editor_cancel_completion')
  expect(cancel).toBeDefined()
  socket.reply(cancel!.id, 'Accepted')
  await pending
  expect(
    socket.sent.filter((raw) => JSON.parse(raw).type === 'command_editor_submit')
  ).toHaveLength(0)
  expect(commandDraftStore.read('t1')).toBe('new draft')
  binder.dispose()
})

it('stale accepted reply in respawn still records history', async () => {
  const history: string[] = []
  const { pending, reply } = await pendingSubmit(async () => {
    history.push('recorded')
  })
  sessionStore.processExited('t1')
  openTrustedSession('s2', 'n2')
  const previous = sessionStore.read('t1')
  await reply('Accepted')
  await pending
  expect(history).toEqual(['recorded'])
  expect(sessionStore.read('t1')).toEqual(previous)
})

it('accepted reply after exit still records history', async () => {
  const history: string[] = []
  const { pending, reply } = await pendingSubmit(async () => {
    history.push('git status')
  })
  sessionStore.processExited('t1')
  await reply('Accepted')
  await pending
  expect(history).toEqual(['git status'])
  expect(sessionStore.read('t1').mode).toBe('exited')
})

it('accepted reply after desync still records history', async () => {
  const history: string[] = []
  const { pending, reply } = await pendingSubmit(async () => {
    history.push('git status')
  })
  sessionStore.apply('t1', { type: 'Desync', session_id: 's1', nonce: 'n1' })
  await reply('Accepted')
  await pending
  expect(history).toEqual(['git status'])
  expect(sessionStore.read('t1').mode).toBe('raw')
})

it('stale before send skips host and history', async () => {
  const { socket, transport } = await createConnectedWebTransport()
  FakeWebSocket.holdCancel = true
  const history: string[] = []
  const binder = bindSessionClient({
    host: transport,
    terminalId: 't1',
    ptyId: () => 'pty-9',
    terminalName: 'local',
    projectId: 'p1',
    addCommand: async (command) => {
      history.push(command)
    }
  })
  binder.requestCompletion({ draft: 'git st', cursor: 6, revision: 1 })
  const pending = binder.submit('git st')
  sessionStore.processExited('t1')
  const cancel = socket.sent
    .map((raw) => JSON.parse(raw) as { id: string; type: string })
    .find((frame) => frame.type === 'command_editor_cancel_completion')
  expect(cancel).toBeDefined()
  socket.reply(cancel!.id, 'Accepted')
  const outcome = await pending
  expect(outcome.result).toBe('NotStarted')
  expect(
    socket.sent.filter((raw) => JSON.parse(raw).type === 'command_editor_submit')
  ).toHaveLength(0)
  expect(history).toEqual([])
  binder.dispose()
})

it('fast command before the reply clears the draft once', async () => {
  const history: string[] = []
  const { pending, reply } = await pendingSubmit(async () => {
    history.push('git status')
  })
  sessionStore.apply('t1', { type: 'CommandStarted', session_id: 's1', nonce: 'n1' })
  expect(sessionStore.read('t1').phase).toBe('Executing')
  expect(sessionStore.read('t1').committedSubmit).toBe(true)
  expect(commandDraftStore.read('t1')).toBe('')
  sessionStore.apply('t1', {
    type: 'CommandFinished',
    session_id: 's1',
    nonce: 'n1',
    exit_code: 0
  })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 2,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  expect(sessionStore.read('t1').mode).toBe('Editor')
  expect(sessionStore.read('t1').phase).toBe('AtPrompt')
  expect(commandDraftStore.read('t1')).toBe('')
  await reply('Accepted')
  await pending
  expect(history).toEqual(['git status'])
  expect(commandDraftStore.read('t1')).toBe('')
})

it('new draft typed before a late reply survives', async () => {
  const history: string[] = []
  const { pending, reply } = await pendingSubmit(async () => {
    history.push('git status')
  })
  sessionStore.apply('t1', { type: 'CommandStarted', session_id: 's1', nonce: 'n1' })
  sessionStore.apply('t1', {
    type: 'CommandFinished',
    session_id: 's1',
    nonce: 'n1',
    exit_code: 0
  })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 2,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  expect(sessionStore.read('t1').mode).toBe('Editor')
  expect(commandDraftStore.read('t1')).toBe('')
  commandDraftStore.offer('t1', 'Editor', 'new draft')
  expect(commandDraftStore.read('t1')).toBe('new draft')
  await reply('Accepted')
  await pending
  expect(commandDraftStore.read('t1')).toBe('new draft')
  expect(sessionStore.read('t1').mode).toBe('Editor')
  expect(sessionStore.read('t1').phase).toBe('AtPrompt')
  expect(history).toEqual(['git status'])
})
