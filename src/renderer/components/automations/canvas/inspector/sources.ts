/**
 * What the agent and MCP tool forms offer to pick: the agents the host can
 * launch (`list_agents`), an agent's models (the list its chats last
 * reported), and the MCP servers and tools (the shared registry the host
 * reads, and Troupe's own `tools/list` of each).
 */

import type { KnownAgent } from '@shared/types/automation.types'
import { useCallback, useEffect, useState } from 'react'
import type { McpToolInfo, SessionModel } from '@/lib/acp-api'
import { listAutomationAgents } from '@/lib/automation-api'
import { useAcpStore } from '@/stores/acp-store'
import { readModelCatalog } from '@/stores/acp-store/model-catalog'

export type KnownAgents =
  | { state: 'loading' }
  | { state: 'error'; error: string; retry: () => void }
  | { state: 'ready'; agents: KnownAgent[] }

export function useKnownAgents(): KnownAgents {
  const [result, setResult] = useState<KnownAgents>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-lists on retry
  useEffect(() => {
    let live = true
    setResult({ state: 'loading' })
    void listAutomationAgents().then((reply) => {
      if (!live) return
      setResult(
        reply.success
          ? { state: 'ready', agents: reply.data }
          : { state: 'error', error: reply.error, retry }
      )
    })
    return () => {
      live = false
    }
  }, [attempt, retry])
  return result
}

/**
 * The models `agentId` offers, as its chats last reported them; empty when
 * none has run yet. The host switches with `set_model`, so these are the
 * session's `availableModels` ids, not a config option's values.
 */
export function useAgentModels(agentId: string): SessionModel[] {
  const live = useAcpStore((s) => s.agentOptionsCache[agentId]?.models?.availableModels)
  const [saved, setSaved] = useState<{ agentId: string; models: SessionModel[] } | null>(null)
  useEffect(() => {
    if (!agentId || live) return
    let current = true
    void readModelCatalog(agentId).then((catalog) => {
      if (current) setSaved({ agentId, models: catalog?.models?.availableModels ?? [] })
    })
    return () => {
      current = false
    }
  }, [agentId, live])
  return live ?? (saved?.agentId === agentId ? saved.models : [])
}

export type McpServerChoice = { id: string; name: string }

/** `registry::parse_registry`: the enabled servers with an id and a name, first id wins. */
export function useMcpServers(): { loaded: boolean; servers: McpServerChoice[] } {
  const stored = useAcpStore((s) => s.mcpServers)
  const loaded = useAcpStore((s) => s.mcpServersLoaded)
  const servers: McpServerChoice[] = []
  for (const server of stored) {
    const id = server.id.trim()
    const name = server.name.trim()
    if (!id || !name || server.enabled === false || servers.some((s) => s.id === id)) continue
    servers.push({ id, name })
  }
  return { loaded, servers }
}

export type McpToolList =
  | { state: 'loading' }
  | { state: 'failed'; error: string }
  | { state: 'ready'; tools: McpToolInfo[] }

/** `serverId`'s tools, listed once when nothing has listed them yet. */
export function useMcpTools(serverId: string): McpToolList {
  const loaded = useAcpStore((s) => s.mcpToolsLoaded[serverId] === true)
  const tools = useAcpStore((s) => s.mcpTools[serverId])
  const status = useAcpStore((s) => s.mcpProbeStatus[serverId])
  const error = useAcpStore((s) => s.mcpProbeError[serverId])
  const loadMcpTools = useAcpStore((s) => s.loadMcpTools)
  useEffect(() => {
    if (serverId && !loaded) void loadMcpTools(serverId)
  }, [serverId, loaded, loadMcpTools])
  if (!loaded) return { state: 'loading' }
  if (status === 'authRequired') return { state: 'failed', error: 'needs a sign-in' }
  if (status === 'disconnected') return { state: 'failed', error: error ?? 'not reachable' }
  return { state: 'ready', tools: tools ?? [] }
}
