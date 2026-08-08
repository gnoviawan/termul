import type { AgentCapabilities, McpServer, McpServerConfig } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerMcpServers } from '@/lib/web-server-api'

export const ACP_MCP_KEY = 'acp/mcp-servers'

export type McpTransport = 'stdio' | 'http' | 'sse'

export type StoredMcpServer = McpServerConfig & { id: string; enabled?: boolean }

export interface McpValidation {
  valid: boolean
  errors: string[]
}

export interface SkippedMcpServer {
  id: string
  name: string
  transport: 'http' | 'sse'
}

export interface McpServerSelection {
  servers: McpServer[]
  skipped: SkippedMcpServer[]
  pending: boolean
}

export function transportOf(server: McpServerConfig): McpTransport {
  return (server.type ?? 'stdio') as McpTransport
}

export function validateMcpServer(server: Partial<McpServerConfig>): McpValidation {
  const errors: string[] = []
  if (!server.name || server.name.trim().length === 0) errors.push('Name is required.')
  const type = (server.type ?? 'stdio') as McpTransport
  if (type === 'stdio') {
    const value = server as Partial<{ command: string }>
    if (!value.command || value.command.trim().length === 0) {
      errors.push('Command is required for stdio.')
    }
  } else {
    const value = server as Partial<{ url: string }>
    if (!value.url || value.url.trim().length === 0) {
      errors.push('URL is required.')
    } else {
      try {
        new URL(value.url)
      } catch {
        errors.push('URL is invalid.')
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

function toWireServer(entry: StoredMcpServer): McpServer {
  const { id: _id, enabled: _enabled, ...server } = entry
  // The ACP `McpServer` schema requires `args` + `env` (stdio) and `headers`
  // (http/sse) as non-optional arrays. The on-disk normalizer omits these
  // when empty, so re-fill them here to keep the wire payload deserializable.
  switch (transportOf(server)) {
    case 'stdio': {
      const { name, command, args, env } = server as Extract<McpServerConfig, { type?: 'stdio' }>
      return { type: 'stdio', name, command, args: args ?? [], env: env ?? [] }
    }
    case 'http': {
      const { name, url, headers } = server as Extract<McpServerConfig, { type: 'http' }>
      return { type: 'http', name, url, headers: headers ?? [] }
    }
    case 'sse': {
      const { name, url, headers } = server as Extract<McpServerConfig, { type: 'sse' }>
      return { type: 'sse', name, url, headers: headers ?? [] }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringPairs(value: unknown): Array<{ name: string; value: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const pairs = value.filter(
    (entry): entry is { name: string; value: string } =>
      isRecord(entry) && typeof entry.name === 'string' && typeof entry.value === 'string'
  )
  return pairs.length === value.length ? pairs : undefined
}

function normalizeStoredServer(value: unknown): StoredMcpServer | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    return null
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return null
  const type = value.type ?? 'stdio'
  if (type === 'stdio') {
    if (typeof value.command !== 'string') return null
    if (value.args !== undefined && !Array.isArray(value.args)) return null
    const args = value.args?.filter((item): item is string => typeof item === 'string')
    if (value.args !== undefined && args?.length !== value.args.length) return null
    const env = stringPairs(value.env)
    if (value.env !== undefined && env === undefined) return null
    const server: StoredMcpServer = {
      id: value.id,
      type: 'stdio',
      name: value.name,
      command: value.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
      enabled: value.enabled ?? true
    }
    return validateMcpServer(server).valid ? server : null
  }
  if ((type === 'http' || type === 'sse') && typeof value.url === 'string') {
    const headers = stringPairs(value.headers)
    if (value.headers !== undefined && headers === undefined) return null
    const server: StoredMcpServer = {
      id: value.id,
      type,
      name: value.name,
      url: value.url,
      ...(headers ? { headers } : {}),
      enabled: value.enabled ?? true
    }
    return validateMcpServer(server).valid ? server : null
  }
  return null
}

export function normalizeMcpRegistry(value: unknown): StoredMcpServer[] {
  if (!Array.isArray(value)) return []
  const normalized = value.flatMap((entry) => {
    const server = normalizeStoredServer(entry)
    return server ? [server] : []
  })
  if (normalized.length !== value.length) {
    console.warn(`[mcp] discarded ${value.length - normalized.length} malformed registry entries`)
  }
  return normalized
}

export function buildMcpServers(registry: StoredMcpServer[], selectedIds: string[]): McpServer[] {
  const byId = new Map(registry.map((server) => [server.id, server]))
  return selectedIds.flatMap((id) => {
    const entry = byId.get(id)
    return entry ? [toWireServer(entry)] : []
  })
}

export function selectMcpServersForAgent(
  registry: StoredMcpServer[],
  capabilities: AgentCapabilities | null | undefined
): McpServerSelection {
  const servers: McpServer[] = []
  const skipped: SkippedMcpServer[] = []
  const mcpCapabilities = capabilities?.mcpCapabilities
  const pending = capabilities == null

  for (const entry of registry) {
    if (entry.enabled === false) continue
    const transport = transportOf(entry)
    if (transport === 'stdio' || pending) {
      servers.push(toWireServer(entry))
    } else if (mcpCapabilities?.[transport] === true) {
      servers.push(toWireServer(entry))
    } else {
      skipped.push({ id: entry.id, name: entry.name, transport })
    }
  }

  return { servers, skipped, pending }
}

export async function loadMcpServers(): Promise<StoredMcpServer[]> {
  const res = isTauriContext()
    ? await persistenceApi.read<unknown>(ACP_MCP_KEY)
    : await webServerMcpServers.get()
  if (res.success) return normalizeMcpRegistry(res.data)
  if (res.code === 'KEY_NOT_FOUND') return []
  throw new Error(res.error ?? 'Failed to load MCP servers')
}

export async function saveMcpServers(list: StoredMcpServer[]): Promise<void> {
  const normalized = normalizeMcpRegistry(list)
  const res = isTauriContext()
    ? await persistenceApi.write(ACP_MCP_KEY, normalized)
    : await webServerMcpServers.put(normalized)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist MCP servers')
  }
}
