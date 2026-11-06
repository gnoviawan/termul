import type { McpEnvVar, McpServerConfig } from '@/lib/acp-api'
import {
  type McpValidationIssue,
  type StoredMcpServer,
  transportOf,
  validateMcpServer
} from '@/lib/acp-mcp-persistence'

export type KeyValueRow = { id: string; name: string; value: string }

export type RemoteTransport = 'http' | 'sse'

export type McpServerDraft = {
  kind: 'remote' | 'local'
  name: string
  remote: {
    url: string
    transport: RemoteTransport
    transportPinned: boolean
    auth: 'browser' | 'token'
    headers: KeyValueRow[]
  }
  local: { commandLine: string; env: KeyValueRow[] }
}

export type DraftField = 'name' | 'url' | 'commandLine' | 'headers' | 'env'

export type DraftErrors = Partial<Record<DraftField, string>>

export type DraftResult = { config: McpServerConfig } | { errors: DraftErrors }

export const AUTH_HEADER = 'Authorization'

const ISSUE_FIELDS: Record<McpValidationIssue, { field: DraftField; message: string }> = {
  'name-required': { field: 'name', message: 'Give the server a name.' },
  'command-required': {
    field: 'commandLine',
    message: 'Enter the command that starts the server.'
  },
  'url-required': { field: 'url', message: 'Enter the server URL.' },
  'url-invalid': { field: 'url', message: 'Enter a full URL, like https://mcp.example.com/mcp.' }
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

let rowSeq = 0

export function blankRow(name = '', value = ''): KeyValueRow {
  rowSeq += 1
  return { id: `kv-${rowSeq}`, name, value }
}

export function emptyDraft(): McpServerDraft {
  return {
    kind: 'remote',
    name: '',
    remote: {
      url: '',
      transport: 'http',
      transportPinned: false,
      auth: 'browser',
      headers: [blankRow()]
    },
    local: { commandLine: '', env: [blankRow()] }
  }
}

export function transportForUrl(url: string): RemoteTransport {
  let path: string
  try {
    path = new URL(url.trim()).pathname
  } catch {
    path = url.trim().replace(/[?#].*$/, '')
  }
  return /\/sse\/?$/i.test(path) ? 'sse' : 'http'
}

type Token = { value: string; start: number }

const DOUBLE_QUOTE_ESCAPES = new Set(['"', '\\'])

function scanTokens(line: string): Token[] | null {
  const tokens: Token[] = []
  let value = ''
  let start = -1
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i += 1) {
    const char = line.charAt(i)
    const next = line.charAt(i + 1)
    if (quote === "'") {
      if (char === "'") quote = null
      else value += char
    } else if (quote === '"') {
      if (char === '\\' && DOUBLE_QUOTE_ESCAPES.has(next)) {
        value += next
        i += 1
      } else if (char === '"') quote = null
      else value += char
    } else if (/\s/.test(char)) {
      if (start !== -1) tokens.push({ value, start })
      value = ''
      start = -1
    } else {
      if (start === -1) start = i
      if (char === '"' || char === "'") quote = char
      else value += char
    }
  }
  if (quote) return null
  if (start !== -1) tokens.push({ value, start })
  return tokens
}

export function tokenizeCommandLine(line: string): string[] | null {
  return scanTokens(line)?.map((token) => token.value) ?? null
}

function quoteToken(token: string): string {
  if (token.length > 0 && !/[\s'"]/.test(token)) return token
  if (!token.includes("'")) return `'${token}'`
  return `"${token.replace(/[\\"]/g, '\\$&')}"`
}

export function joinCommandLine(tokens: string[]): string {
  return tokens.map(quoteToken).join(' ')
}

export function liftEnvPrefix(local: McpServerDraft['local']): McpServerDraft['local'] {
  const tokens = scanTokens(local.commandLine)
  if (!tokens) return local
  const firstCommand = tokens.findIndex((token) => !ENV_ASSIGNMENT.test(token.value))
  const lifted = firstCommand === -1 ? tokens : tokens.slice(0, firstCommand)
  if (lifted.length === 0) return local
  let env = local.env.filter((row) => row.name.trim() !== '' || row.value.trim() !== '')
  for (const token of lifted) {
    const split = token.value.indexOf('=')
    const name = token.value.slice(0, split)
    const value = token.value.slice(split + 1)
    const existing = env.find((row) => row.name.trim() === name)
    env = existing
      ? env.map((row) => (row === existing ? { ...row, value } : row))
      : [...env, blankRow(name, value)]
  }
  const rest = firstCommand === -1 ? '' : local.commandLine.slice(tokens[firstCommand]?.start)
  return { commandLine: rest, env }
}

export type RowProblem = 'Needs a value.' | 'Needs a name.'

export function rowProblem(row: KeyValueRow): RowProblem | null {
  const hasName = row.name.trim() !== ''
  const hasValue = row.value.trim() !== ''
  if (hasName && !hasValue) return 'Needs a value.'
  if (hasValue && !hasName) return 'Needs a name.'
  return null
}

function filledPairs(rows: KeyValueRow[]): McpEnvVar[] {
  return rows
    .filter((row) => row.name.trim() !== '' && row.value.trim() !== '')
    .map((row) => ({ name: row.name.trim(), value: row.value.trim() }))
}

function firstRowProblem(rows: KeyValueRow[]): DraftErrors['env'] {
  for (const row of rows) {
    const problem = rowProblem(row)
    if (problem) return problem
  }
  return undefined
}

function buildConfig(draft: McpServerDraft): { config: McpServerConfig; errors: DraftErrors } {
  const name = draft.name.trim()
  if (draft.kind === 'remote') {
    const headers = filledPairs(draft.remote.headers)
    const problem = firstRowProblem(draft.remote.headers)
    return {
      config: {
        type: draft.remote.transport,
        name,
        url: draft.remote.url.trim(),
        ...(headers.length > 0 ? { headers } : {})
      },
      errors: problem ? { headers: problem } : {}
    }
  }
  const local = liftEnvPrefix(draft.local)
  const tokens = tokenizeCommandLine(local.commandLine)
  const [command = '', ...args] = tokens ?? []
  const env = filledPairs(local.env)
  const problem = firstRowProblem(local.env)
  return {
    config: {
      type: 'stdio',
      name,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(env.length > 0 ? { env } : {})
    },
    errors: {
      ...(problem ? { env: problem } : {}),
      ...(tokens ? {} : { commandLine: 'Close the quote in the command.' })
    }
  }
}

export function draftToConfig(draft: McpServerDraft): DraftResult {
  const { config, errors } = buildConfig(draft)
  for (const issue of validateMcpServer(config).issues) {
    const { field, message } = ISSUE_FIELDS[issue]
    errors[field] ??= message
  }
  return Object.keys(errors).length > 0 ? { errors } : { config }
}

function rowsFrom(pairs: McpEnvVar[] | undefined): KeyValueRow[] {
  return pairs && pairs.length > 0
    ? pairs.map((pair) => blankRow(pair.name, pair.value))
    : [blankRow()]
}

export function draftFromServer(server: StoredMcpServer): McpServerDraft {
  const draft = emptyDraft()
  if (transportOf(server) === 'stdio') {
    const stdio = server as Extract<McpServerConfig, { type?: 'stdio' }>
    return {
      ...draft,
      kind: 'local',
      name: server.name,
      local: {
        commandLine: joinCommandLine([stdio.command, ...(stdio.args ?? [])]),
        env: rowsFrom(stdio.env)
      }
    }
  }
  const remote = server as Extract<McpServerConfig, { type: 'http' | 'sse' }>
  const transport = transportOf(server) as RemoteTransport
  return {
    ...draft,
    kind: 'remote',
    name: server.name,
    remote: {
      url: remote.url,
      transport,
      transportPinned: transport !== transportForUrl(remote.url),
      auth: remote.headers?.some((header) => header.name.toLowerCase() === 'authorization')
        ? 'token'
        : 'browser',
      headers: rowsFrom(remote.headers)
    }
  }
}

export function withUrl(remote: McpServerDraft['remote'], url: string): McpServerDraft['remote'] {
  return remote.transportPinned
    ? { ...remote, url }
    : { ...remote, url, transport: transportForUrl(url) }
}

export function withAuth(
  remote: McpServerDraft['remote'],
  auth: McpServerDraft['remote']['auth']
): McpServerDraft['remote'] {
  const isAuthRow = (row: KeyValueRow) => row.name.trim().toLowerCase() === 'authorization'
  const filled = remote.headers.filter((row) => row.name.trim() !== '' || row.value.trim() !== '')
  if (auth === 'token') {
    const headers = filled.some(isAuthRow) ? filled : [blankRow(AUTH_HEADER), ...filled]
    return { ...remote, auth, headers }
  }
  const rest = filled.filter((row) => !isAuthRow(row))
  return { ...remote, auth, headers: rest.length > 0 ? rest : [blankRow()] }
}
