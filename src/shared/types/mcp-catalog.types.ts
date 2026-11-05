/**
 * Wire shapes of the host-owned MCP server catalog (spine AD-1 to AD-4).
 */

import type { IpcResult } from './ipc.types'
import type { McpInstallApi } from './mcp-install.types'

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io'

/** The host's caps on a search query (`search.rs` `MAX_QUERY_CHARS`, `MAX_QUERY_TERMS`). */
export const MCP_CATALOG_MAX_QUERY_CHARS = 200
export const MCP_CATALOG_MAX_QUERY_TERMS = 8

/** Ranked best first; an item takes its best option's state. */
export type McpCatalogState = 'installable' | 'needs-runtime' | 'unsupported' | 'source-only'

/** The fixed runner a package option launches through. */
export type McpCatalogRunner = 'npx' | 'uvx' | 'docker' | 'dotnet'

/** Why an item is not installable. `null` on an installable row. */
export type McpCatalogReason =
  | { code: 'needs-runtime'; runtime: McpCatalogRunner }
  | { code: 'no-install-options' }
  | { code: 'unparseable' }
  | { code: 'insecure-url' }
  | { code: 'local-network-url' }
  | { code: 'invalid-url' }
  | { code: 'unknown-remote-transport'; transport: string }
  | { code: 'secret-in-url' }
  | { code: 'secret-in-arguments' }
  | { code: 'runtime-arguments' }
  | { code: 'runtime-hint-mismatch'; runtimeHint: string }
  | { code: 'denied-env'; name: string }
  | { code: 'invalid-env-name'; name: string }
  | { code: 'unsupported-registry-type'; registryType: string }
  | { code: 'non-stdio-transport'; transport: string }
  | { code: 'unpinned-version' }
  | { code: 'invalid-package' }
  | { code: 'unsupported-registry'; registry: string }
  | { code: 'invalid-command' }
  | { code: 'invalid-header-name'; name: string }
  | { code: 'control-character'; field: string }
  | { code: 'duplicate-name'; name: string }
  | { code: 'cmd-metacharacter'; field: string }
  | { code: 'unsupported-launch-argument'; command: string; argument: string }
  | { code: 'unsupported-runner'; command: string }

/** The option an install would use: an index into the row's `remotes` or `packages`. */
export interface McpCatalogDefaultOption {
  kind: 'remote' | 'package'
  index: number
}

export interface McpCatalogRow {
  /** Registry `name`, the catalog item id. */
  name: string
  title: string | null
  description: string
  version: string
  /** Deleted rows never browse. */
  status: 'active' | 'deprecated'
  state: McpCatalogState
  reason: McpCatalogReason | null
  defaultOption: McpCatalogDefaultOption | null
  /** Host-validated `https` link, or `null`. */
  repositoryUrl: string | null
  hasIcon: boolean
}

export interface McpCatalogSearchRequest {
  query?: string
  /** The `nextCursor` of the previous page of the same query. */
  cursor?: string
  /** 1 to 100, default 50. */
  limit?: number
}

export interface McpCatalogSource {
  updatedAt: string | null
  sample: boolean
}

export interface McpCatalogPage extends McpCatalogSource {
  items: McpCatalogRow[]
  nextCursor: string | null
  total: number
}

export type McpCatalogSync =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'syncing'; full: boolean; fetched: number }
  | { state: 'failed'; error: string; retryAt: string }

export interface McpCatalogStatus extends McpCatalogSource {
  servers: number
  sync: McpCatalogSync
}

export interface McpCatalogIconPayload {
  contentType: string
  base64: string
}

/**
 * A logo as a `data:` URL, never a `blob:` URL. A `blob:` URL shares the app's
 * origin, so opening a registry SVG through one runs its script against the
 * app's storage. A `data:` document has an opaque origin (spine AD-15).
 */
export type McpCatalogIconUrl = `data:${string}`

export interface McpCatalogApi extends McpInstallApi {
  search(request: McpCatalogSearchRequest): Promise<IpcResult<McpCatalogPage>>
  status(): Promise<IpcResult<McpCatalogStatus>>
  setSync(enabled: boolean): Promise<IpcResult<McpCatalogStatus>>
  icon(name: string): Promise<IpcResult<McpCatalogIconUrl>>
}
