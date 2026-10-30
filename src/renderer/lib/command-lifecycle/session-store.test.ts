import { readFileSync } from 'node:fs'
import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { listen } from '@tauri-apps/api/event'
import { afterEach, expect, it, vi } from 'vitest'
import { terminalApi } from '@/lib/api'
import { createTauriTerminalApi } from '@/lib/tauri-terminal-api'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { WebTerminalClient } from '@/lib/web-terminal-api'
import { useTerminalStore } from '@/stores/terminal-store'
import { bindSessionClient } from './bind-session'
import { commandDraftStore } from './draft-store'
import { sessionStore } from './session-store'

afterEach(() => {
  vi.restoreAllMocks()
  sessionStore.reset()
  commandDraftStore.processExited('t1')
  useTerminalStore.getState().setTerminals([])
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
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

it('completion without an explicit editor revision is rejected instead of defaulting to zero', () => {
  trustedPromptSnapshot()
  const requestCompletion = vi.fn(async () => ({ result: 'Accepted' as const }))
  const binder = bindSessionClient({
    host: { submitCommand: async () => 'NotStarted', requestCompletion },
    terminalId: 't1',
    ptyId: () => 'pty-9'
  })

  binder.requestCompletion({ draft: 'git st', cursor: 6 })

  expect(requestCompletion).not.toHaveBeenCalled()
})

it('an explicit zero editor revision remains valid', () => {
  trustedPromptSnapshot()
  const requestCompletion = vi.fn(async () => ({ result: 'Accepted' as const }))
  const binder = bindSessionClient({
    host: { submitCommand: async () => 'NotStarted', requestCompletion },
    terminalId: 't1',
    ptyId: () => 'pty-9'
  })

  binder.requestCompletion({ draft: 'git st', bufferRevision: 0, cursor: 6 })

  expect(requestCompletion).toHaveBeenCalledWith(
    'pty-9',
    expect.objectContaining({ bufferRevision: 0 })
  )
})

it('a prompt event opens the editor through the session store', () => {
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })

  expect(sessionStore.read('t1').mode).toBe('Editor')
})

it('an unregistered prompt does not open the editor', () => {
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's2',
    nonce: 'n2',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })

  expect(sessionStore.read('t1').mode).not.toBe('Editor')
})

it('a prompt for another session does not open the editor', () => {
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  const mode = sessionStore.read('t1').mode

  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's9',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })

  expect(sessionStore.read('t1').mode).toBe(mode)
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
})

it('a user command leaves the editor', async () => {
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  expect(sessionStore.read('t1').mode).toBe('Editor')

  const binder = bindSessionClient({
    host: { submitCommand: async () => 'Accepted' },
    terminalId: 't1',
    ptyId: () => 'pty-9'
  })
  await binder.submit('git status')

  sessionStore.apply('t1', { type: 'CommandStarted', session_id: 's1', nonce: 'n1' })

  expect(sessionStore.read('t1').mode).not.toBe('Editor')
})

it('command finished records the exit code', () => {
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  expect(sessionStore.read('t1').mode).not.toBe('Editor')

  sessionStore.apply('t1', {
    type: 'CommandFinished',
    session_id: 's1',
    nonce: 'n1',
    exit_code: 2
  })

  expect(sessionStore.read('t1').lastExitCode).toBe(2)
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
})

it('web adapter applies session lifecycle', () => {
  const protocol = readFileSync('src/shared/types/web-terminal-protocol.types.ts', 'utf8')
  const source = readFileSync('src/renderer/lib/web-terminal-api.ts', 'utf8')
  const adapter = readFileSync('src/renderer/lib/command-lifecycle/session-adapter.ts', 'utf8')
  expect(protocol).toContain("type: 'session_lifecycle'")
  const handler = source.split('private handleEvent(')[1]?.split('private dispatchSnapshot(')[0]
  const lifecycle = handler?.split("case 'session_lifecycle':")[1]?.split('break')[0]
  expect(lifecycle).toContain('forwardSessionLifecycle(event)')
  expect(adapter).toContain('findTerminalByPtyId(ptyId)')
  expect(adapter).toContain('sessionStore.apply(id, event)')
  expect(adapter).toContain('sessionStore.invalidate(id)')
  expect(lifecycle).not.toMatch(/completion/i)
  expect(adapter).not.toMatch(/completion/i)
})

it('desktop adapter applies session lifecycle', () => {
  const source = readFileSync('src/renderer/lib/tauri-terminal-api.ts', 'utf8')
  const adapter = readFileSync('src/renderer/lib/command-lifecycle/session-adapter.ts', 'utf8')
  const lifecycle = source.split('onCwdChanged(callback:')[1]?.split('/**')[0]
  expect(lifecycle).toContain("'terminal-session-lifecycle'")
  expect(lifecycle).toContain('forwardSessionLifecycle(event)')
  expect(adapter).toContain('sessionStore.apply(id, event)')
  expect(adapter).toContain('sessionStore.invalidate(id)')
  expect(adapter).toContain('findTerminalByPtyId(ptyId)')
  expect(lifecycle).not.toMatch(/completion/i)
  expect(adapter).not.toMatch(/completion/i)
})

it('desync leaves the editor without a client restore', async () => {
  const submitCommand = vi.fn(async () => 'Accepted' as const)
  const restorePrompt = vi.spyOn(terminalApi, 'restorePrompt').mockResolvedValue('Accepted')
  const binder = bindSessionClient({
    host: { submitCommand },
    terminalId: 't1',
    ptyId: () => 'pty-9'
  })
  expect(binder).toBeDefined()
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  commandDraftStore.offer('t1', 'Editor', 'git status')
  expect(sessionStore.read('t1').mode).toBe('Editor')
  expect('bindRestore' in sessionStore).toBe(false)
  sessionStore.apply('t1', { kind: 'Desync', session_id: 's1', nonce: 'n1' })
  await Promise.resolve()
  expect(sessionStore.read('t1').mode).toBe('raw')
  expect(commandDraftStore.read('t1')).toBe('git status')
  expect(submitCommand).not.toHaveBeenCalled()
  expect(restorePrompt).not.toHaveBeenCalled()
  sessionStore.apply('t1', { kind: 'Desync', session_id: 's1', nonce: 'n1' })
  expect(restorePrompt).not.toHaveBeenCalled()
})

it('lifecycle envelope opens the editor and leaves restore to the host', async () => {
  const restorePrompt = vi.spyOn(terminalApi, 'restorePrompt').mockResolvedValue('Accepted')
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  expect('bindRestore' in sessionStore).toBe(false)
  sessionStore.apply('t1', {
    type: 'session_lifecycle',
    kind: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  expect(sessionStore.read('t1').mode).toBe('Editor')
  sessionStore.apply('t1', {
    type: 'session_lifecycle',
    kind: 'Desync',
    session_id: 's1',
    nonce: 'n1'
  })
  await Promise.resolve()
  expect(sessionStore.read('t1').mode).toBe('raw')
  expect(restorePrompt).not.toHaveBeenCalled()
})

it('a prompt without init shell stays raw', () => {
  const mode = sessionStore.read('t1').mode

  sessionStore.apply('t1', {
    type: 'session_lifecycle',
    kind: 'PromptReady',
    session_id: 's2',
    nonce: 'n2',
    prompt_generation: 1,
    line_empty: true,
    prompt_suppressed: true,
    cwd: '/repo',
    exit_code: null
  })

  expect(sessionStore.read('t1').mode).toBe(mode)
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
})

it('the hub command start leaves the editor', async () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't1', ptyId: 'pty-9' })])

  for (const applyAdapter of [applyThroughWebAdapter, applyThroughTauriAdapter]) {
    sessionStore.reset()
    sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
    sessionStore.apply('t1', {
      type: 'PromptReady',
      session_id: 's1',
      nonce: 'n1',
      prompt_generation: 1,
      cwd: '/repo',
      line_empty: true,
      prompt_suppressed: true
    })
    expect(sessionStore.read('t1').mode).toBe('Editor')

    const binder = bindSessionClient({
      host: { submitCommand: async () => 'Accepted' },
      terminalId: 't1',
      ptyId: () => 'pty-9'
    })
    await binder.submit('git status')

    await applyAdapter(lifecyclePayload({ kind: 'CommandStarted' }))

    expect(sessionStore.read('t1').mode).not.toBe('Editor')
  }
})

it('init shell then prompt opens the editor through the adapters', async () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't1', ptyId: 'pty-9' })])

  for (const applyAdapter of [applyThroughWebAdapter, applyThroughTauriAdapter]) {
    sessionStore.reset()
    await applyAdapter(lifecyclePayload({ kind: 'InitShell' }))
    await applyAdapter(
      lifecyclePayload({
        kind: 'PromptReady',
        prompt_generation: 1,
        line_empty: true,
        prompt_suppressed: true,
        cwd: '/repo'
      })
    )

    expect(sessionStore.read('t1').mode).toBe('Editor')
  }
})

it('the adapters record the finished exit code', async () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't1', ptyId: 'pty-9' })])

  for (const applyAdapter of [applyThroughWebAdapter, applyThroughTauriAdapter]) {
    sessionStore.reset()
    await applyAdapter(lifecyclePayload({ kind: 'InitShell' }))
    expect(sessionStore.read('t1').mode).not.toBe('Editor')

    await applyAdapter(
      lifecyclePayload({
        terminal_id: 'unknown-pty',
        kind: 'CommandFinished',
        exit_code: 9
      })
    )
    expect(sessionStore.read('t1').lastExitCode).toBeNull()

    await applyAdapter(
      lifecyclePayload({
        kind: 'CommandFinished',
        exit_code: 2
      })
    )

    expect(sessionStore.read('t1').lastExitCode).toBe(2)
    expect(sessionStore.read('t1').mode).not.toBe('Editor')
  }
})

it('prompt without a generation stays raw', () => {
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  const modeBefore = sessionStore.read('t1').mode

  sessionStore.apply('t1', {
    type: 'session_lifecycle',
    kind: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: null,
    line_empty: true,
    prompt_suppressed: true,
    cwd: '/repo',
    exit_code: null
  })

  expect(sessionStore.read('t1').mode).toBe(modeBefore)
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
  expect(sessionStore.read('t1').promptGeneration).toBeNull()

  sessionStore.apply('t1', {
    type: 'session_lifecycle',
    kind: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    line_empty: true,
    prompt_suppressed: true,
    cwd: null,
    exit_code: null
  })

  expect(sessionStore.read('t1').mode).toBe(modeBefore)
  expect(sessionStore.read('t1').mode).not.toBe('Editor')
  expect(sessionStore.read('t1').promptGeneration).toBeNull()
})

it('invalidate demotes a trusted editor without a host nonce and keeps the draft', () => {
  trustedPromptSnapshot()
  commandDraftStore.offer('t1', 'Editor', 'unfinished draft')
  sessionStore.invalidate('t1')
  expect(sessionStore.read('t1')).toMatchObject({
    mode: 'raw',
    trusted: false,
    phase: 'Unknown',
    completionPending: false
  })
  expect(sessionStore.beginSubmit('t1')).toBeNull()
  expect(commandDraftStore.read('t1')).toBe('unfinished draft')
})

it.each([
  'web',
  'tauri'
] as const)('%s process exit marks the session exited and drops its draft', async (runtime) => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't1', ptyId: 'pty-9' })])
  const applyAdapter = runtime === 'web' ? applyThroughWebAdapter : applyThroughTauriAdapter
  await applyAdapter(lifecyclePayload({ kind: 'InitShell' }))
  await applyAdapter(
    lifecyclePayload({
      kind: 'PromptReady',
      prompt_generation: 1,
      cwd: '/repo',
      line_empty: true,
      prompt_suppressed: true
    })
  )
  commandDraftStore.offer('t1', 'Editor', 'make test')

  if (runtime === 'web') {
    const client = new WebTerminalClient('ws://localhost/terminal/ws')
    ;(
      client as unknown as {
        handleEvent(event: {
          type: 'exit'
          terminal_id: string
          exit_code: number
          signal: null
        }): void
      }
    ).handleEvent({ type: 'exit', terminal_id: 'pty-9', exit_code: 0, signal: null })
  } else {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    vi.mocked(listen).mockClear()
    const stop = createTauriTerminalApi().onExit(() => {})
    const call = vi.mocked(listen).mock.calls.find(([eventName]) => eventName === 'terminal-exit')
    const handler = call?.[1] as
      | ((event: { payload: { id: string; exitCode: number; signal: null } }) => void)
      | undefined
    expect(handler).toBeTypeOf('function')
    handler?.({ payload: { id: 'pty-9', exitCode: 0, signal: null } })
    stop()
  }

  expect(sessionStore.read('t1').mode).toBe('exited')
  expect(commandDraftStore.read('t1')).toBe('')
})

it('process exit drops the stored draft', () => {
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  commandDraftStore.offer('t1', 'Editor', 'make test')
  expect(sessionStore.read('t1').mode).toBe('Editor')
  expect(commandDraftStore.read('t1')).toBe('make test')

  sessionStore.processExited('t1')

  expect(sessionStore.read('t1').mode).toBe('exited')
  expect(commandDraftStore.read('t1')).toBe('')

  // Respawn simulated by a new InitShell for the same terminal id "t1"
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's2', nonce: 'n2' })
  sessionStore.apply('t1', {
    type: 'PromptReady',
    session_id: 's2',
    nonce: 'n2',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  expect(sessionStore.read('t1').mode).toBe('Editor')
})

function trustedPromptSnapshot() {
  sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  const prompt = {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  }
  sessionStore.apply('t1', prompt)
  return { prompt, previous: sessionStore.read('t1') }
}

it('prompt with a wrong nonce keeps the snapshot', () => {
  const { prompt, previous } = trustedPromptSnapshot()
  sessionStore.apply('t1', { ...prompt, nonce: 'forged', cwd: '/evil' })
  expect(sessionStore.read('t1')).toEqual(previous)
})

it('a newer authenticated prompt refreshes generation and cwd without replacing the draft', () => {
  const { prompt } = trustedPromptSnapshot()
  commandDraftStore.offer('t1', 'Editor', 'unfinished draft')

  sessionStore.apply('t1', { ...prompt, prompt_generation: 5, cwd: '/repo/new' })

  expect(sessionStore.read('t1')).toMatchObject({
    mode: 'Editor',
    promptGeneration: 5,
    cwd: '/repo/new'
  })
  expect(commandDraftStore.read('t1')).toBe('unfinished draft')
})

it('duplicate prompt with another cwd keeps the snapshot', () => {
  const { prompt, previous } = trustedPromptSnapshot()
  sessionStore.apply('t1', { ...prompt, cwd: '/other' })
  expect(sessionStore.read('t1')).toEqual(previous)
})

it('unsafe prompt flags keep the snapshot', () => {
  const { prompt, previous } = trustedPromptSnapshot()
  for (const flags of [{ line_empty: false }, { prompt_suppressed: false }]) {
    sessionStore.apply('t1', { ...prompt, ...flags, cwd: '/unsafe' })
    expect(sessionStore.read('t1')).toEqual(previous)
  }
})

it('session-store uses editor-revision in lib without upward component imports', async () => {
  const source = readFileSync('src/renderer/lib/command-lifecycle/session-store.ts', 'utf8')
  expect(source).toContain("from './editor-revision'")
  expect(source).not.toContain('@/components/')
  const { bumpEditorRevision, readEditorRevision } = await import('./editor-revision')
  expect(bumpEditorRevision('t1')).toBe(1)
  expect(readEditorRevision('t1')).toBe(1)
  sessionStore.processExited('t1')
  expect(readEditorRevision('t1')).toBe(0)
})

for (const kind of ['Desync', 'CommandStarted', 'PromptReady'] as const) {
  it(`reconnect InitShell + ${kind} retains the draft and reflects the host phase`, () => {
    const { prompt } = trustedPromptSnapshot()
    commandDraftStore.offer('t1', 'Editor', 'unfinished draft')
    sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
    sessionStore.apply('t1', { ...prompt, type: kind })
    const snapshot = sessionStore.read('t1')
    if (kind === 'Desync') expect(snapshot).toMatchObject({ trusted: false, mode: 'raw' })
    if (kind === 'CommandStarted') {
      expect(snapshot.phase).toBe('Executing')
      expect(snapshot.mode).not.toBe('Editor')
    }
    if (kind === 'PromptReady') expect(snapshot).toMatchObject({ trusted: true, mode: 'Editor' })
    expect(commandDraftStore.read('t1')).toBe('unfinished draft')
    sessionStore.apply('t1', { ...prompt, prompt_generation: 2 })
    expect(sessionStore.read('t1').mode).toBe('Editor')
    expect(commandDraftStore.read('t1')).toBe('unfinished draft')
  })
}

const unauthenticatedStarts: Array<[string, Record<string, unknown>]> = [
  ['no nonce', { type: 'CommandStarted', session_id: 's1' }],
  ['a null nonce', { type: 'CommandStarted', session_id: 's1', nonce: null }],
  ['a wrong nonce', { type: 'CommandStarted', session_id: 's1', nonce: 'forged' }],
  ['a wrong session id', { type: 'CommandStarted', session_id: 'other', nonce: 'n1' }]
]

for (const [label, started] of unauthenticatedStarts) {
  it(`command started with ${label} keeps the editor and the draft`, () => {
    const { previous } = trustedPromptSnapshot()
    commandDraftStore.offer('t1', 'Editor', 'unfinished draft')
    expect(previous.mode).toBe('Editor')
    sessionStore.apply('t1', started)
    expect(sessionStore.read('t1')).toEqual(previous)
    expect(commandDraftStore.read('t1')).toBe('unfinished draft')
  })
}

it('an authenticated replay command started demotes the editor and keeps the draft', () => {
  trustedPromptSnapshot()
  commandDraftStore.offer('t1', 'Editor', 'unfinished draft')
  sessionStore.apply('t1', { type: 'CommandStarted', session_id: 's1', nonce: 'n1' })
  expect(sessionStore.read('t1')).toMatchObject({
    mode: 'PTY',
    phase: 'Executing',
    committedSubmit: false
  })
  expect(commandDraftStore.read('t1')).toBe('unfinished draft')
})
