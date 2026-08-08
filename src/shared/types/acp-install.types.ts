/**
 * Host-owned verified-atomic ACP install contract (CAP-6 / Story 9).
 *
 * Mirrors the Rust serde shapes in `src-tauri/src/acp/install.rs` byte-for-byte
 * (camelCase). The host downloads + verifies (sha256) + extracts + atomically
 * activates ACP agent archives resolved from the catalog, records an
 * installed-agents manifest, and serves `install_agent(agentId)` across all
 * three transports (Tauri command `acp_install_agent`, HTTP `POST /acp/install`,
 * WS `install_acp_agent`).
 *
 * The request is `{ agentId }` ONLY; the host resolves everything (archive URL,
 * cmd, args, env, sha256) from the trusted catalog — never accepts
 * browser-supplied URLs, commands, executable paths, or args.
 */

import type { IpcResult } from './ipc.types'

/** `POST /acp/install` + WS `install_acp_agent` + Tauri `acp_install_agent` body. */
export interface InstallRequest {
  agentId: string
}

/**
 * The install outcome (the existing contract the renderer wraps into
 * `AgentConfig` via `installedBinaryConfig`). `command` is the absolute path
 * to the resolved executable under the install root; `args` is the catalog
 * target's `args` (or empty).
 */
export interface InstallOutcome {
  command: string
  args: string[]
}

/**
 * Install error codes (SCREAMING_SNAKE_CASE, byte-identical across all three
 * transports — Tauri `IpcResult.code`, HTTP `IpcBody.code`, WS
 * `WsReply.err.code`). Mirrors the Rust `InstallError::code` strings.
 */
export type InstallErrorCode =
  | 'INTEGRITY_MISMATCH'
  | 'INTEGRITY_METADATA_MISSING'
  | 'UNSUPPORTED_PLATFORM'
  | 'ARCHIVE_TOO_LARGE'
  | 'EXTRACTION_QUOTA_EXCEEDED'
  | 'PATH_TRAVERSAL_DETECTED'
  | 'DOWNLOAD_FAILED'
  | 'CATALOG_AGENT_NOT_FOUND'
  | 'NOT_INSTALLABLE'
  | 'ACP_INSTALL_UNAVAILABLE'
  | 'VALIDATION_ERROR'
  | 'INSTALL_FAILED'

/**
 * `acp_install_agent(agentId)` — host-owned verified-atomic ACP install.
 * Returns `{ command: absolute_path, args }` on success. Errors carry the
 * codes above. Mirrors `POST /acp/install` + WS `install_acp_agent`.
 */
export type AcpInstallAgentChannel = (agentId: string) => Promise<IpcResult<InstallOutcome>>

/**
 * The renderer-facing ACP install facade. Resolves to the Tauri command impl
 * when running inside a Tauri webview, the HTTP fetch impl when running as a
 * web/remote client. Both impls return the same `IpcResult<...>` shape
 * byte-for-byte (the parity-checklist test pins this).
 */
export interface AcpInstallApi {
  installAgent: AcpInstallAgentChannel
}
