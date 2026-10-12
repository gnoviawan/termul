import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: vi.fn(() => false) }))

import { AcpTransportError } from '@/lib/acp-transport/types'
import { _resetDefiniteSpawnRejectionsForTesting, ensureLiveAgent } from './shared-state'
import type { AcpState } from './types'

type Config = AcpState['agentConfigs'][number]

function makeStore(config: Partial<Config> = {}) {
  const state = {
    agentConfigs: [
      {
        id: 'cfg-1',
        name: 'Ghost',
        command: 'ghost-agent',
        args: [],
        env: {},
        allowTerminal: false,
        ...config
      }
    ],
    configToLiveAgent: {},
    agentStatus: {},
    sessions: {},
    warmingConfigs: {},
    spawnAgent: vi.fn(),
    killAgent: vi.fn()
  }
  const get = () => state as unknown as AcpState
  const set = (fn: (s: AcpState) => Partial<AcpState> | AcpState) => {
    Object.assign(state, fn(state as unknown as AcpState))
  }
  return { state, get, set }
}

describe('ensureLiveAgent — definite host spawn rejections (AD-5)', () => {
  beforeEach(() => {
    _resetDefiniteSpawnRejectionsForTesting()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('does not re-issue a rejected silent spawn for an unchanged config, but a user spawn tries again', async () => {
    const { state, get, set } = makeStore()
    state.spawnAgent.mockRejectedValue(new AcpTransportError('agent_unavailable', 'not installed'))

    expect(await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })).toBeNull()
    expect(await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })).toBeNull()
    expect(state.spawnAgent).toHaveBeenCalledTimes(1)

    await expect(ensureLiveAgent(get, set, 'cfg-1', '/w')).rejects.toMatchObject({
      code: 'agent_unavailable'
    })
    expect(state.spawnAgent).toHaveBeenCalledTimes(2)
  })

  it('recognises the desktop prefix form and lets an edited config spawn again', async () => {
    const { state, get, set } = makeStore()
    state.spawnAgent.mockRejectedValueOnce('ACP_INVALID_AGENT_CONFIG: empty command')
    await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    expect(state.spawnAgent).toHaveBeenCalledTimes(1)

    state.agentConfigs[0].command = 'fixed-agent'
    state.spawnAgent.mockResolvedValueOnce('agent-1')
    expect(await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })).toBe(
      'agent-1'
    )
    expect(state.spawnAgent).toHaveBeenCalledTimes(2)
  })

  it('keeps swallowing transient silent failures and retries them', async () => {
    const { state, get, set } = makeStore()
    state.spawnAgent.mockRejectedValue(new AcpTransportError('timeout', 'slow'))
    await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    expect(state.spawnAgent).toHaveBeenCalledTimes(2)
  })

  it('surfaces a definite rejection to callers that ask for it, even when silent', async () => {
    const { state, get, set } = makeStore()
    state.spawnAgent.mockRejectedValue(new AcpTransportError('agent_unavailable', 'not installed'))
    await expect(
      ensureLiveAgent(get, set, 'cfg-1', '/w', {
        silentSpawnFailure: true,
        surfaceDefiniteRejection: true
      })
    ).rejects.toMatchObject({ code: 'agent_unavailable' })
    // The user's retry is a new intent: the recorded rejection never blocks it.
    await expect(
      ensureLiveAgent(get, set, 'cfg-1', '/w', {
        silentSpawnFailure: true,
        surfaceDefiniteRejection: true
      })
    ).rejects.toMatchObject({ code: 'agent_unavailable' })
    expect(state.spawnAgent).toHaveBeenCalledTimes(2)
  })

  it('a history reopen joining a prewarm surfaces its definite rejection; the prewarm itself stays silent', async () => {
    const { state, get, set } = makeStore()
    let reject!: (error: unknown) => void
    state.spawnAgent.mockReturnValue(
      new Promise((_, rej) => {
        reject = rej
      })
    )
    const prewarm = ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    const reopen = ensureLiveAgent(get, set, 'cfg-1', '/w', {
      silentSpawnFailure: true,
      surfaceDefiniteRejection: true
    })
    const reopenOutcome = reopen.then(
      () => 'resolved',
      (error: unknown) => error
    )
    reject(new AcpTransportError('agent_unavailable', 'not installed'))
    expect(await prewarm).toBeNull()
    expect(await reopenOutcome).toMatchObject({ code: 'agent_unavailable' })
    expect(state.spawnAgent).toHaveBeenCalledTimes(1)
  })

  it('an edited agent NAME is a different launch for the recorded-rejection check', async () => {
    const { state, get, set } = makeStore()
    state.spawnAgent.mockRejectedValue(new AcpTransportError('invalid_agent_config', 'bad'))
    await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    expect(state.spawnAgent).toHaveBeenCalledTimes(1)
    state.agentConfigs[0].name = 'Renamed'
    await ensureLiveAgent(get, set, 'cfg-1', '/w', { silentSpawnFailure: true })
    expect(state.spawnAgent).toHaveBeenCalledTimes(2)
  })
})
