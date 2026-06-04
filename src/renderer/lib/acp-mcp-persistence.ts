/**
 * Persistence + helpers for the global MCP server registry.
 *
 * Stored under a dedicated `persistenceApi` key (versioned JSON), like agent
 * configs. Raw secrets are never persisted — header/env values may hold `$VAR`
 * placeholders resolved from OS secure storage.
 */

import type { McpServer, McpServerConfig } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'

export const ACP_MCP_KEY = 'acp/mcp-servers'

export type McpTransport = 'stdio' | 'http' | 'sse'

export type StoredMcpServer = McpServerConfig & { id: string }

export interface McpValidation {
  valid: boolean
  errors: string[]
}

export function transportOf(server: McpServerConfig): McpTransport {
  return (server.type ?? 'stdio') as McpTransport
}

export function validateMcpServer(server: Partial<McpServerConfig>): McpValidation {
  const errors: string[] = []
  if (!server.name || server.name.trim().length === 0) errors.push('Name is required.')
  const type = (server.type ?? 'stdio') as McpTransport
  if (type === 'stdio') {
    const s = server as Partial<{ command: string }>
    if (!s.command || s.command.trim().length === 0) errors.push('Command is required for stdio.')
  } else {
    const s = server as Partial<{ url: string }>
    if (!s.url || s.url.trim().length === 0) {
      errors.push('URL is required.')
    } else {
      try {
        // eslint-disable-next-line no-new
        new URL(s.url)
      } catch {
        errors.push('URL is invalid.')
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

/**
 * Map selected registry ids to the ACP `session/new` wire array. Unknown ids are
 * skipped; the local `id` field is stripped from each entry.
 */
export function buildMcpServers(registry: StoredMcpServer[], selectedIds: string[]): McpServer[] {
  const byId = new Map(registry.map((s) => [s.id, s]))
  const out: McpServer[] = []
  for (const id of selectedIds) {
    const entry = byId.get(id)
    if (!entry) continue
    const { id: _omit, ...wire } = entry
    void _omit
    out.push(wire as McpServer)
  }
  return out
}

export async function loadMcpServers(): Promise<StoredMcpServer[]> {
  const res = await persistenceApi.read<StoredMcpServer[]>(ACP_MCP_KEY)
  if (res.success && Array.isArray(res.data)) return res.data
  return []
}

export async function saveMcpServers(list: StoredMcpServer[]): Promise<void> {
  const res = await persistenceApi.write(ACP_MCP_KEY, list)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist MCP servers')
  }
}
