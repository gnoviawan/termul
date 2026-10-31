/**
 * Wire shapes of the host-owned MCP server catalog (spine AD-1 to AD-4).
 *
 * The host converts the official MCP Registry snapshot and answers paged
 * search. Every transport (`GET /mcp-catalog/search` and the `/ws` request
 * `search_mcp_catalog` on the web socket and the desktop channel) returns the
 * same `IpcResult<McpCatalogPage>`. The renderer never holds the full catalog
 * and never parses `server.json`.
 */

import type { IpcResult } from './ipc.types'
import type { McpInstallApi } from './mcp-install.types'

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

export interface McpCatalogPage {
  items: McpCatalogRow[]
  nextCursor: string | null
  total: number
  /** When the bundled snapshot was fetched; `null` if it failed to load. */
  snapshotFetchedAt: string | null
}

/**
 * The renderer facade. The desktop impl sends `search_mcp_catalog` over the
 * Tauri channel; the web impl calls `GET /mcp-catalog/search`.
 */
export interface McpCatalogApi extends McpInstallApi {
  search(request: McpCatalogSearchRequest): Promise<IpcResult<McpCatalogPage>>
}
