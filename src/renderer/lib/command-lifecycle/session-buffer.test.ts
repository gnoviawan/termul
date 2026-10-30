import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { afterEach, expect, it, vi } from 'vitest'
import { useTerminalStore } from '@/stores/terminal-store'
import { commandDraftStore } from './draft-store'
import {
  LifecycleBuffer,
  MAX_PENDING_EVENTS,
  MAX_PENDING_PTYS,
  PENDING_TTL_MS
} from './session-buffer'
import { createSessionStore, sessionStore } from './session-store'

const event = (
  kind: SessionLifecyclePayload['kind'],
  terminal_id = 'pty'
): SessionLifecyclePayload => ({
  type: 'session_lifecycle',
  kind,
  terminal_id,
  session_id: 's',
  nonce: 'n',
  prompt_generation: 1,
  cwd: '/repo',
  line_empty: true,
  prompt_suppressed: true,
  exit_code: null
})

afterEach(() => {
  vi.useRealTimers()
  sessionStore.reset()
  commandDraftStore.processExited('t')
  useTerminalStore.getState().setTerminals([])
})

function fixture() {
  const store = createSessionStore()
  const apply = vi.fn((id: string, value: SessionLifecyclePayload) => store.apply(id, value))
  const buffer = new LifecycleBuffer(apply)
  let bound = false
  const lookup = () => (bound ? { id: 't' } : undefined)
  return {
    store,
    apply,
    buffer,
    lookup,
    bind: () => {
      bound = true
    }
  }
}

it('orders arrivals during a pending import and a reentrant drain', async () => {
  const f = fixture()
  let resolve!: (value: typeof f.lookup) => void
  const loading = new Promise<typeof f.lookup>((done) => {
    resolve = done
  })
  void loading.then((lookup) => f.buffer.connect(lookup))
  f.buffer.forward(event('InitShell'))
  f.bind()
  f.buffer.forward(event('PromptReady'))
  f.apply.mockImplementationOnce((id, value) => {
    f.buffer.forward(event('Desync'))
    return f.store.apply(id, value)
  })
  resolve(f.lookup)
  await loading
  await Promise.resolve()
  expect(f.apply.mock.calls.map(([, value]) => value.kind)).toEqual([
    'InitShell',
    'PromptReady',
    'Desync'
  ])
  expect(f.store.read('t').mode).toBe('raw')
  f.buffer.dispose()
})

it('forwards a bound pty immediately without retaining a buffer', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.bind()
  f.buffer.connect(f.lookup)
  f.buffer.forward(event('InitShell'))
  expect(f.apply).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  f.buffer.dispose()
})

it('compacts instead of dropping the history when the event cap is exceeded', () => {
  const f = fixture()
  f.buffer.connect(f.lookup)
  for (let i = 0; i <= MAX_PENDING_EVENTS; i++) f.buffer.forward(event('InitShell'))
  f.bind()
  f.buffer.flush()
  expect(f.apply.mock.calls.map(([, value]) => value.kind)).toEqual(['InitShell', 'InitShell'])
  expect(f.store.read('t').registered).toBe(true)
  f.buffer.dispose()
})

it('evicts the oldest pty at the global cap', () => {
  const f = fixture()
  f.buffer.connect(f.lookup)
  for (let i = 0; i <= MAX_PENDING_PTYS; i++) f.buffer.forward(event('InitShell', `pty-${i}`))
  f.bind()
  f.buffer.flush()
  expect(f.apply).toHaveBeenCalledTimes(MAX_PENDING_PTYS)
  expect(f.apply.mock.calls.map(([, value]) => value.terminal_id)).not.toContain('pty-0')
  f.buffer.dispose()
})

it('expires unbound histories even without another event or store change', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.buffer.connect(f.lookup)
  f.buffer.forward(event('InitShell'))
  vi.advanceTimersByTime(PENDING_TTL_MS)
  f.bind()
  f.buffer.flush()
  expect(f.apply).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  f.buffer.dispose()
})

const phase = (
  kind: SessionLifecyclePayload['kind'],
  generation: number,
  terminal_id = 'pty'
): SessionLifecyclePayload => ({ ...event(kind, terminal_id), prompt_generation: generation })

function ownedFixture() {
  const store = createSessionStore()
  const apply = vi.fn((id: string, value: SessionLifecyclePayload) => store.apply(id, value))
  const buffer = new LifecycleBuffer(apply)
  const owners = new Map<string, string>()
  buffer.connect((ptyId) => {
    const id = owners.get(ptyId)
    return id === undefined ? undefined : { id }
  })
  const appliedTo = (ptyId: string) =>
    apply.mock.calls.filter(([, value]) => value.terminal_id === ptyId)
  return { store, apply, buffer, owners, appliedTo }
}

it('compacts an over-cap history to InitShell then the latest phase event', () => {
  const f = ownedFixture()
  f.buffer.forward(phase('PromptReady', 90))
  f.buffer.forward(event('InitShell'))
  for (let i = 2; i < MAX_PENDING_EVENTS - 2; i++) f.buffer.forward(phase('CommandStarted', i))
  f.buffer.forward(phase('Desync', 70))
  f.buffer.forward(phase('CommandFinished', 71))
  f.buffer.forward(phase('PromptReady', 72))
  f.owners.set('pty', 't')
  f.buffer.flush()
  expect(f.apply.mock.calls.map(([, value]) => [value.kind, value.prompt_generation])).toEqual([
    ['InitShell', 1],
    ['Desync', 70],
    ['PromptReady', 72]
  ])
  f.buffer.dispose()
})

it('keeps the registration across an over-cap history so a later prompt mounts the editor', () => {
  const f = ownedFixture()
  f.buffer.forward(event('InitShell'))
  for (let i = 0; i < MAX_PENDING_EVENTS + 5; i++) f.buffer.forward(phase('CommandStarted', 1))
  f.owners.set('pty', 't')
  f.buffer.flush()
  f.buffer.forward(phase('PromptReady', 1))
  expect(f.store.read('t')).toMatchObject({ registered: true, trusted: true, mode: 'Editor' })
  f.buffer.dispose()
})

it('an evicted pty accepts no suffix until the host re-sends InitShell', () => {
  const f = ownedFixture()
  for (let i = 0; i <= MAX_PENDING_PTYS; i++) f.buffer.forward(event('InitShell', `pty-${i}`))
  f.buffer.forward(phase('PromptReady', 1, 'pty-0'))
  f.owners.set('pty-0', 't-0')
  f.owners.set('pty-1', 't-1')
  f.buffer.flush()
  f.buffer.forward(phase('PromptReady', 2, 'pty-0'))
  expect(f.appliedTo('pty-0')).toEqual([])
  expect(f.store.read('t-0').registered).toBe(false)
  expect(f.apply.mock.calls.every(([id, value]) => id === `t-${value.terminal_id.slice(4)}`)).toBe(
    true
  )
  f.buffer.forward(event('InitShell', 'pty-0'))
  f.buffer.forward(phase('PromptReady', 3, 'pty-0'))
  expect(f.appliedTo('pty-0').map(([id, value]) => [id, value.kind])).toEqual([
    ['t-0', 'InitShell'],
    ['t-0', 'PromptReady']
  ])
  expect(f.store.read('t-0')).toMatchObject({ registered: true, mode: 'Editor' })
  f.buffer.dispose()
})

it('an expired pty accepts no suffix, bound or unbound, until InitShell', () => {
  vi.useFakeTimers()
  const f = ownedFixture()
  f.buffer.forward(event('InitShell'))
  vi.advanceTimersByTime(PENDING_TTL_MS)
  f.buffer.forward(phase('CommandStarted', 1))
  f.owners.set('pty', 't')
  f.buffer.flush()
  f.buffer.forward(phase('PromptReady', 1))
  expect(f.apply).not.toHaveBeenCalled()
  expect(f.store.read('t').registered).toBe(false)
  f.buffer.forward(event('InitShell'))
  f.buffer.forward(phase('PromptReady', 2))
  expect(f.apply.mock.calls.map(([id, value]) => [id, value.kind])).toEqual([
    ['t', 'InitShell'],
    ['t', 'PromptReady']
  ])
  expect(f.store.read('t')).toMatchObject({ registered: true, mode: 'Editor' })
  f.buffer.dispose()
})

function staleEditorFixture() {
  const store = createSessionStore()
  const apply = vi.fn((id: string, value: SessionLifecyclePayload) => store.apply(id, value))
  const invalidate = vi.fn((id: string) => store.invalidate(id))
  const buffer = new LifecycleBuffer(apply, invalidate)
  const owners = new Map<string, string>()
  buffer.connect((ptyId) => {
    const id = owners.get(ptyId)
    return id === undefined ? undefined : { id }
  })
  store.apply('t', { type: 'InitShell', session_id: 's', nonce: 'n' })
  store.apply('t', {
    type: 'PromptReady',
    session_id: 's',
    nonce: 'n',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  commandDraftStore.offer('t', 'Editor', 'keep me')
  return { store, apply, invalidate, buffer, owners }
}

function expectFallenBack(store: ReturnType<typeof createSessionStore>): void {
  expect(store.read('t').mode).not.toBe('Editor')
  expect(store.read('t').trusted).toBe(false)
  expect(store.beginSubmit('t')).toBeNull()
  expect(commandDraftStore.read('t')).toBe('keep me')
}

function expectSuffixBlockedThenRestored(f: ReturnType<typeof staleEditorFixture>): void {
  const applied = f.apply.mock.calls.length
  f.buffer.forward(event('Desync'))
  f.buffer.forward(phase('PromptReady', 2))
  expect(f.apply).toHaveBeenCalledTimes(applied)
  f.buffer.forward(event('InitShell'))
  f.buffer.forward(phase('PromptReady', 2))
  expect(f.store.read('t')).toMatchObject({ mode: 'Editor', trusted: true })
  expect(commandDraftStore.read('t')).toBe('keep me')
}

it('expiry of a discarded history invalidates the rebound Editor snapshot', () => {
  vi.useFakeTimers()
  const f = staleEditorFixture()
  f.buffer.forward(event('InitShell'))
  f.buffer.forward(event('Desync'))
  vi.advanceTimersByTime(PENDING_TTL_MS)
  f.owners.set('pty', 't')
  f.buffer.flush()
  expectFallenBack(f.store)
  expectSuffixBlockedThenRestored(f)
  f.buffer.dispose()
})

it('eviction of a discarded history invalidates the rebound Editor snapshot', () => {
  const f = staleEditorFixture()
  f.buffer.forward(event('InitShell'))
  f.buffer.forward(event('Desync'))
  for (let i = 0; i < MAX_PENDING_PTYS; i++) f.buffer.forward(event('InitShell', `other-${i}`))
  f.owners.set('pty', 't')
  f.buffer.flush()
  expectFallenBack(f.store)
  expectSuffixBlockedThenRestored(f)
  f.buffer.dispose()
})

it('discard invalidates a bound owner immediately', () => {
  vi.useFakeTimers()
  const f = staleEditorFixture()
  f.buffer.forward(event('InitShell'))
  f.buffer.forward(event('Desync'))
  f.owners.set('pty', 't')
  expect(f.invalidate).not.toHaveBeenCalled()
  vi.advanceTimersByTime(PENDING_TTL_MS)
  expect(f.invalidate).toHaveBeenCalledTimes(1)
  expect(f.invalidate).toHaveBeenCalledWith('t')
  expectFallenBack(f.store)
  expectSuffixBlockedThenRestored(f)
  f.buffer.dispose()
})

it('invalidates at most once per discard across flushes and ignored events', () => {
  vi.useFakeTimers()
  const f = staleEditorFixture()
  f.buffer.forward(event('InitShell'))
  vi.advanceTimersByTime(PENDING_TTL_MS)
  f.owners.set('pty', 't')
  f.buffer.flush()
  f.buffer.flush()
  f.buffer.forward(event('Desync'))
  f.buffer.forward(phase('PromptReady', 2))
  f.buffer.flush()
  f.buffer.forward(event('InitShell'))
  expect(f.invalidate).toHaveBeenCalledTimes(1)
  expect(f.invalidate).toHaveBeenCalledWith('t')
  f.buffer.dispose()
})

it('re-resolves the owner before each drained event', () => {
  const f = ownedFixture()
  f.buffer.forward(event('InitShell'))
  f.buffer.forward(phase('PromptReady', 1))
  f.buffer.forward(phase('CommandStarted', 1))
  f.owners.set('pty', 'old')
  f.apply.mockImplementationOnce((id, value) => {
    f.owners.set('pty', 'new')
    f.buffer.flush()
    return f.store.apply(id, value)
  })
  f.apply.mockImplementationOnce((id, value) => {
    f.owners.delete('pty')
    f.buffer.flush()
    return f.store.apply(id, value)
  })
  f.buffer.flush()
  expect(f.apply.mock.calls.map(([id, value]) => [id, value.kind])).toEqual([
    ['old', 'InitShell'],
    ['new', 'PromptReady']
  ])
  f.owners.set('pty', 'newest')
  f.buffer.flush()
  expect(f.apply.mock.calls.map(([id]) => id)).toEqual(['old', 'new', 'newest'])
  f.buffer.dispose()
})
