/**
 * On-demand MCP client probe — standalone facade (mirrors the
 * `acp-mcp-persistence.ts` runtime-branching pattern).
 *
 * Statelessly probes a configured MCP server: opens a fresh rmcp client
 * connection, calls `initialize` + `tools/list`, then closes. The probe reflects
 * **Termul's own client connection** (NOT the agent's — the agent owns its own
 * connection inside its process). The status dot therefore answers "can Termul
 * reach this server and list its tools?" — see the spec's Design Notes.
 *
 * Branches on `isTauriContext()`:
 * - Desktop: Tauri `invoke('acp_probe_mcp_server', { server })`.
 * - Web/remote: `POST /mcp-servers/probe` runs the probe on the termul-server
 *   host (where stdio commands execute — matches GH-287's web-parity decision)
 *   and returns the same `IpcBody<ProbeResult>` shape.
 *
 * The probe itself never throws on a disconnected server — it returns
 * `ProbeResult { status: 'disconnected', error }`. Only transport/config
 * failures throw (which the store logs via `logFrontendError` — never with
 * env/header values, tokens, or credentials).
 *
 * On-demand only — each call opens a brand-new connection and tears it down
 * immediately after `tools/list` returns (or fails). No persistent always-on
 * connections.
 */

import { invoke } from '@tauri-apps/api/core'
import type { McpServerConfig, McpToolInfo, ProbeResult } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerMcpProbe } from '@/lib/web-server-api'

/**
 * Probe a configured MCP server. Stateless — the renderer supplies the full
 * `McpServerConfig` (no registry-store coupling). Never throws on a
 * disconnected server; throws only on transport/config failure.
 */
export async function probeMcpServer(server: McpServerConfig): Promise<ProbeResult> {
  if (isTauriContext()) {
    return invoke<ProbeResult>('acp_probe_mcp_server', { server })
  }
  const res = await webServerMcpProbe.post(server)
  if (!res.success) {
    // Boundary log: outcome + server name + transport only — NO env/header
    // values, tokens, or credentials. The error string from the route is
    // already value-free (it carries only a code/message like
    // `MCP_PROBE_INVALID_CONFIG` / `NETWORK_ERROR`).
    void logFrontendError({
      source: 'acp-mcp-probe.probeMcpServer',
      message: `MCP probe transport failed for server '${server.name}' (${res.code}: ${res.error})`
    })
    return {
      status: 'disconnected',
      tools: [],
      error: res.error || res.code
    }
  }
  return res.data as ProbeResult
}

/** Thin wrapper: probe + return just the tool list (auto-probe on expand). */
export async function listMcpTools(server: McpServerConfig): Promise<McpToolInfo[]> {
  return (await probeMcpServer(server)).tools
}
