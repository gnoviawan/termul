import { runtimeT } from '@/i18n/runtime'
import type { McpEnvVar, McpServerConfig } from '@/lib/acp-api'
import { validateMcpServer } from '@/lib/acp-mcp-persistence'

export interface McpJsonImportResult {
  servers: McpServerConfig[]
  errors: string[]
}

const TRANSPORTS = ['stdio', 'http', 'sse'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** All-string array, or `undefined` when `value` is not a string array. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length === value.length ? strings : undefined
}

/** `[{name, value}]` array, or `undefined` when `value` is not one. Entries are
 * rebuilt as fresh `{name, value}` objects so any extra properties on the input
 * (e.g. `{name, value, foo}`) are dropped — matching the "unknown fields are
 * silently dropped" contract of the object-map branch in `normalizeEnv`. */
function stringPairs(value: unknown): Array<{ name: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  const pairs: Array<{ name: string; value: string }> = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
      return undefined
    }
    pairs.push({ name: entry.name, value: entry.value })
  }
  return pairs
}

/**
 * Normalize `env` from a Claude Desktop-style `Record<string,string>` map into
 * Termul's internal `[{name, value}]` shape. An already-normalized array passes
 * through unchanged. Any other shape yields `undefined` (the server is rejected
 * by the caller; the rest still import).
 */
function normalizeEnv(value: unknown): McpEnvVar[] | undefined {
  if (value === undefined) return undefined
  if (isRecord(value)) {
    return Object.entries(value).map(([name, entryValue]) => ({
      name,
      value: String(entryValue)
    }))
  }
  return stringPairs(value)
}

/**
 * Build a (partial) server config from a parsed entry, keeping only known
 * fields (`type`, `name`, `command`, `args`, `env`, `url`, `headers`) — unknown
 * fields (e.g. `directTools`, `alwaysAllow`) are silently dropped. Returns
 * `null` for structurally malformed input (`args`/`headers` in the wrong shape,
 * or a non-string `command`/`url`); missing required fields are left to
 * `validateMcpServer` so the per-server error matches the form validation text.
 */
function buildServer(
  raw: Record<string, unknown>,
  name: string,
  env: McpEnvVar[] | undefined
): Partial<McpServerConfig> | null {
  // Explicit `type` is honored when it is a real transport; otherwise infer:
  // `command` present → stdio, only `url` present → http, default stdio.
  // Unknown `type` values (e.g. `acp`) are never accepted as a working
  // transport — they fall through to inference.
  const explicitType = typeof raw.type === 'string' ? (raw.type as string) : undefined
  const hasCommand = typeof raw.command === 'string' && raw.command.trim().length > 0
  const hasUrl = typeof raw.url === 'string' && raw.url.trim().length > 0
  const type: (typeof TRANSPORTS)[number] =
    explicitType === 'stdio' || explicitType === 'http' || explicitType === 'sse'
      ? explicitType
      : hasCommand
        ? 'stdio'
        : hasUrl
          ? 'http'
          : 'stdio'

  if (type === 'stdio') {
    if (raw.command !== undefined && typeof raw.command !== 'string') return null
    const args =
      raw.args !== undefined ? stringArray(raw.args)?.map((arg) => arg.trim()) : undefined
    if (raw.args !== undefined && args === undefined) return null
    const server: Partial<McpServerConfig> = {
      type: 'stdio',
      name,
      ...(typeof raw.command === 'string' ? { command: raw.command.trim() } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && env.length > 0 ? { env } : {})
    }
    return server
  }

  if (raw.url !== undefined && typeof raw.url !== 'string') return null
  const headers = raw.headers !== undefined ? stringPairs(raw.headers) : undefined
  if (raw.headers !== undefined && headers === undefined) return null
  const shared = {
    name,
    ...(typeof raw.url === 'string' ? { url: raw.url.trim() } : {}),
    ...(headers && headers.length > 0 ? { headers } : {})
  }
  return type === 'http'
    ? { type: 'http' as const, ...shared }
    : { type: 'sse' as const, ...shared }
}

/**
 * Parse a pasted MCP JSON config into saveable `McpServerConfig`s.
 *
 * Accepts TWO shapes, detected by the top-level keys:
 * 1. Claude Desktop `{"mcpServers": {name: {...}}}` — each entry is one server,
 *    named by its wrapper key.
 * 2. A bare single-server object `{command, args, env, name, ...}`.
 *
 * Unknown fields (e.g. `directTools`, `alwaysAllow`) are silently dropped.
 * `env` maps are normalized to `[{name, value}]`; an already-normalized array
 * passes through. Each server is validated via `validateMcpServer`; invalid
 * entries are reported per-server and skipped — the rest still import.
 */
export function parseMcpJsonImport(text: string): McpJsonImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      servers: [],
      errors: [
        runtimeT('mcp', 'import.invalidJson', `Invalid JSON: ${String(error)}`, {
          message: String(error)
        })
      ]
    }
  }
  if (!isRecord(parsed)) {
    return {
      servers: [],
      errors: [
        runtimeT('mcp', 'import.topLevelObject', 'Invalid JSON: expected a top-level object')
      ]
    }
  }

  const entries: Array<[string, unknown]> = []
  if (isRecord(parsed.mcpServers)) {
    for (const [name, value] of Object.entries(parsed.mcpServers)) {
      entries.push([name, value])
    }
  } else if (parsed.mcpServers !== undefined) {
    return {
      servers: [],
      errors: [
        runtimeT('mcp', 'import.serversObject', 'Invalid JSON: "mcpServers" must be an object')
      ]
    }
  } else {
    // Bare single-server object.
    entries.push(['', parsed])
  }

  const servers: McpServerConfig[] = []
  const errors: string[] = []
  for (const [keyName, raw] of entries) {
    const name =
      keyName.length > 0 || !isRecord(raw) ? keyName : typeof raw.name === 'string' ? raw.name : ''
    if (!isRecord(raw)) {
      errors.push(
        runtimeT('mcp', 'import.serverObject', `${name || '<unknown>'}: expected a server object`, {
          name: name || runtimeT('mcp', 'import.unknown', '<unknown>')
        })
      )
      continue
    }
    const env = normalizeEnv(raw.env)
    if (raw.env !== undefined && env === undefined) {
      errors.push(
        runtimeT(
          'mcp',
          'import.envShape',
          `${name || '<unnamed>'}: env must be an object map or name/value pairs`,
          { name: name || runtimeT('mcp', 'import.unnamed', '<unnamed>') }
        )
      )
      continue
    }
    const server = buildServer(raw, name, env)
    if (!server) {
      errors.push(
        runtimeT(
          'mcp',
          'import.invalidServer',
          `${name || '<unnamed>'}: invalid server configuration`,
          { name: name || runtimeT('mcp', 'import.unnamed', '<unnamed>') }
        )
      )
      continue
    }
    const validation = validateMcpServer(server)
    if (!validation.valid) {
      errors.push(
        runtimeT(
          'mcp',
          'import.validation',
          `${name || '<unnamed>'}: ${validation.errors.join(' ')}`,
          {
            name: name || runtimeT('mcp', 'import.unnamed', '<unnamed>'),
            errors: validation.errors.join(' ')
          }
        )
      )
      continue
    }
    servers.push(server as McpServerConfig)
  }
  return { servers, errors }
}
