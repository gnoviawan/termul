import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from '@/lib/tauri-runtime'
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
  AcpTransportError
} from './acp-transport'
import { __resetCommandEngineForTesting, AWAITED_RESEND_DELAYS_MS } from './command-engine'
import { __resetCommandJournalForTesting } from './command-journal'

const mockedInvoke = vi.mocked(invoke)
const commandIds = (command: string): string[] =>
  mockedInvoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => {
      const id = (args as { commandId?: string }).commandId
      // A call without a commandId is a failure, not an id to compare.
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`${command} was invoked without a commandId`)
      }
      return id
    })

describe('acp-api ledgered commands (Tauri carrier)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(isTauriContext).mockReturnValue(true)
    window.localStorage.clear()
    __resetCommandJournalForTesting()
    __resetCommandEngineForTesting()
    mockedInvoke.mockReset()
    _resetAcpTransportForTests(null)
  })
  afterEach(() => vi.useRealTimers())

  it('a lost reply is resent with the SAME commandId; the entity-lookup receipt is flagged', async () => {
    mockedInvoke
      .mockRejectedValueOnce(new AcpTransportError('closed', 'ipc dropped'))
      // The host answers the resend from the entity the first attempt created.
      .mockResolvedValueOnce({ sessionId: 's-created' })
    const created = acpNewSession('agent-1', '/w', [], { projectId: 'p1' })
    await vi.advanceTimersByTimeAsync(AWAITED_RESEND_DELAYS_MS[0])
    const outcome = await created
    const ids = commandIds('acp_new_session')
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    // `{ sessionId }` from a resend says nothing about the session's state: the
    // store must open it from history instead of building it from this reply.
    expect(outcome).toEqual({ sessionId: 's-created', lookup: true })
  })

  it('a first-attempt reply is authoritative even when it carries no options', async () => {
    mockedInvoke.mockResolvedValueOnce({ sessionId: 's1' })
    expect(await acpNewSession('agent-1', '/w', [])).toEqual({ sessionId: 's1' })
  })

  it('maps a definite spawn rejection and mints a NEW id on the retry (never auto-retried)', async () => {
    mockedInvoke.mockRejectedValue('ACP_AGENT_UNAVAILABLE: program not found')
    const config = { name: 'n', command: 'missing', args: [], env: {} }
    await expect(acpSpawnAgent(config)).rejects.toMatchObject({ code: 'agent_unavailable' })
    expect(commandIds('acp_spawn_agent')).toHaveLength(1)
    await expect(acpSpawnAgent(config)).rejects.toMatchObject({ code: 'agent_unavailable' })
    const ids = commandIds('acp_spawn_agent')
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('outcome_unknown surfaces to the caller without a resend', async () => {
    mockedInvoke.mockRejectedValue('outcome_unknown: no longer known')
    await expect(acpCloseSession('agent-1', 's1')).rejects.toMatchObject({
      code: 'outcome_unknown'
    })
    expect(commandIds('acp_close_session')).toHaveLength(1)
  })

  it('holds a reopened session back until its stream reached visible_at (WS carrier)', async () => {
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
    // The WS carrier (desktop sends no id for approvals: see the next test).
    vi.mocked(isTauriContext).mockReturnValue(false)
    const ids: string[] = []
    _setAcpTransportForTests({
      respondPermission: vi.fn(async (...args: unknown[]) => {
        ids.push((args[3] as { commandId: string }).commandId)
        throw new AcpTransportError('closed', 'socket dropped')
      }),
      dispose: () => {}
    } as unknown as AcpTransport)
    const lostAllow = await exhaustLadder(acpRespondPermission('a1', 'req-1', 'allow'))
    expect(lostAllow).toMatchObject({ code: 'closed' })
    expect(new Set(ids).size).toBe(1)

    // Same answer again: the id is reused (the host replays the original outcome).
    await exhaustLadder(acpRespondPermission('a1', 'req-1', 'allow'))
    expect(new Set(ids).size).toBe(1)

    // A different answer is a different command.
    await exhaustLadder(acpRespondPermission('a1', 'req-1', 'deny'))
    expect(new Set(ids).size).toBe(2)
  })

  it('desktop approvals/answers claim and journal no command id (the Tauri commands take none)', async () => {
    mockedInvoke.mockResolvedValue(undefined)
    await acpRespondPermission('a1', 'req-1', 'allow')
    await acpAnswerQuestion('a1', 'q-1', ['x'])
    const calls = mockedInvoke.mock.calls.filter(
      ([name]) => name === 'acp_respond_permission' || name === 'acp_answer_question'
    )
    expect(calls).toHaveLength(2)
    for (const [, args] of calls) expect(args).not.toHaveProperty('commandId')
    expect(window.localStorage.getItem('termul.commandJournal')).toBeNull()
  })

  it('an earlier ephemeral/probe create is never reused for a durable create', async () => {
    mockedInvoke.mockRejectedValue(new AcpTransportError('closed', 'ipc dropped'))
    await exhaustLadder(acpNewSession('a1', '/w', [], { projectId: 'p1', ephemeral: true }))
    await exhaustLadder(acpNewSession('a1', '/w', [], { projectId: 'p1' }))
    expect(new Set(commandIds('acp_new_session')).size).toBe(2)
  })

  it('credential-bearing commands never reuse an earlier id for different content', async () => {
    mockedInvoke.mockRejectedValue(new AcpTransportError('closed', 'ipc dropped'))
    await exhaustLadder(acpAuthenticate('a1', 'api_key', { baseUrl: 'https://one', apiKey: 'k1' }))
    await exhaustLadder(acpAuthenticate('a1', 'api_key', { baseUrl: 'https://two', apiKey: 'k2' }))
    expect(new Set(commandIds('acp_authenticate')).size).toBe(2)

    await exhaustLadder(acpDeliverAuthRedirect('a1', 'http://localhost:1/cb?code=one'))
    await exhaustLadder(acpDeliverAuthRedirect('a1', 'http://localhost:1/cb?code=two'))
    expect(new Set(commandIds('acp_auth_deliver_redirect')).size).toBe(2)
  })

  it('a redirect delivery whose reply was lost resolves as delivered when the host says command_accepted', async () => {
    mockedInvoke
      .mockRejectedValueOnce(new AcpTransportError('closed', 'ipc dropped'))
      .mockRejectedValueOnce('command_accepted: the command ran; its result is not retained')
    const delivering = acpDeliverAuthRedirect('a1', 'http://localhost:1/cb?code=x')
    await vi.advanceTimersByTimeAsync(AWAITED_RESEND_DELAYS_MS[0])
    await expect(delivering).resolves.toBe(200)
    const ids = commandIds('acp_auth_deliver_redirect')
    expect(ids[1]).toBe(ids[0])
  })

  it('outcome_unknown reads as the spec label', async () => {
    mockedInvoke.mockRejectedValue('outcome_unknown: whatever the host wrote')
    await expect(acpCloseSession('a1', 's1')).rejects.toThrow(
      'Outcome unknown — check whether it took effect'
    )
  })

  it('a create with other MCP servers or roots, and a spawn with other args/env, is a different command', async () => {
    mockedInvoke.mockRejectedValue(new AcpTransportError('closed', 'ipc dropped'))
    await exhaustLadder(acpNewSession('a1', '/w', [], { projectId: 'p1' }))
    await exhaustLadder(
      acpNewSession('a1', '/w', [{ type: 'http', name: 'm', url: 'https://x' }], {
        projectId: 'p1'
      })
    )
    await exhaustLadder(
      acpNewSession('a1', '/w', [], { projectId: 'p1', additionalDirectories: ['/extra'] })
    )
    expect(new Set(commandIds('acp_new_session')).size).toBe(3)

    const config = { name: 'n', command: 'c', args: ['a'], env: { KEY: 'SECRET-1' } }
    await exhaustLadder(acpSpawnAgent(config))
    await exhaustLadder(acpSpawnAgent({ ...config, env: { KEY: 'SECRET-2' } }))
    await exhaustLadder(acpSpawnAgent({ ...config, args: ['b'] }))
    expect(new Set(commandIds('acp_spawn_agent')).size).toBe(3)
    // The identical request is a resend: its id is reused.
    await exhaustLadder(acpSpawnAgent(config))
    expect(new Set(commandIds('acp_spawn_agent')).size).toBe(3)
    // Nothing content-derived was persisted in the clear.
    expect(window.localStorage.getItem('termul.commandJournal') ?? '').not.toContain('SECRET')
  })
})
