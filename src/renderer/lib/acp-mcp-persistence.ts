import { PersistenceKeys } from '@shared/types/persistence.types'
import type { AgentCapabilities, McpServer, McpServerConfig } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'
import { syncMcpRegistryToProject } from '@/lib/tauri-remote-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerMcpServers } from '@/lib/web-server-api'
import { logFrontendError } from './log-api'

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

/**
 * The registry is one list. Desktop keeps it once in the app store; a web
 * client reads the host file of the project it names (`projectId`, the active
 * project); an empty id (no project yet) loads nothing.
 */
export async function loadMcpServers(projectId: string): Promise<StoredMcpServer[]> {
  if (!isTauriContext() && !projectId) return []
  const res = isTauriContext()
    ? await persistenceApi.read<unknown>(PersistenceKeys.acpMcpServers)
    : await webServerMcpServers.get(projectId as string)
  if (res.success) return dropLegacyCanvasMcpEntries(res.data, projectId)
  if (res.code === 'KEY_NOT_FOUND') return []
  throw new Error(res.error ?? 'Failed to load MCP servers')
}

const LEGACY_CANVAS_MCP_ID_PREFIX = 'canvas-mcp-'

/**
 * One-time migration: per-project `canvas-mcp-*` entries were written by the
 * retired canvas MCP proxy and now point at routes that no longer exist. They
 * are dropped on load and the cleaned registry is written back, so a later
 * load finds nothing to drop. A failed write-back leaves the file as it was
 * and the next load retries.
 */
async function dropLegacyCanvasMcpEntries(
  raw: unknown,
  projectId: string
): Promise<StoredMcpServer[]> {
  if (!Array.isArray(raw)) return normalizeMcpRegistry(raw)
  const kept = raw.filter(
    (entry) =>
      !(
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        entry.id.startsWith(LEGACY_CANVAS_MCP_ID_PREFIX)
      )
  )
  const registry = normalizeMcpRegistry(kept)
  const dropped = raw.length - kept.length
  if (dropped === 0) return registry
  void logFrontendError({
    level: 'info',
    source: 'acp-mcp-persistence.dropLegacyCanvasMcpEntries',
    message: `removed ${dropped} legacy canvas-mcp-* MCP registry entries`
  })
  try {
    await saveMcpServers(registry, projectId)
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'acp-mcp-persistence.dropLegacyCanvasMcpEntries',
      message: `failed to persist the registry without legacy canvas-mcp-* entries (${String(err)})`
    })
  }
  return registry
}

export async function saveMcpServers(list: StoredMcpServer[], projectId: string): Promise<void> {
  const normalized = normalizeMcpRegistry(list)
  if (isTauriContext()) {
    const res = await persistenceApi.write(PersistenceKeys.acpMcpServers, normalized)
    if (!res.success) {
      throw new Error(res.error ?? 'Failed to persist MCP servers')
    }
    // CAP-7: mirror the app-store registry to the active project's
    // `.termul/mcp-servers.json` so the web `GET /mcp-servers?projectId=` route
    // (file-based) serves the same registry. Best-effort — a sync failure is
    // logged but never blocks the app-store save (the save above already
    // succeeded).
    await syncMcpRegistryToProjectBestEffort(projectId, normalized)
    return
  }
  if (!projectId) throw new Error('Select a project to save MCP servers')
  const res = await webServerMcpServers.put(projectId, normalized)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist MCP servers')
  }
}

/**
 * Best-effort wrapper for `syncMcpRegistryToProject`: logs a failure via
 * `logFrontendError` (with the IpcResult error/code) and never throws. Shared by
 * the `saveMcpServers` desktop hook and the acp-store mirror so the error path
 * stays identical (CAP-7 — registry sync is always non-fatal). An empty
 * project id (none active yet) mirrors nothing; a project the host registry does
 * not hold yet (`NOT_FOUND`, e.g. shared-live off) is expected and only noted.
 */
export async function syncMcpRegistryToProjectBestEffort(
  projectId: string,
  registry: StoredMcpServer[]
): Promise<void> {
  if (!projectId) return
  try {
    const result = await syncMcpRegistryToProject(projectId, registry)
    if (!result.success) {
      void logFrontendError({
        level: result.code === 'NOT_FOUND' ? 'info' : 'error',
        source: 'acp-mcp-persistence.syncMcpRegistryToProject',
        message: `MCP registry project-file sync failed (${result.error ?? result.code ?? 'unknown'})`
      })
    }
  } catch (err) {
    void logFrontendError({
      source: 'acp-mcp-persistence.syncMcpRegistryToProject',
      message: `MCP registry project-file sync failed (${String(err)})`
    })
  }
}
