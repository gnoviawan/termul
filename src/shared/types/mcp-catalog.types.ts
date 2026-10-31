/**
 * Wire shapes of the host-owned MCP server catalog (spine AD-1 to AD-4).
 *
 * The host converts the official MCP Registry snapshot, keeps it current with
 * live sync, and answers paged search. Every transport (the HTTP routes under
 * `/mcp-catalog/` and the matching `/ws` requests on the web socket and the
 * desktop channel) returns the same `IpcResult`. The renderer never holds the
 * full catalog and never parses `server.json`.
 */

import type { IpcResult } from './ipc.types'

/** The registry every catalog row comes from (spine AD-2). */
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
}

export interface McpCatalogSearchRequest {
  query?: string
  /** The `nextCursor` of the previous page of the same query. */
  cursor?: string
  /** 1 to 100, default 50. */
  limit?: number
}

/** Which registry data a catalog holds. */
export interface McpCatalogSource {
  /** When its newest registry data was fetched; `null` if no catalog loaded. */
  updatedAt: string | null
  /** The small sample bundled with development builds, not the full registry. */
  sample: boolean
}

export interface McpCatalogPage extends McpCatalogSource {
  items: McpCatalogRow[]
  nextCursor: string | null
  total: number
}

/**
 * The host's live sync (spine AD-3). Off means no catalog request leaves the
 * host. A full sync crawls the whole registry; the others fetch what changed.
 */
export type McpCatalogSync =
  | { state: 'disabled' }
  | { state: 'idle' }
  | { state: 'syncing'; full: boolean; fetched: number }
  | { state: 'failed'; error: string; retryAt: string }

export interface McpCatalogStatus extends McpCatalogSource {
  /** Browsable servers in the catalog search answers from. */
  servers: number
  sync: McpCatalogSync
}

/**
 * The renderer facade. The desktop impl sends the `/ws` requests
 * `search_mcp_catalog`, `get_mcp_catalog_status` and `set_mcp_catalog_sync`
 * over the Tauri channel; the web impl calls `GET /mcp-catalog/search`,
 * `GET /mcp-catalog/status` and `POST /mcp-catalog/sync`.
 */
export interface McpCatalogApi {
  search(request: McpCatalogSearchRequest): Promise<IpcResult<McpCatalogPage>>
  status(): Promise<IpcResult<McpCatalogStatus>>
  /** A write: shared-live and view-only peers get `FORBIDDEN`. */
  setSync(enabled: boolean): Promise<IpcResult<McpCatalogStatus>>
}
