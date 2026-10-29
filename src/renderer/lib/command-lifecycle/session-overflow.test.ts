import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import { afterEach, expect, it, vi } from 'vitest'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { useTerminalStore } from '@/stores/terminal-store'
import { commandDraftStore } from './draft-store'
import { disposeSessionAdapter, forwardSessionLifecycle } from './session-adapter'
import { LifecycleBuffer, MAX_DISCARDED_PTYS, MAX_PENDING_PTYS } from './session-buffer'
import { sessionStore } from './session-store'

const event = (
  kind: SessionLifecyclePayload['kind'],
  terminal_id = 'p',
  prompt_generation = 1
): SessionLifecyclePayload => ({
  type: 'session_lifecycle',
  kind,
  terminal_id,
  session_id: 's',
  nonce: 'n',
  prompt_generation,
  cwd: '/repo',
  line_empty: true,
  prompt_suppressed: true,
  exit_code: null
})

afterEach(() => {
  disposeSessionAdapter()
  sessionStore.reset()
  for (const id of ['a', 't', 'live']) commandDraftStore.processExited(id)
  useTerminalStore.getState().setTerminals([])
  vi.restoreAllMocks()
})

function seedEditor(id: string): void {
  sessionStore.apply(id, event('InitShell'))
  sessionStore.apply(id, event('PromptReady'))
  commandDraftStore.offer(id, 'Editor', 'keep me')
  expect(sessionStore.read(id)).toMatchObject({ mode: 'Editor', trusted: true })
}

async function overflow(
  beforeConnect = false,
  rebindBeforeConnect = false,
  rebindDuringOverflow = false
): Promise<void> {
  disposeSessionAdapter()
  useTerminalStore
    .getState()
    .setTerminals([
      mockTerminal({ id: 't', ptyId: 'p' }),
      mockTerminal({ id: 'live', ptyId: 'live-p' })
    ])
  seedEditor('t')
  seedEditor('live')
  if (!beforeConnect) {
    forwardSessionLifecycle(event('InitShell', 'live-p'))
    await import('@/stores/terminal-store')
    await Promise.resolve()
  }
  useTerminalStore.getState().clearTerminalPtyId('p')
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('Desync'))
  for (let i = 0; i < MAX_PENDING_PTYS + MAX_DISCARDED_PTYS; i++) {
    if (rebindDuringOverflow && i === MAX_PENDING_PTYS) {
      useTerminalStore.getState().setTerminalPtyId('t', 'p')
    }
    forwardSessionLifecycle(event('InitShell', `other-${i}`))
  }
  if (rebindBeforeConnect) useTerminalStore.getState().setTerminalPtyId('t', 'p')
  await import('@/stores/terminal-store')
  await Promise.resolve()
}

it.each([
  false,
  true
])('overflow invalidates stale Editor and preserves recovery (beforeConnect=%s)', async (beforeConnect) => {
  await overflow(beforeConnect)
  useTerminalStore.getState().setTerminalPtyId('t', 'p')
  expect(sessionStore.read('t').trusted).toBe(false)
  expect(sessionStore.read('t').mode).not.toBe('Editor')
  expect(sessionStore.beginSubmit('t')).toBeNull()
  expect(commandDraftStore.read('t')).toBe('keep me')
  forwardSessionLifecycle(event('Desync'))
  forwardSessionLifecycle(event('PromptReady', 'p', 2))
  expect(sessionStore.read('t').mode).not.toBe('Editor')
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('PromptReady', 'p', 2))
  expect(sessionStore.read('t')).toMatchObject({ mode: 'Editor', trusted: true })
  expect(commandDraftStore.read('t')).toBe('keep me')
})

it('an evicted tombstone cannot reopen Editor through a suffix alone', async () => {
  await overflow()
  useTerminalStore.getState().setTerminalPtyId('t', 'p')
  forwardSessionLifecycle(event('Desync'))
  forwardSessionLifecycle(event('PromptReady', 'p', 2))
  expect(sessionStore.read('t').mode).not.toBe('Editor')
  expect(sessionStore.beginSubmit('t')).toBeNull()
  expect(commandDraftStore.read('t')).toBe('keep me')
})

it('invalidates before an immediate rebind while the adapter import is pending', async () => {
  await overflow(true, true)
  expect(sessionStore.read('t').trusted).toBe(false)
  expect(sessionStore.read('t').mode).not.toBe('Editor')
  expect(sessionStore.beginSubmit('t')).toBeNull()
  expect(commandDraftStore.read('t')).toBe('keep me')
  expect(sessionStore.read('live')).toMatchObject({ mode: 'Editor', trusted: true })
})

it('keeps a pending invalidation when rebind precedes tombstone overflow in the same turn', async () => {
  await overflow(true, false, true)
  expect(sessionStore.read('t').trusted).toBe(false)
  expect(sessionStore.read('t').mode).not.toBe('Editor')
  expect(sessionStore.beginSubmit('t')).toBeNull()
  expect(commandDraftStore.read('t')).toBe('keep me')
  expect(sessionStore.read('live')).toMatchObject({ mode: 'Editor', trusted: true })
})

it('overflow leaves a bound live Editor and its draft untouched', async () => {
  await overflow()
  expect(sessionStore.read('live')).toMatchObject({ mode: 'Editor', trusted: true })
  expect(commandDraftStore.read('live')).toBe('keep me')
  expect(sessionStore.beginSubmit('live')).not.toBeNull()
})

it('keeps both tombstone sets bounded throughout repeated overflow', async () => {
  const forward = LifecycleBuffer.prototype.forward
  let observed = 0
  vi.spyOn(LifecycleBuffer.prototype, 'forward').mockImplementation(function (
    this: LifecycleBuffer,
    event
  ) {
    forward.call(this, event)
    // Inspect TypeScript-private sets only in tests; no production accessor is needed.
    const state = this as unknown as {
      discarded: Set<string>
      invalidatePending: Set<string>
    }
    expect(state.discarded.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS)
    expect(state.invalidatePending.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS)
    observed = Math.max(observed, state.discarded.size)
  })
  await overflow()
  for (let i = 0; i < MAX_DISCARDED_PTYS * 2; i++) {
    forwardSessionLifecycle(event('InitShell', `extra-${i}`))
  }
  expect(observed).toBe(MAX_DISCARDED_PTYS)
})

it.each([
  false,
  true
])('snapshots stale Editors before a reentrant rebind (nested=%s)', async (nested) => {
  disposeSessionAdapter()
  useTerminalStore
    .getState()
    .setTerminals([
      mockTerminal({ id: 'a', ptyId: null }),
      mockTerminal({ id: 't', ptyId: 'p' }),
      mockTerminal({ id: 'live', ptyId: 'live-p' })
    ])
  for (const id of ['a', 't', 'live']) seedEditor(id)
  forwardSessionLifecycle(event('InitShell', 'live-p'))
  useTerminalStore.getState().clearTerminalPtyId('p')
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('Desync'))
  let rebound = false
  const unsubscribe = sessionStore.subscribe(() => {
    if (rebound || sessionStore.read('a').trusted) return
    rebound = true
    useTerminalStore.getState().setTerminalPtyId('t', 'p')
    // Exercise reentrant unbind invalidation only in the nested case.
    if (nested) useTerminalStore.getState().clearTerminalPtyId('live-p')
    if (nested) forwardSessionLifecycle(event('InitShell', 'nested'))
  })
  try {
    for (let i = 0; i < MAX_PENDING_PTYS + MAX_DISCARDED_PTYS; i++) {
      forwardSessionLifecycle(event('InitShell', `other-${i}`))
    }
    expect(rebound).toBe(true)
    for (const id of ['a', 't']) {
      expect(sessionStore.read(id).registered).toBe(false)
      expect(sessionStore.read(id).trusted).toBe(false)
      expect(sessionStore.read(id).mode).not.toBe('Editor')
      expect(sessionStore.beginSubmit(id)).toBeNull()
      expect(commandDraftStore.read(id)).toBe('keep me')
    }
    if (nested) {
      // Any fallback scan invalidates an unbound trusted Editor, even without history loss.
      expect(sessionStore.read('live')).toMatchObject({ registered: false, trusted: false })
      expect(sessionStore.read('live').mode).not.toBe('Editor')
      expect(sessionStore.beginSubmit('live')).toBeNull()
      expect(commandDraftStore.read('live')).toBe('keep me')
      useTerminalStore.getState().setTerminalPtyId('live', 'live-p')
      forwardSessionLifecycle(event('Desync', 'live-p'))
      forwardSessionLifecycle(event('PromptReady', 'live-p', 2))
      expect(sessionStore.read('live').mode).not.toBe('Editor')
      expect(sessionStore.beginSubmit('live')).toBeNull()
      forwardSessionLifecycle(event('InitShell', 'live-p'))
      forwardSessionLifecycle(event('PromptReady', 'live-p', 2))
      expect(sessionStore.read('live')).toMatchObject({
        registered: true,
        trusted: true,
        mode: 'Editor'
      })
      expect(commandDraftStore.read('live')).toBe('keep me')
    } else {
      expect(sessionStore.read('live')).toMatchObject({
        registered: true,
        trusted: true,
        mode: 'Editor'
      })
    }
    for (const [id, ptyId] of [
      ['a', 'a-p'],
      ['t', 'p']
    ]) {
      useTerminalStore.getState().setTerminalPtyId(id, ptyId)
      forwardSessionLifecycle(event('Desync', ptyId))
      forwardSessionLifecycle(event('PromptReady', ptyId, 2))
      expect(sessionStore.read(id).mode).not.toBe('Editor')
      expect(sessionStore.beginSubmit(id)).toBeNull()
      forwardSessionLifecycle(event('InitShell', ptyId))
      forwardSessionLifecycle(event('PromptReady', ptyId, 2))
      expect(sessionStore.read(id)).toMatchObject({
        registered: true,
        trusted: true,
        mode: 'Editor'
      })
      expect(commandDraftStore.read(id)).toBe('keep me')
    }
  } finally {
    unsubscribe()
  }
})

it('retains the obligation during fallback and bounds repeated nested overflow', () => {
  disposeSessionAdapter()
  useTerminalStore
    .getState()
    .setTerminals([
      mockTerminal({ id: 'a', ptyId: null }),
      mockTerminal({ id: 't', ptyId: 'p' }),
      mockTerminal({ id: 'live', ptyId: 'live-p' })
    ])
  for (const id of ['a', 't', 'live']) seedEditor(id)
  const forward = LifecycleBuffer.prototype.forward
  let state:
    | { pending: Map<string, unknown>; discarded: Set<string>; invalidatePending: Set<string> }
    | undefined
  vi.spyOn(LifecycleBuffer.prototype, 'forward').mockImplementation(function (
    this: LifecycleBuffer,
    event
  ) {
    state = this as unknown as NonNullable<typeof state>
    forward.call(this, event)
    expect(state.pending.size).toBeLessThanOrEqual(MAX_PENDING_PTYS + 1)
    expect(state.discarded.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS + 1)
    expect(state.invalidatePending.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS + 1)
  })
  forwardSessionLifecycle(event('InitShell', 'live-p'))
  useTerminalStore.getState().clearTerminalPtyId('p')
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('Desync'))
  let nested = false
  const unsubscribe = sessionStore.subscribe(() => {
    if (nested || sessionStore.read('a').trusted) return
    nested = true
    expect(state?.discarded.has('p')).toBe(true)
    expect(state?.invalidatePending.has('p')).toBe(true)
    useTerminalStore.getState().clearTerminalPtyId('live-p')
    for (let i = 0; i < MAX_DISCARDED_PTYS * 2; i++) {
      forwardSessionLifecycle(event('InitShell', `nested-${i}`))
    }
    useTerminalStore.getState().setTerminalPtyId('t', 'p')
  })
  try {
    for (let i = 0; i < MAX_PENDING_PTYS + MAX_DISCARDED_PTYS; i++) {
      forwardSessionLifecycle(event('InitShell', `other-${i}`))
    }
    expect(nested).toBe(true)
    expect(state?.pending.size).toBeLessThanOrEqual(MAX_PENDING_PTYS)
    expect(state?.discarded.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS)
    expect(state?.invalidatePending.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS)
    for (const id of ['a', 't']) {
      expect(sessionStore.read(id)).toMatchObject({
        registered: false,
        trusted: false,
        mode: 'raw'
      })
      expect(sessionStore.beginSubmit(id)).toBeNull()
      expect(commandDraftStore.read(id)).toBe('keep me')
    }
    expect(sessionStore.read('live')).toMatchObject({ registered: false, trusted: false })
    expect(sessionStore.read('live').mode).not.toBe('Editor')
    expect(sessionStore.beginSubmit('live')).toBeNull()
    expect(commandDraftStore.read('live')).toBe('keep me')
  } finally {
    unsubscribe()
  }
})

it('bound live editor stays untouched', () => {
  disposeSessionAdapter()
  useTerminalStore
    .getState()
    .setTerminals([
      mockTerminal({ id: 'a', ptyId: null }),
      mockTerminal({ id: 't', ptyId: 'p' }),
      mockTerminal({ id: 'live', ptyId: 'live-p' })
    ])
  for (const id of ['a', 't', 'live']) seedEditor(id)
  forwardSessionLifecycle(event('InitShell', 'live-p'))
  useTerminalStore.getState().clearTerminalPtyId('p')
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('Desync'))
  let nested = false
  const unsubscribe = sessionStore.subscribe(() => {
    if (nested || sessionStore.read('a').trusted) return
    nested = true
    for (let i = 0; i < MAX_DISCARDED_PTYS * 2; i++) {
      forwardSessionLifecycle(event('InitShell', `nested-${i}`))
    }
    useTerminalStore.getState().setTerminalPtyId('t', 'p')
  })
  try {
    for (let i = 0; i < MAX_PENDING_PTYS + MAX_DISCARDED_PTYS; i++) {
      forwardSessionLifecycle(event('InitShell', `other-${i}`))
    }
    expect(nested).toBe(true)
    expect(useTerminalStore.getState().findTerminalByPtyId('live-p')?.id).toBe('live')
    expect(sessionStore.read('live')).toMatchObject({
      registered: true,
      trusted: true,
      mode: 'Editor'
    })
    expect(commandDraftStore.read('live')).toBe('keep me')
    expect(sessionStore.beginSubmit('live')).not.toBeNull()
  } finally {
    unsubscribe()
  }
})

it('keeps the first host event when fallback binds the PTY being buffered', () => {
  disposeSessionAdapter()
  useTerminalStore
    .getState()
    .setTerminals([mockTerminal({ id: 'a', ptyId: null }), mockTerminal({ id: 't', ptyId: null })])
  seedEditor('a')
  commandDraftStore.offer('t', 'Editor', 'keep me')
  for (let i = 0; i < MAX_PENDING_PTYS + MAX_DISCARDED_PTYS; i++) {
    forwardSessionLifecycle(event('InitShell', `other-${i}`))
  }
  let rebound = false
  const unsubscribe = sessionStore.subscribe(() => {
    if (rebound || sessionStore.read('a').trusted) return
    rebound = true
    useTerminalStore.getState().setTerminalPtyId('t', 'new-p')
  })
  try {
    forwardSessionLifecycle(event('InitShell', 'new-p'))
    forwardSessionLifecycle(event('PromptReady', 'new-p'))
    expect(rebound).toBe(true)
    expect(sessionStore.read('t')).toMatchObject({
      registered: true,
      trusted: true,
      mode: 'Editor'
    })
    expect(commandDraftStore.read('t')).toBe('keep me')
  } finally {
    unsubscribe()
  }
})

function watchNestedFallbackMemory(): { assertMemory: () => void; restore: () => void } {
  let state: {
    pending: Map<string, unknown>
    discarded: Set<string>
    invalidatePending: Set<string>
  }
  let queue: unknown[] | undefined
  const forward = LifecycleBuffer.prototype.forward
  vi.spyOn(LifecycleBuffer.prototype, 'forward').mockImplementation(function (
    this: LifecycleBuffer,
    event
  ) {
    if (!state) {
      state = this as unknown as typeof state
      for (const entries of [state.discarded, state.invalidatePending]) {
        const add = entries.add
        vi.spyOn(entries, 'add').mockImplementation(function (this: Set<string>, value) {
          const result = add.call(this, value)
          expect(this.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS + 1)
          return result
        })
      }
      const set = state.pending.set
      vi.spyOn(state.pending, 'set').mockImplementation(function (
        this: Map<string, unknown>,
        key,
        value
      ) {
        const result = set.call(this, key, value)
        expect(this.size).toBeLessThanOrEqual(MAX_PENDING_PTYS + 1)
        return result
      })
    }
    forward.call(this, event)
  })
  const shift = Array.prototype.shift
  Array.prototype.shift = function (this: unknown[]) {
    if (this[0] === 'a' && this.includes('t')) queue = this
    return shift.call(this)
  }
  const assertMemory = () => {
    expect(queue).toBeDefined()
    expect(queue).toHaveLength(0)
    expect(state.pending.size).toBeLessThanOrEqual(MAX_PENDING_PTYS)
    expect(state.discarded.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS)
    expect(state.invalidatePending.size).toBeLessThanOrEqual(MAX_DISCARDED_PTYS)
  }
  return {
    assertMemory,
    restore: () => {
      Array.prototype.shift = shift
    }
  }
}

function discardLiveDuringFallback(): void {
  disposeSessionAdapter()
  useTerminalStore
    .getState()
    .setTerminals([
      mockTerminal({ id: 'a', ptyId: null }),
      mockTerminal({ id: 't', ptyId: null }),
      mockTerminal({ id: 'live', ptyId: 'live-p' })
    ])
  for (const id of ['a', 't', 'live']) seedEditor(id)
  forwardSessionLifecycle(event('InitShell', 'p'))
  let nested = false
  const unsubscribe = sessionStore.subscribe(() => {
    if (nested || sessionStore.read('a').trusted) return
    nested = true
    useTerminalStore.getState().clearTerminalPtyId('live-p')
    forwardSessionLifecycle(event('InitShell', 'live-p'))
    forwardSessionLifecycle(event('Desync', 'live-p'))
    for (let i = 0; i < MAX_PENDING_PTYS + MAX_DISCARDED_PTYS; i++) {
      forwardSessionLifecycle(event('InitShell', `nested-${i}`))
    }
  })
  try {
    for (let i = 0; i < MAX_PENDING_PTYS + MAX_DISCARDED_PTYS; i++) {
      forwardSessionLifecycle(event('InitShell', `outer-${i}`))
    }
    expect(nested).toBe(true)
  } finally {
    unsubscribe()
  }
}

it('covers history discarded after the outer fallback scan and drains its bounded queue', () => {
  const memory = watchNestedFallbackMemory()
  try {
    discardLiveDuringFallback()
    memory.assertMemory()
  } finally {
    memory.restore()
  }
  useTerminalStore.getState().setTerminalPtyId('live', 'live-p')
  for (const id of ['live', 'a', 't']) {
    expect(sessionStore.read(id).registered).toBe(false)
    expect(sessionStore.read(id).trusted).toBe(false)
    expect(sessionStore.read(id).mode).not.toBe('Editor')
    expect(sessionStore.beginSubmit(id)).toBeNull()
    expect(commandDraftStore.read(id)).toBe('keep me')
  }
  forwardSessionLifecycle(event('Desync', 'live-p'))
  forwardSessionLifecycle(event('PromptReady', 'live-p', 2))
  expect(sessionStore.read('live').mode).not.toBe('Editor')
  expect(sessionStore.beginSubmit('live')).toBeNull()
  forwardSessionLifecycle(event('InitShell', 'live-p'))
  forwardSessionLifecycle(event('PromptReady', 'live-p', 2))
  expect(sessionStore.read('live')).toMatchObject({
    registered: true,
    trusted: true,
    mode: 'Editor'
  })
  expect(commandDraftStore.read('live')).toBe('keep me')
})
