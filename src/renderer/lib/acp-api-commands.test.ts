import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import {
  acpAnswerQuestion,
  acpAuthenticate,
  acpCloseSession,
  acpDeliverAuthRedirect,
  acpLoadSession,
  acpNewSession,
  acpRespondPermission,
  acpSpawnAgent
} from './acp-api'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport,
  AcpTransportError,
  COMMAND_ACCEPTED_CODE,
  type CommandCallOptions
} from './acp-transport'
import { __resetCommandEngineForTesting, AWAITED_RESEND_DELAYS_MS } from './command-engine'
import { __resetCommandJournalForTesting } from './command-journal'

/**
 * The carrier boundary: every ledgered transport method records `(request type,
 * { commandId })` here, and each test scripts what the carrier answers. The
 * engine is carrier-agnostic (desktop now speaks the same `/ws` protocol as the
 * browser), so one recording transport covers both.
 */
const sent = vi.fn<(type: string, args: { commandId?: string }) => Promise<unknown>>()
const record = (type: string, options?: CommandCallOptions) =>
  sent(type, { commandId: options?.commandId })
const recordingTransport = {
  spawnAgent: (_config: unknown, options?: CommandCallOptions) => record('spawn_agent', options),
  newSession: (_a: unknown, _c: unknown, _m: unknown, options?: CommandCallOptions) =>
    record('create_session', options),
  closeSession: (_a: unknown, _s: unknown, options?: CommandCallOptions) =>
    record('close_session', options),
  authenticate: (_a: unknown, _m: unknown, _g: unknown, options?: CommandCallOptions) =>
    record('authenticate_agent', options),
  deliverAuthRedirect: (_a: unknown, _u: unknown, options?: CommandCallOptions) =>
    record('acp_deliver_auth_redirect', options),
  respondPermission: (_a: unknown, _r: unknown, _o: unknown, options?: CommandCallOptions) =>
    record('respond_permission', options),
  answerQuestion: (_a: unknown, _q: unknown, _v: unknown, options?: CommandCallOptions) =>
    record('answer_question', options),
  dispose: () => {}
}
const commandIds = (type: string): string[] =>
  sent.mock.calls
    .filter(([name]) => name === type)
    .map(([, args]) => {
      // A call without a commandId is a failure, not an id to compare.
      if (typeof args.commandId !== 'string' || args.commandId.length === 0) {
        throw new Error(`${type} was sent without a commandId`)
      }
      return args.commandId
    })

describe('acp-api ledgered commands', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.localStorage.clear()
    __resetCommandJournalForTesting()
    __resetCommandEngineForTesting()
    sent.mockReset()
    _setAcpTransportForTests(recordingTransport as unknown as AcpTransport)
  })
  afterEach(() => {
    vi.useRealTimers()
    _resetAcpTransportForTests(null)
  })

  it('a lost reply is resent with the SAME commandId; the entity-lookup receipt is flagged', async () => {
    sent
      .mockRejectedValueOnce(new AcpTransportError('closed', 'ipc dropped'))
      // The host answers the resend from the entity the first attempt created.
      .mockResolvedValueOnce({ sessionId: 's-created' })
    const created = acpNewSession('agent-1', '/w', [], { projectId: 'p1' })
    await vi.advanceTimersByTimeAsync(AWAITED_RESEND_DELAYS_MS[0])
    const outcome = await created
    const ids = commandIds('create_session')
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    // `{ sessionId }` from a resend says nothing about the session's state: the
    // store must open it from history instead of building it from this reply.
    expect(outcome).toEqual({ sessionId: 's-created', lookup: true })
  })

  it('a first-attempt reply is authoritative even when it carries no options', async () => {
    sent.mockResolvedValueOnce({ sessionId: 's1' })
    expect(await acpNewSession('agent-1', '/w', [])).toEqual({ sessionId: 's1' })
  })

  it('maps a definite spawn rejection and mints a NEW id on the retry (never auto-retried)', async () => {
    sent.mockRejectedValue(new AcpTransportError('agent_unavailable', 'program not found'))
    const config = { name: 'n', command: 'missing', args: [], env: {} }
    await expect(acpSpawnAgent(config)).rejects.toMatchObject({ code: 'agent_unavailable' })
    expect(commandIds('spawn_agent')).toHaveLength(1)
    await expect(acpSpawnAgent(config)).rejects.toMatchObject({ code: 'agent_unavailable' })
    const ids = commandIds('spawn_agent')
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('outcome_unknown surfaces to the caller without a resend', async () => {
    sent.mockRejectedValue(new AcpTransportError('outcome_unknown', 'no longer known'))
    await expect(acpCloseSession('agent-1', 's1')).rejects.toMatchObject({
      code: 'outcome_unknown'
    })
    expect(commandIds('close_session')).toHaveLength(1)
  })

  it('holds a reopened session back until its stream reached visible_at', async () => {
    let cursor = 3
    const transport = {
      loadSession: vi.fn(async (...args: unknown[]) => {
        const options = args[4] as { onVisibleAt?: (v: number) => void }
        options.onVisibleAt?.(6)
        return {}
      }),
      getSessionCursor: () => ({ lastSeq: cursor, logEpoch: 'e' }),
      dispose: () => {}
    }
    _setAcpTransportForTests(transport as unknown as AcpTransport)
    let settled = false
    const loading = acpLoadSession('agent-1', 's1', '/w').then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBe(false)
    cursor = 6
    await vi.advanceTimersByTimeAsync(50)
    await loading
    expect(settled).toBe(true)
  })

  /** Let the awaited resend ladder run out against a carrier that never answers. */
  async function exhaustLadder<T>(call: Promise<T>): Promise<unknown> {
    const settled = call.then(
      () => undefined,
      (error: unknown) => error
    )
    for (const delay of AWAITED_RESEND_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay)
    return settled
  }

  it('Allow then Deny after an uncertain Allow are different commands (new id); the same answer reuses its id', async () => {
    sent.mockRejectedValue(new AcpTransportError('closed', 'socket dropped'))
    const lostAllow = await exhaustLadder(acpRespondPermission('a1', 'req-1', 'allow'))
    expect(lostAllow).toMatchObject({ code: 'closed' })
    expect(new Set(commandIds('respond_permission')).size).toBe(1)

    // Same answer again: the id is reused (the host replays the original outcome).
    await exhaustLadder(acpRespondPermission('a1', 'req-1', 'allow'))
    expect(new Set(commandIds('respond_permission')).size).toBe(1)

    // A different answer is a different command.
    await exhaustLadder(acpRespondPermission('a1', 'req-1', 'deny'))
    expect(new Set(commandIds('respond_permission')).size).toBe(2)
  })

  it('approvals and answers claim and journal a command id on every carrier', async () => {
    sent.mockResolvedValue(undefined)
    await acpRespondPermission('a1', 'req-1', 'allow')
    await acpAnswerQuestion('a1', 'q-1', ['x'])
    expect(commandIds('respond_permission')).toHaveLength(1)
    expect(commandIds('answer_question')).toHaveLength(1)
  })

  it('an earlier ephemeral/probe create is never reused for a durable create', async () => {
    sent.mockRejectedValue(new AcpTransportError('closed', 'ipc dropped'))
    await exhaustLadder(acpNewSession('a1', '/w', [], { projectId: 'p1', ephemeral: true }))
    await exhaustLadder(acpNewSession('a1', '/w', [], { projectId: 'p1' }))
    expect(new Set(commandIds('create_session')).size).toBe(2)
  })

  it('credential-bearing commands never reuse an earlier id for different content', async () => {
    sent.mockRejectedValue(new AcpTransportError('closed', 'ipc dropped'))
    await exhaustLadder(acpAuthenticate('a1', 'api_key', { baseUrl: 'https://one', apiKey: 'k1' }))
    await exhaustLadder(acpAuthenticate('a1', 'api_key', { baseUrl: 'https://two', apiKey: 'k2' }))
    expect(new Set(commandIds('authenticate_agent')).size).toBe(2)

    await exhaustLadder(acpDeliverAuthRedirect('a1', 'http://localhost:1/cb?code=one'))
    await exhaustLadder(acpDeliverAuthRedirect('a1', 'http://localhost:1/cb?code=two'))
    expect(new Set(commandIds('acp_deliver_auth_redirect')).size).toBe(2)
  })

  it('a redirect delivery whose reply was lost resolves as delivered when the host says command_accepted', async () => {
    sent
      .mockRejectedValueOnce(new AcpTransportError('closed', 'ipc dropped'))
      .mockRejectedValueOnce(
        new AcpTransportError(COMMAND_ACCEPTED_CODE, 'the command ran; its result is not retained')
      )
    const delivering = acpDeliverAuthRedirect('a1', 'http://localhost:1/cb?code=x')
    await vi.advanceTimersByTimeAsync(AWAITED_RESEND_DELAYS_MS[0])
    await expect(delivering).resolves.toBe(200)
    const ids = commandIds('acp_deliver_auth_redirect')
    expect(ids[1]).toBe(ids[0])
  })

  it('outcome_unknown reads as the spec label', async () => {
    sent.mockRejectedValue(new AcpTransportError('outcome_unknown', 'whatever the host wrote'))
    await expect(acpCloseSession('a1', 's1')).rejects.toThrow(
      'Outcome unknown — check whether it took effect'
    )
  })

  it('a create with other MCP servers or roots, and a spawn with other args/env, is a different command', async () => {
    sent.mockRejectedValue(new AcpTransportError('closed', 'ipc dropped'))
    await exhaustLadder(acpNewSession('a1', '/w', [], { projectId: 'p1' }))
    await exhaustLadder(
      acpNewSession('a1', '/w', [{ type: 'http', name: 'm', url: 'https://x' }], {
        projectId: 'p1'
      })
    )
    await exhaustLadder(
      acpNewSession('a1', '/w', [], { projectId: 'p1', additionalDirectories: ['/extra'] })
    )
    expect(new Set(commandIds('create_session')).size).toBe(3)

    const config = { name: 'n', command: 'c', args: ['a'], env: { KEY: 'SECRET-1' } }
    await exhaustLadder(acpSpawnAgent(config))
    await exhaustLadder(acpSpawnAgent({ ...config, env: { KEY: 'SECRET-2' } }))
    await exhaustLadder(acpSpawnAgent({ ...config, args: ['b'] }))
    expect(new Set(commandIds('spawn_agent')).size).toBe(3)
    // The identical request is a resend: its id is reused.
    await exhaustLadder(acpSpawnAgent(config))
    expect(new Set(commandIds('spawn_agent')).size).toBe(3)
    // Nothing content-derived was persisted in the clear.
    expect(window.localStorage.getItem('termul.commandJournal') ?? '').not.toContain('SECRET')
  })
})
