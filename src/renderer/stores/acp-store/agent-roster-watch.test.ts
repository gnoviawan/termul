import type { AgentsWatchDelta, WsAgentSummary } from '@shared/types/web-protocol.types'
import { describe, expect, it, vi } from 'vitest'
import type { WatchClient, WatchHandlers } from '@/lib/acp-transport/watch-client'
import { onAutomationChanged } from '@/lib/automation-api'
import { onBrowserPolicyChanged, onBrowserPolicyResync } from '@/lib/browser-policy-api'
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
    _onAgentDisconnected: vi.fn(),
    _onBrowserOpenRequest: vi.fn()
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
    handlers().onDelta?.({
      event: 'agent_disconnected',
      payload: { agentId: 'a1', reason: 'killed' }
    })

    expect(state._onAgentSpawned).toHaveBeenCalledWith({ agentId: 'a1', capabilities })
    expect(state._onAgentCrashed).toHaveBeenCalledWith({ agentId: 'a1', message: 'died' })
    expect(state._onAgentError).toHaveBeenCalledWith({ agentId: 'a1', message: 'oops' })
    expect(state._onAgentDisconnected).toHaveBeenCalledWith({ agentId: 'a1', reason: 'killed' })
    expect(toastError).toHaveBeenCalledWith('died')
    expect(toastError).toHaveBeenCalledWith('oops')
  })

  it('routes a browser_open_request delta to the dialog reducer, not the roster', () => {
    const { state, handlers } = setup()
    handlers().onDelta?.({
      event: 'browser_open_request',
      payload: { agentId: 'a1', url: 'https://auth.example/x' }
    })

    expect(state._onBrowserOpenRequest).toHaveBeenCalledWith({
      agentId: 'a1',
      url: 'https://auth.example/x'
    })
    expect(state._onAgentSpawned).not.toHaveBeenCalled()
    expect(state._onAgentDisconnected).not.toHaveBeenCalled()
  })

  it('hands a browser_policy_changed delta to the policy subscribers, not the roster', () => {
    const { state, handlers } = setup()
    const seen: unknown[] = []
    const stop = onBrowserPolicyChanged((change) => seen.push(change))

    handlers().onDelta?.({
      event: 'browser_policy_changed',
      payload: { scope: 'project', projectId: 'p1', revision: 3 }
    })
    handlers().onDelta?.({
      event: 'browser_policy_changed',
      payload: { scope: 'app', revision: 4 }
    })
    stop()

    expect(seen).toEqual([
      { scope: 'project', projectId: 'p1', revision: 3 },
      { scope: 'app', revision: 4 }
    ])
    expect(state._onAgentSpawned).not.toHaveBeenCalled()
    expect(state._onAgentDisconnected).not.toHaveBeenCalled()
  })

  it('asks policy views to re-read whenever the agents watch resyncs', () => {
    const { handlers } = setup()
    const resync = vi.fn()
    const stop = onBrowserPolicyResync(resync)
    handlers().onState([])
    handlers().onState([])
    stop()
    handlers().onState([])
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('hands an automation_changed delta to automation subscribers and a resync as null', () => {
    const { state, handlers } = setup()
    const seen: unknown[] = []
    const stop = onAutomationChanged((change) => seen.push(change))

    handlers().onDelta?.({
      event: 'automation_changed',
      payload: { project_id: 'p1', automation_id: 'auto-1' }
    })
    handlers().onState([])
    stop()

    expect(seen).toEqual([{ project_id: 'p1', automation_id: 'auto-1' }, null])
    expect(state._onAgentSpawned).not.toHaveBeenCalled()
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
    expect(state._onAgentDisconnected).toHaveBeenCalledWith({ agentId: 'gone', reason: 'killed' })
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
