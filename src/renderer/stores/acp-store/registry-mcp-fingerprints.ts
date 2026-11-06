import type { AgentId, McpServer, SessionId } from '@/lib/acp-api'
import { selectMcpServersForAgent } from '@/lib/acp-mcp-persistence'
import { sha256Hex } from '@/lib/sha256-hex'
import type { AcpState } from './types'

/** Order-independent key for an MCP server list. */
export function mcpServersFingerprint(mcpServers: McpServer[]): string {
  return mcpServers
    .map((s) => JSON.stringify(s))
    .sort()
    .join('|')
}

/**
 * The MCP servers a session took from the user's MCP list when it was
 * created, by session id. A warm session made before the list changed must
 * not become the next chat: it would run without the new servers. Holds a
 * SHA-256 of the list, never the list itself: env and header values may be
 * secrets. The hash is synchronous because the warm-slot check is. Lives in
 * its own module so helpers can drop an id without importing `shared-state`.
 */
const registryMcpFingerprints = new Map<SessionId, string>()

function registryMcpDigest(servers: McpServer[]): string {
  return sha256Hex(mcpServersFingerprint(servers))
}

export function recordRegistryMcpServers(sessionId: SessionId, servers: McpServer[]): void {
  registryMcpFingerprints.set(sessionId, registryMcpDigest(servers))
}

export function forgetRegistryMcpServers(sessionId: SessionId): void {
  registryMcpFingerprints.delete(sessionId)
}

export function registryMcpServersAreCurrent(
  state: Pick<AcpState, 'mcpServers' | 'agents'>,
  sessionId: SessionId,
  agentId: AgentId
): boolean {
  const recorded = registryMcpFingerprints.get(sessionId)
  if (recorded === undefined) return true
  const { servers } = selectMcpServersForAgent(
    state.mcpServers,
    state.agents[agentId]?.capabilities
  )
  return registryMcpDigest(servers) === recorded
}

export function _registryMcpFingerprintForTesting(sessionId: SessionId): string | undefined {
  return registryMcpFingerprints.get(sessionId)
}

export function _resetRegistryMcpFingerprintsForTesting(): void {
  registryMcpFingerprints.clear()
}
