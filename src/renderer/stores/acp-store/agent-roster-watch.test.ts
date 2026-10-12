import type { AgentsWatchDelta, WsAgentSummary } from '@shared/types/web-protocol.types'
import { describe, expect, it, vi } from 'vitest'
import type { WatchClient, WatchHandlers } from '@/lib/acp-transport/watch-client'
import { attachAgentRosterWatch } from './agent-roster-watch'
import type { AcpState } from './types'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

const capabilities = { loadSession: true } as unknown as WsAgentSummary['capabilities']

function setup(held: { agents?: string[]; connected?: string[] } = {}) {
  const state = {
    agents: Object.fromEntries((held.agents ?? []).map((id) => [id, { id }])),
    agentStatus: Object.fromEntries(
      (held.agents ?? []).map((id) => [
        id,
        (held.connected ?? held.agents ?? []).includes(id) ? 'connected' : 'error'
      ])
    ),
    _onAgentSpawned: vi.fn(),
    _onAgentCrashed: vi.fn(),
    _onAgentError: vi.fn(),
    _onAgentDisconnected: vi.fn()
  }
  let handlers: WatchHandlers<WsAgentSummary[], AgentsWatchDelta> | null = null
  const watches = {
    subscribe: vi.fn((_watch: string, h: WatchHandlers<WsAgentSummary[], AgentsWatchDelta>) => {
      handlers = h
      return () => {}
    })
  } as unknown as WatchClient
  attachAgentRosterWatch(watches, () => state as unknown as AcpState)
  return { state, watches, handlers: () => handlers as NonNullable<typeof handlers> }
}

describe('attachAgentRosterWatch', () => {
  it('watches the agents watch', () => {
    const { watches } = setup()
    expect(watches.subscribe).toHaveBeenCalledWith('agents', expect.any(Object))
  })

  it('routes each roster delta to the reducer a desktop event reaches', () => {
    const { state, handlers } = setup()
    handlers().onDelta?.({ event: 'agent_spawned', payload: { agentId: 'a1', capabilities } })
    handlers().onDelta?.({ event: 'agent_crashed', payload: { agentId: 'a1', message: 'died' } })
    handlers().onDelta?.({ event: 'agent_error', payload: { agentId: 'a1', message: 'oops' } })
    handlers().onDelta?.({ event: 'agent_disconnected', payload: { agentId: 'a1' } })

    expect(state._onAgentSpawned).toHaveBeenCalledWith({ agentId: 'a1', capabilities })
    expect(state._onAgentCrashed).toHaveBeenCalledWith({ agentId: 'a1', message: 'died' })
    expect(state._onAgentError).toHaveBeenCalledWith({ agentId: 'a1', message: 'oops' })
    expect(state._onAgentDisconnected).toHaveBeenCalledWith({ agentId: 'a1' })
    expect(toastError).toHaveBeenCalledWith('died')
    expect(toastError).toHaveBeenCalledWith('oops')
  })

  it('disconnects a connected agent the host removed, and leaves one already cleaned up alone', () => {
    const { state, handlers } = setup({ agents: ['other', 'mine'], connected: ['other'] })
    handlers().onDelta?.({ event: 'agent_removed', payload: { agentId: 'other' } })
    handlers().onDelta?.({ event: 'agent_removed', payload: { agentId: 'mine' } })
    expect(state._onAgentDisconnected).toHaveBeenCalledTimes(1)
    expect(state._onAgentDisconnected).toHaveBeenCalledWith({ agentId: 'other' })
  })

  it('reconciles the full state: spawns the unknown, disconnects the connected agent the host dropped', () => {
    const { state, handlers } = setup({ agents: ['kept', 'gone'] })
    handlers().onState([
      { id: 'kept', name: 'Kept', capabilities },
      { id: 'new', name: 'New', capabilities }
    ])

    expect(state._onAgentSpawned).toHaveBeenCalledTimes(1)
    expect(state._onAgentSpawned).toHaveBeenCalledWith({ agentId: 'new', capabilities })
    expect(state._onAgentDisconnected).toHaveBeenCalledTimes(1)
    expect(state._onAgentDisconnected).toHaveBeenCalledWith({ agentId: 'gone' })
  })

  it('leaves an agent that already errored alone when the host no longer lists it', () => {
    const { state, handlers } = setup({ agents: ['dead'], connected: [] })
    handlers().onState([])
    expect(state._onAgentDisconnected).not.toHaveBeenCalled()
  })

  it('ignores a summary or delta without an agent id', () => {
    const { state, handlers } = setup()
    handlers().onState([{ name: 'No id', capabilities } as unknown as WsAgentSummary])
    handlers().onDelta?.({ event: 'agent_spawned', payload: {} })
    expect(state._onAgentSpawned).not.toHaveBeenCalled()
  })

  it('ignores a delta of an unknown kind', () => {
    const { state, handlers } = setup()
    handlers().onDelta?.({
      event: 'agent_teleported',
      payload: { agentId: 'a1' }
    } as unknown as AgentsWatchDelta)
    expect(state._onAgentSpawned).not.toHaveBeenCalled()
  })
})
