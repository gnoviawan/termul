/**
 * On-demand MCP client probe — canonical renderer facade.
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
 * Canonical contract (shared with `acpApi.probeMcpServer`/`listMcpTools`, which
 * delegate here): NEVER throws on a probe failure — returns
 * `ProbeResult { status: 'disconnected', error }` for transport/config failures
 * AND for unreachable servers. A disconnected probe is a successful probe of
 * an unreachable server. Only an unexpected throw (e.g. invoke IPC failure)
 * is normalized to a disconnected result here + logged via `logFrontendError`
 * (never with env/header values, tokens, or credentials). `listMcpTools`
 * consumes the normalized result and returns `[]` on any failure.
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
 * `McpServerConfig` (no registry-store coupling). Never throws — returns a
 * disconnected `ProbeResult` on transport/config/IPC failure, and logs the
 * failure outcome (server name + transport/code only — no env/header values).
 */
export async function probeMcpServer(server: McpServerConfig): Promise<ProbeResult> {
  if (isTauriContext()) {
    try {
      return await invoke<ProbeResult>('acp_probe_mcp_server', { server })
    } catch (err) {
      // IPC failure (command not registered, backend panic, etc.). The probe
      // command itself returns `Ok(ProbeResult)` for unreachable servers — a
      // throw here is a transport/IPC failure, normalized to disconnected.
      void logFrontendError({
        source: 'acp-mcp-probe.probeMcpServer',
        message: `MCP probe transport failed for server '${server.name}' (${String(err)})`
      })
      return {
        status: 'disconnected',
        tools: [],
        error: String(err)
      }
    }
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
