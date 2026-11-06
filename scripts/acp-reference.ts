/**
 * Lists the ACP commands, requests, events and routes the code defines, and
 * reads the same lists back out of `docs/api-contracts.md`.
 *
 * `scripts/acp-reference.test.ts` fails when the two disagree, so a command
 * added to the code without a row in the doc breaks the build.
 *
 * Usage (prints every list as Markdown, ready to paste into the doc):
 *   bun run scripts/acp-reference.ts
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ACP_REFERENCE_KEYS = [
  'tauri-commands',
  'ws-requests',
  'acp-events',
  'relay-frames',
  'http-routes'
] as const

export type AcpReferenceKey = (typeof ACP_REFERENCE_KEYS)[number]

export type AcpReference = Record<AcpReferenceKey, string[]>

const REPO_ROOT = resolve(__dirname, '..')

function read(root: string, path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function withoutCommentLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

function sortedUnique(names: Iterable<string>): string[] {
  return [...new Set(names)].sort()
}

function capture(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1])
}

function tsArray(text: string, constName: string): string {
  const match = text.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`))
  if (!match) throw new Error(`${constName} not found`)
  return withoutCommentLines(match[1])
}

const HOST_COMMAND_NAME = /^(acp_|claude_accounts_|ws_channel_|codex_cli_auth_status$)/

function tauriCommands(root: string): string[] {
  const lib = read(root, 'src-tauri/src/lib.rs')
  const handler = lib.match(/generate_handler!\[([\s\S]*?)\n\s*\]\)/)
  if (!handler) throw new Error('generate_handler! not found in lib.rs')
  const names = withoutCommentLines(handler[1])
    .split(',')
    .map((entry) => entry.trim().split('::').pop() ?? '')
    .filter((name) => HOST_COMMAND_NAME.test(name))
  return sortedUnique(names)
}

function acpEvents(root: string): string[] {
  const rustConst = /const EVENT_[A-Z_]+: &str = "(acp:[a-z_]+)"/g
  const api = read(root, 'src/renderer/lib/acp-api.ts')
  const apiBlock = api.match(/export const ACP_EVENTS = \{([\s\S]*?)\} as const/)
  if (!apiBlock) throw new Error('ACP_EVENTS not found in acp-api.ts')
  const local = read(root, 'src/renderer/lib/acp-transport/desktop-local-events.ts')
  return sortedUnique([
    ...capture(read(root, 'src-tauri/src/acp/events.rs'), rustConst),
    ...capture(read(root, 'src-tauri/src/browser_automation/mod.rs'), rustConst),
    ...capture(apiBlock[1], /'(acp:[a-z_]+)'/g),
    ...capture(local, /'(acp:[a-z_]+)': true/g)
  ])
}

function httpRoutes(root: string): string[] {
  const router = ['mod.rs', 'host_routes.rs']
    .map((file) => withoutCommentLines(read(root, `src-tauri/src/web/router/${file}`)))
    .join('\n')
  return sortedUnique(capture(router, /\.route\(\s*"(\/acp\/[^"]*|\/host\/agent-idle-window)"/g))
}

export function collectAcpReference(root: string = REPO_ROOT): AcpReference {
  const protocol = read(root, 'src/shared/types/web-protocol.types.ts')
  const quoted = /'([a-z_]+)'/g
  const events = acpEvents(root)
  const eventNames = new Set(events.map((name) => name.replace(/^acp:/, '')))
  const typedWireTypes = capture(tsArray(protocol, 'WS_EVENT_TYPES'), quoted)
  return {
    'tauri-commands': tauriCommands(root),
    'ws-requests': sortedUnique(capture(tsArray(protocol, 'WS_REQUEST_TYPES'), quoted)),
    'acp-events': events,
    'relay-frames': sortedUnique(typedWireTypes.filter((type) => !eventNames.has(type))),
    'http-routes': httpRoutes(root)
  }
}

/**
 * First-column names of the Markdown table that follows
 * `<!-- acp-reference:KEY -->` in `doc`.
 */
export function docTableNames(doc: string, key: AcpReferenceKey): string[] {
  const lines = doc.split('\n')
  const start = lines.indexOf(`<!-- acp-reference:${key} -->`)
  if (start === -1) throw new Error(`marker acp-reference:${key} not found`)
  const names: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('|')) {
      if (names.length > 0) break
      continue
    }
    const cell = line.split('|')[1].trim()
    const name = cell.match(/^`([^`]+)`$/)?.[1]
    if (name) names.push(name)
  }
  return sortedUnique(names)
}

export function readApiContracts(root: string = REPO_ROOT): string {
  return read(root, 'docs/api-contracts.md')
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const reference = collectAcpReference()
  for (const key of ACP_REFERENCE_KEYS) {
    console.log(`## ${key} (${reference[key].length})\n`)
    for (const name of reference[key]) console.log(`| \`${name}\` | |`)
    console.log()
  }
}
