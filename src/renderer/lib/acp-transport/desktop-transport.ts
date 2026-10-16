/**
 * Desktop ACP transport (E6): the `/ws` protocol client over the Tauri IPC
 * Channel carrier.
 *
 * Everything with a `/ws` request type — spawn/kill/list, sessions, prompts,
 * permissions, catalog install, `subscribe` cursors, the `commandId` journal,
 * heartbeat and reconnect — runs through the inherited {@link WsAcpTransport}
 * exactly as in the browser; only the socket differs ({@link ChannelSocket}).
 *
 * Stays on a Tauri `invoke` (no `/ws` equivalent, host-local by design):
 * registry snapshot/binary install, runtime + MCP probes and the ACP timeout
 * overrides. Dialogs, windows, browser consent and MCP OAuth start live in
 * `acp-api.ts`.
 *
 * Desktop history stays in the Tauri store: `historyMode()` is `'tauri_store'`
 * whatever the relay negotiated, and no auth token is presented — the process
 * boundary is the auth (the host waives the token check on this carrier).
 */

import { invoke } from '@tauri-apps/api/core'
import type {
  AcpRegistrySnapshot,
  InstallAcpRegistryBinaryOutcome,
  InstallAcpRegistryBinaryRequest,
  McpServerConfig,
  ProbeResult
} from '@/lib/acp-api'
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'
import { ChannelSocket } from './channel-socket'
import { isDesktopLocalEvent, onDesktopLocalEvent } from './desktop-local-events'
import { AcpTransportError, type AgentIdleWindowStatus, type SessionCursor } from './types'
import { WsAcpTransport } from './ws-transport'

/** Placeholder URL: the Channel carrier has no endpoint, but logs/diagnostics name one. */
export const DESKTOP_CHANNEL_URL = 'channel://desktop'

export class DesktopAcpTransport extends WsAcpTransport {
  constructor() {
    super({
      url: DESKTOP_CHANNEL_URL,
      // `ChannelSocket` implements the WebSocket surface the client uses.
      WebSocketImpl: ChannelSocket as unknown as typeof WebSocket
    })
  }

  override historyMode(): 'tauri_store' {
    return 'tauri_store'
  }

  protected override authenticateToken(): null {
    return null
  }

  /**
   * Desktop sessions are replayed from the Tauri store, not a host-persisted
   * log, so a host that reports history as unsupported simply has no cursor
   * to seed: start live-only instead of failing the resume.
   */
  override async fetchSessionCursor(sessionId: string): Promise<SessionCursor> {
    try {
      return await super.fetchSessionCursor(sessionId)
    } catch (err) {
      if (err instanceof AcpTransportError && err.code === 'unsupported') {
        return { lastSeq: 0, logEpoch: null }
      }
      throw err
    }
  }

  /**
   * Relay events arrive on the Channel; the few desktop-local `acp:*` events
   * (worktree progress) are plain Tauri events and never touch the relay.
   */
  override onEvent<T>(
    eventName: string,
    callback: (payload: T, eventSeq?: number) => void
  ): () => void {
    if (isDesktopLocalEvent(eventName)) return onDesktopLocalEvent<T>(eventName, callback)
    return super.onEvent(eventName, callback)
  }

  override installRegistryBinary(
    request: InstallAcpRegistryBinaryRequest
  ): Promise<InstallAcpRegistryBinaryOutcome> {
    return invoke<InstallAcpRegistryBinaryOutcome>('acp_install_registry_binary', { request })
  }

  override probeRuntime(): Promise<AcpRuntimeAvailability> {
    return invoke<AcpRuntimeAvailability>('acp_probe_runtime')
  }

  override probeMcpServer(server: McpServerConfig): Promise<ProbeResult> {
    return invoke<ProbeResult>('acp_probe_mcp_server', { server })
  }

  override fetchRegistrySnapshot(forceRefresh = false): Promise<AcpRegistrySnapshot> {
    return invoke<AcpRegistrySnapshot>('acp_fetch_registry_snapshot', { forceRefresh })
  }

  override setTurnTimeout(secs: number | null): Promise<void> {
    return invoke<void>('acp_set_turn_timeout', { secs })
  }

  override setTurnIdleTimeout(secs: number | null): Promise<void> {
    return invoke<void>('acp_set_turn_idle_timeout', { secs })
  }

  override setSessionNewTimeout(secs: number | null): Promise<void> {
    return invoke<void>('acp_set_session_new_timeout', { secs })
  }

  override setSessionReopenTimeout(secs: number | null): Promise<void> {
    return invoke<void>('acp_set_session_reopen_timeout', { secs })
  }

  override setAgentIdleWindow(secs: number | null): Promise<void> {
    return invoke<void>('acp_set_agent_idle_window', { secs })
  }

  override getAgentIdleWindow(): Promise<AgentIdleWindowStatus> {
    return invoke<AgentIdleWindowStatus>('acp_get_agent_idle_window')
  }
}
