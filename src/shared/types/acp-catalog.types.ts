/**
 * Host-owned ACP catalog contract (CAP-6 / Story 8).
 *
 * Mirrors the Rust serde shapes in `src-tauri/src/acp/catalog.rs` byte-for-byte
 * (camelCase). The host resolves the catalog (OS/arch/runtime + per-agent
 * `SupportedAcpAgentStatus`) and serves it across all three transports (Tauri
 * command `acp_list_catalog`, HTTP `GET /acp/catalog`, WS `list_acp_catalog`).
 * The renderer facade (`acp-catalog-api.ts`) resolves Tauri vs HTTP at runtime;
 * the WS transport implements the real `listCatalog()` request.
 *
 * The catalog is credential-free, path-free, read-only host introspection —
 * never carries `AgentConfig.env` (API keys) or resolved absolute executable
 * paths. The opt-in is a single boolean that gates CDN registry augmentation.
 */

import type { IpcResult } from './ipc.types'

/** The 5-state per-agent installability status. Mirrors the Rust enum. */
export type SupportedAcpAgentStatus =
  | 'ready'
  | 'install-required'
  | 'needs-runtime'
  | 'manual-install'
  | 'unavailable'

/** Whether a catalog entry came from the trusted bundled baseline or the CDN. */
export type CatalogSource = 'bundled' | 'registry'

/** Host runtime availability. Mirrors `CatalogRuntimeAvailability` (camelCase). */
export interface CatalogRuntimeAvailability {
  npx: boolean
  uvx: boolean
  node: boolean
  bun: boolean
  python3: boolean
}

/** Host capability block: OS + arch + runtime availability. */
export interface HostCapability {
  os: string
  arch: string
  runtimes: CatalogRuntimeAvailability
}

/** A platform target pair (e.g. `{ os: 'linux', arch: 'x86_64' }`). */
export interface PlatformTarget {
  os: string
  arch: string
}

/**
 * One resolved catalog entry. Carries identity + distribution metadata +
 * computed `status` + `runtimeRequirements` + `platformTargets`. Never
 * carries `AgentConfig.env` (API keys) or resolved absolute executable paths.
 */
export interface CatalogAgent {
  id: string
  name: string
  version: string
  description: string
  source: CatalogSource
  /** The distribution metadata from the bundled/CDN catalog (passed through). */
  distribution: Record<string, unknown>
  /** Runtime requirements (e.g. `['npx']` for npx-distributed agents). */
  runtimeRequirements: string[]
  status: SupportedAcpAgentStatus
  /** Platform targets for binary-distributed agents; empty for npx/uvx. */
  platformTargets: PlatformTarget[]
}

/** The resolved catalog payload served across all three transports. */
export interface AcpCatalog {
  host: HostCapability
  agents: CatalogAgent[]
}

/** `POST /acp/catalog/opt-in` + WS `set_catalog_opt_in` request body. */
export interface SetCatalogOptInRequest {
  enabled: boolean
}

/**
 * `acp_list_catalog(refresh?: boolean)` — resolve the host-owned ACP catalog.
 * Returns the host's OS/arch/runtime availability + per-agent resolved
 * `SupportedAcpAgentStatus`. Mirrors `GET /acp/catalog` + WS `list_acp_catalog`.
 */
export type AcpCatalogListChannel = (refresh?: boolean) => Promise<IpcResult<AcpCatalog>>

/**
 * `acp_set_catalog_opt_in(enabled: boolean)` — persist the host opt-in flag
 * that gates the CDN registry augmentation. Mirrors `POST /acp/catalog/opt-in`
 * + WS `set_catalog_opt_in`.
 */
export type AcpCatalogSetOptInChannel = (enabled: boolean) => Promise<IpcResult<void>>

/**
 * The renderer-facing ACP catalog facade. Resolves to the Tauri command impl
 * when running inside a Tauri webview, the HTTP fetch impl when running as a
 * web/remote client. Both impls return the same `IpcResult<...>` shape
 * byte-for-byte (the parity-checklist test pins this).
 */
export interface AcpCatalogApi {
  listCatalog: AcpCatalogListChannel
  setCatalogOptIn: AcpCatalogSetOptInChannel
  /** Read the current opt-in flag (without mutating it). */
  isCatalogOptedIn: () => Promise<IpcResult<boolean>>
}
