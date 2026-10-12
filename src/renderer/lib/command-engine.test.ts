import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpTransportError, COMMAND_ACCEPTED_CODE, COMMAND_IN_PROGRESS_CODE } from './acp-transport'
import {
  __detachedCommandCountForTesting,
  __resetCommandEngineForTesting,
  abandonDetached,
  beginDetachedCommand,
  COMMAND_RESEND_DELAYS_MS,
  getCommandState,
  getDetachedState,
  recheckDetached,
  resendDetached,
  runCommand
} from './command-engine'
import {
  __resetCommandJournalForTesting,
  findUnresolvedCommand,
  listUnresolvedCommands,
  openCommand
} from './command-journal'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const drop = (): AcpTransportError => new AcpTransportError('closed', 'WebSocket closed')
const rejection = (): AcpTransportError => new AcpTransportError('not_found', 'no such session')
const NO_WAIT = [0, 0, 0] as const

describe('command engine: awaited commands', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    __resetCommandJournalForTesting()
    __resetCommandEngineForTesting()
  })

  it('persists the id BEFORE the first send', async () => {
    let journaledAtSend: string | undefined
    await runCommand({
      kind: 'close_session',
      entityKey: 'a|s1',
      send: async ({ commandId }) => {
        journaledAtSend = findUnresolvedCommand('close_session', 'a|s1')?.commandId
        expect(commandId).toBe(journaledAtSend)
      }
    })
    expect(journaledAtSend).toBeTruthy()
  })

  it('a lost reply goes pending-reconcile, resends the SAME id, and resolves accepted', async () => {
    const ids: string[] = []
    const run = await runCommand({
      kind: 'create_session',
      entityKey: 'a|/w|',
      delaysMs: NO_WAIT,
      send: async ({ commandId }) => {
        ids.push(commandId ?? '')
        if (ids.length === 1) {
          // The command is unresolved (and never rejected) while the reply is lost.
          throw drop()
        }
        return { sessionId: 's1' }
      }
    })
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(run.result).toEqual({ sessionId: 's1' })
    expect(run.resent).toBe(true)
    expect(getCommandState(ids[0])?.phase).toBe('accepted')
    expect(listUnresolvedCommands()).toHaveLength(0)
  })

  it('a transport loss is never rejected: with the ladder spent the error surfaces and the id stays for the next try', async () => {
    const ids: string[] = []
    const send = async ({ commandId }: { commandId?: string }): Promise<string> => {
      ids.push(commandId ?? '')
      throw drop()
    }
    await expect(
      runCommand({ kind: 'close_session', entityKey: 'a|s1', delaysMs: [0], send })
    ).rejects.toMatchObject({ code: 'closed' })
    expect(ids).toHaveLength(2)
    expect(getCommandState(ids[0])?.phase).toBe('pending-reconcile')
    expect(listUnresolvedCommands().map((e) => e.commandId)).toEqual([ids[0]])

    // Retry from pending-reconcile REUSES the id.
    await runCommand({
      kind: 'close_session',
      entityKey: 'a|s1',
      send: async ({ commandId }) => {
        ids.push(commandId ?? '')
      }
    })
    expect(ids[2]).toBe(ids[0])
  })

  it('a definite rejection ends the command; a retry mints a NEW id', async () => {
    const ids: string[] = []
    const failing = {
      kind: 'create_session',
      entityKey: 'a|/w|',
      send: async ({ commandId }: { commandId?: string }): Promise<string> => {
        ids.push(commandId ?? '')
        throw rejection()
      }
    }
    await expect(runCommand(failing)).rejects.toMatchObject({ code: 'not_found' })
    expect(getCommandState(ids[0])?.phase).toBe('rejected')
    expect(listUnresolvedCommands()).toHaveLength(0)
    await expect(runCommand(failing)).rejects.toMatchObject({ code: 'not_found' })
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('outcome_unknown stays pending-reconcile (never rejected, never auto-resent); the next try is a new intent', async () => {
    const ids: string[] = []
    const send = async ({ commandId }: { commandId?: string }): Promise<string> => {
      ids.push(commandId ?? '')
      throw new AcpTransportError(WS_ERROR_CODES.OUTCOME_UNKNOWN, 'unknown')
    }
    await expect(
      runCommand({ kind: 'close_session', entityKey: 'a|s1', delaysMs: NO_WAIT, send })
    ).rejects.toMatchObject({ code: WS_ERROR_CODES.OUTCOME_UNKNOWN })
    expect(ids).toHaveLength(1)
    expect(getCommandState(ids[0])).toMatchObject({
      phase: 'pending-reconcile',
      outcomeUnknown: true
    })
    expect(listUnresolvedCommands().map((e) => e.commandId)).toEqual([ids[0]])

    await expect(
      runCommand({ kind: 'close_session', entityKey: 'a|s1', delaysMs: NO_WAIT, send })
    ).rejects.toMatchObject({ code: WS_ERROR_CODES.OUTCOME_UNKNOWN })
    expect(ids[1]).not.toBe(ids[0])
  })

  it('an in_progress answer stays pending and resends the same id until the host answers', async () => {
    const ids: string[] = []
    const run = await runCommand({
      kind: 'load_session',
      entityKey: 'a|s1|/w',
      delaysMs: NO_WAIT,
      send: async ({ commandId, onVisibleAt }) => {
        ids.push(commandId ?? '')
        if (ids.length < 3) throw new AcpTransportError(COMMAND_IN_PROGRESS_CODE, 'still running')
        onVisibleAt?.(7)
        return {}
      }
    })
    expect(new Set(ids).size).toBe(1)
    expect(ids).toHaveLength(3)
    // The reply's visible_at is surfaced for the UI gate.
    expect(run.visibleAt).toBe(7)
  })

  it('command_accepted resolves as accepted: a no-result op succeeds, a result-needing op surfaces it', async () => {
    const accepted = (): Promise<never> =>
      Promise.reject(new AcpTransportError(COMMAND_ACCEPTED_CODE, 'ran; result not retained'))
    const run = await runCommand({
      kind: 'load_session',
      entityKey: 'a|s1|/w',
      send: accepted,
      acceptedWithoutResult: () => ({ ok: true })
    })
    expect(run.result).toEqual({ ok: true })
    await expect(
      runCommand({ kind: 'spawn_agent', entityKey: 'c|n|cmd', send: accepted })
    ).rejects.toMatchObject({ code: COMMAND_ACCEPTED_CODE })
    expect(listUnresolvedCommands()).toHaveLength(0)
  })

  it('concurrent tries of one intent are different commands (two creates are two sessions)', async () => {
    const ids: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = async ({ commandId }: { commandId?: string }): Promise<void> => {
      ids.push(commandId ?? '')
      await gate
    }
    const a = runCommand({ kind: 'create_session', entityKey: 'k', send })
    const b = runCommand({ kind: 'create_session', entityKey: 'k', send })
    release()
    await Promise.all([a, b])
    expect(new Set(ids).size).toBe(2)
  })

  it('`fresh` never reuses an earlier unresolved id (content the key cannot name)', async () => {
    const ids: string[] = []
    const drops = (opts: { fresh?: boolean }) =>
      runCommand({
        kind: 'acp_deliver_auth_redirect',
        entityKey: 'a',
        delaysMs: [],
        fresh: opts.fresh,
        send: async ({ commandId }) => {
          ids.push(commandId ?? '')
          throw drop()
        }
      }).catch(() => undefined)
    await drops({ fresh: true })
    await drops({ fresh: true })
    expect(ids[1]).not.toBe(ids[0])
  })

  it('an unresolved id is reused after a page reload (the journal survives)', async () => {
    const ids: string[] = []
    const lost = {
      kind: 'create_session',
      entityKey: 'a|/w|',
      delaysMs: [] as number[],
      send: async ({ commandId }: { commandId?: string }): Promise<string> => {
        ids.push(commandId ?? '')
        throw drop()
      }
    }
    await expect(runCommand(lost)).rejects.toBeDefined()
    // Reload: module memory is gone, storage remains.
    __resetCommandJournalForTesting()
    __resetCommandEngineForTesting()
    await expect(runCommand(lost)).rejects.toBeDefined()
    expect(ids[1]).toBe(ids[0])
  })

  it('a concurrent run that succeeds never un-journals the id of a sibling still in flight', async () => {
    const ids: Record<string, string> = {}
    let releaseA!: () => void
    let failB!: () => void
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const gateB = new Promise<void>((resolve) => {
      failB = resolve
    })
    const a = runCommand({
      kind: 'create_session',
      entityKey: 'k',
      send: async ({ commandId }) => {
        ids.a = commandId ?? ''
        await gateA
      }
    })
    const b = runCommand({
      kind: 'create_session',
      entityKey: 'k',
      delaysMs: [],
      send: async ({ commandId }) => {
        ids.b = commandId ?? ''
        await gateB
        throw drop()
      }
    })
    releaseA()
    await a
    // A resolved while B is still waiting for its reply: B's id stays journaled.
    expect(listUnresolvedCommands().map((e) => e.commandId)).toEqual([ids.b])
    failB()
    await expect(b).rejects.toMatchObject({ code: 'closed' })

    const next: string[] = []
    await runCommand({
      kind: 'create_session',
      entityKey: 'k',
      send: async ({ commandId }) => {
        next.push(commandId ?? '')
      }
    })
    expect(next[0]).toBe(ids.b)
  })

  it('outcome_unknown is persisted: after a reload the next awaited try is a NEW intent with a new id', async () => {
    const ids: string[] = []
    const send = async ({ commandId }: { commandId?: string }): Promise<void> => {
      ids.push(commandId ?? '')
      if (ids.length === 1) throw new AcpTransportError(WS_ERROR_CODES.OUTCOME_UNKNOWN, 'x')
    }
    const unknown = { kind: 'close_session', entityKey: 'a|s1', delaysMs: NO_WAIT, send }
    await expect(runCommand(unknown)).rejects.toMatchObject({ code: 'outcome_unknown' })
    expect(listUnresolvedCommands()[0]).toMatchObject({ commandId: ids[0], outcomeUnknown: true })

    // Reload: memory gone, the journal entry (with its flag) survives.
    __resetCommandJournalForTesting()
    __resetCommandEngineForTesting()
    await runCommand(unknown)
    expect(ids[1]).not.toBe(ids[0])
    // The stale unknown entry is dropped once the user's new try resolves.
    expect(listUnresolvedCommands()).toHaveLength(0)
  })

  it('shows the spec label for an outcome_unknown error', async () => {
    await expect(
      runCommand({
        kind: 'close_session',
        entityKey: 'a|s1',
        send: async () => {
          throw new AcpTransportError(WS_ERROR_CODES.OUTCOME_UNKNOWN, 'host wording')
        }
      })
    ).rejects.toThrow('Outcome unknown — check whether it took effect')
  })
})

describe('command engine: detached commands (prompt turn waiting to confirm)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.sessionStorage.clear()
    __resetCommandJournalForTesting()
    __resetCommandEngineForTesting()
  })
  afterEach(() => vi.useRealTimers())

  function begin(resend: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
    const onResult = vi.fn()
    const onDefiniteFailure = vi.fn()
    beginDetachedCommand({
      scope: 's1',
      commandId: 'turn-1',
      kind: 'send_prompt',
      entityKey: 's1',
      resend,
      onResult,
      onDefiniteFailure,
      ...extra
    })
    return { onResult, onDefiniteFailure }
  }

  it('resends the same id on the backoff ladder and resolves accepted on the answer', async () => {
    const resend = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(drop())
      .mockResolvedValue('receipt')
    const { onResult } = begin(resend)
    expect(getDetachedState('s1')?.phase).toBe('pending-reconcile')
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(resend).toHaveBeenCalledTimes(1)
    expect(getDetachedState('s1')?.phase).toBe('pending-reconcile')
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[1])
    expect(onResult).toHaveBeenCalledWith('receipt')
    expect(getDetachedState('s1')).toBeUndefined()
    expect(getCommandState('turn-1')?.phase).toBe('accepted')
  })

  it('an in_progress answer keeps it pending; only a definite error rejects', async () => {
    const resend = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new AcpTransportError(COMMAND_IN_PROGRESS_CODE, 'running'))
      .mockRejectedValueOnce(rejection())
    const { onDefiniteFailure } = begin(resend)
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(getDetachedState('s1')?.phase).toBe('pending-reconcile')
    expect(onDefiniteFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[1])
    expect(onDefiniteFailure).toHaveBeenCalledTimes(1)
    expect(getCommandState('turn-1')?.phase).toBe('rejected')
  })

  it('outcome_unknown holds: no automatic resend (timer or recovery), a manual re-check asks again with the same id', async () => {
    const resend = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new AcpTransportError(WS_ERROR_CODES.OUTCOME_UNKNOWN, 'unknown'))
      .mockResolvedValue('accepted')
    const { onResult } = begin(resend)
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(resend).toHaveBeenCalledTimes(1)
    expect(getDetachedState('s1')).toMatchObject({
      phase: 'pending-reconcile',
      outcomeUnknown: true
    })

    await vi.advanceTimersByTimeAsync(10 * COMMAND_RESEND_DELAYS_MS[3])
    resendDetached()
    expect(resend).toHaveBeenCalledTimes(1)

    expect(recheckDetached('s1')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(resend).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledWith('accepted')
  })

  it('an outcome_unknown first answer starts held: the timer never fires', async () => {
    const resend = vi.fn<() => Promise<unknown>>().mockResolvedValue('x')
    begin(resend, { outcomeUnknown: true })
    await vi.advanceTimersByTimeAsync(10 * COMMAND_RESEND_DELAYS_MS[3])
    expect(resend).not.toHaveBeenCalled()
    expect(getDetachedState('s1')?.outcomeUnknown).toBe(true)
  })

  it('keeps one resend in flight and waits out a transport reconnect', async () => {
    let blocked = true
    let finish!: (v: unknown) => void
    const resend = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve
        })
    )
    begin(resend, { isBlocked: () => blocked })
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(resend).not.toHaveBeenCalled()
    blocked = false
    resendDetached('s1')
    resendDetached('s1')
    resendDetached()
    expect(resend).toHaveBeenCalledTimes(1)
    finish('ok')
    await vi.advanceTimersByTimeAsync(0)
    expect(__detachedCommandCountForTesting()).toBe(0)
  })

  it('Stop abandons: no later resend, and a resend already in flight reports back to cancel again', async () => {
    let finish!: (v: unknown) => void
    const resend = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve
        })
    )
    const { onResult } = begin(resend)
    resendDetached('s1')
    const afterSettles = vi.fn()
    expect(abandonDetached('s1', afterSettles)).toBe('turn-1')
    expect(getCommandState('turn-1')?.phase).toBe('rejected')
    finish('late')
    await vi.advanceTimersByTimeAsync(0)
    expect(afterSettles).toHaveBeenCalledTimes(1)
    expect(onResult).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10 * COMMAND_RESEND_DELAYS_MS[3])
    expect(resend).toHaveBeenCalledTimes(1)
  })

  it('drops the command when its scope is gone', async () => {
    let gone = false
    const resend = vi.fn<() => Promise<unknown>>().mockResolvedValue('x')
    begin(resend, { isGone: () => gone })
    gone = true
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(resend).not.toHaveBeenCalled()
    expect(__detachedCommandCountForTesting()).toBe(0)
  })

  it('a manual re-check publishes an in-flight flag until the resend settles', async () => {
    const seen: Array<{ checking?: boolean } | null> = []
    let finish!: (error: unknown) => void
    const resend = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new AcpTransportError(WS_ERROR_CODES.OUTCOME_UNKNOWN, 'x'))
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            finish = reject
          })
      )
    begin(resend, { onChange: (state: { checking?: boolean } | null) => seen.push(state) })
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(getDetachedState('s1')?.checking).toBeFalsy()
    recheckDetached('s1')
    expect(getDetachedState('s1')?.checking).toBe(true)
    expect(seen.at(-1)?.checking).toBe(true)
    finish(new AcpTransportError(WS_ERROR_CODES.OUTCOME_UNKNOWN, 'x'))
    await vi.advanceTimersByTimeAsync(0)
    expect(getDetachedState('s1')).toMatchObject({ checking: false, outcomeUnknown: true })
    expect(seen.at(-1)?.checking).toBe(false)
  })

  it('a different command replacing the scope resolves the replaced one (state, journal, no resend)', async () => {
    const first = openCommand('send_prompt', 's1')
    const resendFirst = vi.fn<() => Promise<unknown>>().mockResolvedValue('x')
    beginDetachedCommand({
      scope: 's1',
      commandId: first.commandId,
      kind: 'send_prompt',
      entityKey: 's1',
      resend: resendFirst,
      onResult: vi.fn(),
      onDefiniteFailure: vi.fn()
    })
    const second = openCommand('send_prompt', 's1')
    beginDetachedCommand({
      scope: 's1',
      commandId: second.commandId,
      kind: 'send_prompt',
      entityKey: 's1',
      resend: vi.fn<() => Promise<unknown>>().mockReturnValue(new Promise(() => {})),
      onResult: vi.fn(),
      onDefiniteFailure: vi.fn()
    })
    expect(getCommandState(first.commandId)?.phase).toBe('rejected')
    expect(listUnresolvedCommands().map((e) => e.commandId)).toEqual([second.commandId])
    await vi.advanceTimersByTimeAsync(COMMAND_RESEND_DELAYS_MS[0])
    expect(resendFirst).not.toHaveBeenCalled()
  })
})
