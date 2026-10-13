/**
 * The agent roster on web: the host's `agents` watch replaces the sid-less
 * `agent_spawned` / `agent_crashed` / `agent_error` / `agent_disconnected`
 * events the relay used to broadcast with `seq = 0`.
 *
 * A delta carries one of those events with its original payload and goes to
 * the same store reducers a desktop event does. A kill or an idle reap arrives
 * as `agent_disconnected` with a `reason`. The full state (on every
 * subscribe, so after a reconnect or a lost delta) is reconciled against what
 * the store holds: an agent the host lists that the store lacks counts as
 * spawned, a connected agent the host no longer lists counts as disconnected.
 */

import type { AgentsWatchDelta, WsAgentSummary } from '@shared/types/web-protocol.types'
import { toast } from 'sonner'
import type {
  AgentCrashedEvent,
  AgentDisconnectedEvent,
  AgentErrorEvent,
  AgentSpawnedEvent
} from '@/lib/acp-api'
import type { WatchClient } from '@/lib/acp-transport/watch-client'
import { logFrontendError } from '@/lib/log-api'
import type { AcpState } from './types'

/** Start watching the roster; returns the unsubscribe. */
export function attachAgentRosterWatch(watches: WatchClient, getState: () => AcpState): () => void {
  return watches.subscribe<WsAgentSummary[], AgentsWatchDelta>('agents', {
    onState: (summaries) => reconcileRoster(getState(), summaries),
    onDelta: (delta) => applyRosterDelta(getState(), delta)
  })
}

function reconcileRoster(state: AcpState, summaries: WsAgentSummary[]): void {
  if (!Array.isArray(summaries)) return
  const listed = new Set<string>()
  for (const summary of summaries) {
    if (typeof summary?.id !== 'string') continue
    listed.add(summary.id)
    if (state.agents[summary.id]) continue
    // The roster carries no auth methods: the spawn reply (or a later
    // `authenticate` round trip) fills them in.
    state._onAgentSpawned({ agentId: summary.id, capabilities: summary.capabilities })
  }
  for (const agentId of Object.keys(state.agents)) {
    if (listed.has(agentId) || state.agentStatus[agentId] !== 'connected') continue
    state._onAgentDisconnected({ agentId, reason: 'killed' })
  }
}

function applyRosterDelta(state: AcpState, delta: AgentsWatchDelta): void {
  const agentId = (delta?.payload as { agentId?: unknown } | null | undefined)?.agentId
  if (typeof agentId !== 'string') {
    void logFrontendError({
      level: 'warn',
      source: 'acp-store.agentRosterWatch',
      message: `ignored an agents watch delta without an agent id (${String(delta?.event)})`
    })
    return
  }
  switch (delta?.event) {
    case 'agent_spawned':
      state._onAgentSpawned(delta.payload as AgentSpawnedEvent)
      return
    case 'agent_crashed': {
      const event = delta.payload as AgentCrashedEvent
      state._onAgentCrashed(event)
      toast.error(event.message || 'Agent crashed')
      return
    }
    case 'agent_error': {
      const event = delta.payload as AgentErrorEvent
      state._onAgentError(event)
      toast.error(event.message || 'Agent error')
      return
    }
    case 'agent_disconnected':
      state._onAgentDisconnected(delta.payload as AgentDisconnectedEvent)
      return
    default:
      void logFrontendError({
        level: 'warn',
        source: 'acp-store.agentRosterWatch',
        message: `ignored an agents watch delta of an unknown kind: ${String(delta?.event)}`
      })
  }
}
