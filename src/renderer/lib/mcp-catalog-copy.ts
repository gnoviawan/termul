/**
 * Plain-English labels for catalog states and reasons (SPEC CAP-4). Values in
 * a reason (`transport`, `name`, `registryType`, `registry`, `runtimeHint`) come from the
 * registry entry; React renders them as text, never markup.
 */

import type {
  McpCatalogReason,
  McpCatalogRunner,
  McpCatalogState,
  McpCatalogStatus
} from '@shared/types/mcp-catalog.types'

export const MCP_CATALOG_STATE_LABEL: Record<McpCatalogState, string> = {
  installable: 'Installable',
  'needs-runtime': 'Needs a runtime',
  unsupported: 'Unsupported',
  'source-only': 'Source only'
}

const RUNTIME_NAME: Record<McpCatalogRunner, string> = {
  npx: 'Node.js (npx)',
  uvx: 'uv (uvx)',
  docker: 'Docker',
  dotnet: '.NET SDK 10 or newer'
}

export function mcpCatalogReasonText(reason: McpCatalogReason): string {
  switch (reason.code) {
    case 'needs-runtime':
      return `Install ${RUNTIME_NAME[reason.runtime]} on this computer to run it.`
    case 'no-install-options':
      return 'The registry lists only its source code, with no package or hosted URL to install.'
    case 'unparseable':
      return "Termul couldn't read this server's registry entry."
    case 'insecure-url':
      return "Its hosted URL doesn't use https."
    case 'local-network-url':
      return 'Its hosted URL points to a local or private network address.'
    case 'invalid-url':
      return "Its hosted URL isn't a valid web address."
    case 'unknown-remote-transport':
      return `Its hosted URL uses the "${reason.transport}" transport, which Termul doesn't support.`
    case 'secret-in-url':
      return 'Its hosted URL must carry a secret, and Termul never stores secrets in URLs.'
    case 'secret-in-arguments':
      return 'Its launch arguments must carry a secret, and Termul never stores secrets in arguments.'
    case 'runtime-arguments':
      return 'It needs extra options passed to its runtime, which Termul does not allow.'
    case 'runtime-hint-mismatch':
      return `It asks to run with "${reason.runtimeHint}", which doesn't match its package type.`
    case 'denied-env':
      return `It sets ${reason.name}, an environment variable Termul blocks because it can change what runs.`
    case 'invalid-env-name':
      return `It uses "${reason.name}", which isn't a valid environment variable name.`
    case 'unsupported-registry-type':
      return `Its package comes from ${reason.registryType}, which Termul can't install from.`
    case 'non-stdio-transport':
      return `Its package talks over "${reason.transport}". Termul runs packages over stdio only.`
    case 'unpinned-version':
      return "Its package has no fixed version, so Termul can't pin what it runs."
    case 'invalid-package':
      return "Its package name or version isn't valid."
    case 'unsupported-registry':
      return `Its package is hosted on ${reason.registry}, which Termul doesn't download from.`
    case 'invalid-command':
      return 'Its command starts with "-", so it would be read as an option.'
    case 'invalid-header-name':
      return `It sends "${reason.name}", which isn't a valid HTTP header name.`
    case 'control-character':
      return `Its ${reason.field} holds a control character.`
    case 'duplicate-name':
      return `It lists "${reason.name}" more than once.`
    case 'unsupported-launch-argument':
      return `It passes ${reason.argument} to ${reason.command}, which Termul doesn't allow because it can change what runs.`
    case 'unsupported-runner':
      return `It runs its package through ${reason.command}, which Termul can't check. Use npx, uvx, docker or dotnet dnx instead.`
    case 'cmd-metacharacter':
      return `Its ${reason.field} holds a character Windows reads as a command operator (& | < > ^ % ! " ( or )).`
  }
}

const count = new Intl.NumberFormat('en-US')
const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
const timeOfDay = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' })

export function mcpCatalogUpdatedText(updatedAt: string | null): string {
  return updatedAt === null
    ? 'No catalog is loaded yet.'
    : `Updated ${dateTime.format(new Date(updatedAt))}.`
}

export function mcpCatalogSampleText(status: McpCatalogStatus): string | null {
  if (!status.sample) return null
  const next =
    status.sync.state === 'disabled'
      ? 'Turn on sync to load the full catalog.'
      : 'Sync replaces it with the full catalog.'
  return `This is the small sample bundled with this build, not the full registry. ${next}`
}

export function mcpCatalogSyncText(status: McpCatalogStatus, now = new Date()): string | null {
  const { sync } = status
  switch (sync.state) {
    case 'disabled':
      return 'Sync is off. No catalog request leaves this host.'
    case 'idle':
      return status.sample ? null : 'Up to date.'
    case 'syncing':
      return sync.full
        ? `Downloading the full registry… ${count.format(sync.fetched)} servers so far.`
        : 'Checking for updates…'
    case 'failed': {
      const retryAt = new Date(sync.retryAt)
      const when =
        retryAt.toDateString() === now.toDateString()
          ? timeOfDay.format(retryAt)
          : dateTime.format(retryAt)
      return `Sync failed: ${sync.error.replace(/\.$/, '')}. Retrying at ${when}.`
    }
  }
}

export function mcpCatalogSyncErrorText(code: string): string {
  return code === 'FORBIDDEN'
    ? 'Only the host can change catalog sync.'
    : "Couldn't change catalog sync. Try again."
}

export type McpInstallBlock = 'view-only' | 'no-project'

export const MCP_INSTALL_BLOCK_TEXT: Record<McpInstallBlock, string> = {
  'view-only': "This connection can't make changes on the host, so it can't install servers.",
  'no-project': 'Open a project to install servers. This server saves MCP servers per project.'
}
