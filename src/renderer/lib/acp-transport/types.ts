/**
 * ACP transport contract (Story 1.6): the shared error surface +
 * {@link AcpTransport} interface implemented by both transports —
 * Tauri `invoke`/`listen` on desktop (`./tauri-transport`) and the
 * multiplexed `/ws` client on web/server (`./ws-transport`).
 */

import type { SwitchProjectReply } from '@shared/types/web-projects.types'
import type {
  HistoryMode,
  PersistedSessionSummary,
  SessionSnapshotEvent,
  WsAgentSummary
} from '@shared/types/web-protocol.types'
import type {
  AcpRegistrySnapshot,
  AgentConfig,
  AgentId,
  ContentBlock,
  InstallAcpRegistryBinaryOutcome,
  InstallAcpRegistryBinaryRequest,
  ListSessionsResponse,
  McpServer,
  McpServerConfig,
  NewSessionOutcome,
  ProbeResult,
  SessionConfigOption,
  SessionId,
  SessionReopenOutcome,
  SpawnAgentResult,
  StopReason
} from '@/lib/acp-api'
import type { SessionPayload } from '@/lib/acp-history-persistence'
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'

/** Thrown on WS (and mapped) failures — callers may toast `.message`. */
export class AcpTransportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AcpTransportError'
    this.code = code
  }
}

export function isTransientAcpTransportError(error: unknown): error is AcpTransportError {
  return (
    error instanceof AcpTransportError &&
    (error.code === 'closed' || error.code === 'timeout' || error.code === 'agent_crashed')
  )
}

/**
 * Story 10: coarse connection-health states for the WS channels (control
 * `/ws` and terminal `/terminal/ws` share the union). Feeds the global
 * connection-status store + StatusBar indicator. `connecting` = initial
 * connect in flight; `connected` = socket open + authed; `reconnecting` =
 * drop detected, backoff retry in progress; `disconnected` = gave up (the
 * terminal channel exhausts its retry budget; the control channel retries
 * forever and never reaches this state).
 */
export type AcpConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export interface AcpTransport {
  installRegistryBinary(
    request: InstallAcpRegistryBinaryRequest
  ): Promise<InstallAcpRegistryBinaryOutcome>
  /**
   * CAP-6 / Story 9: host-owned verified-atomic install. The web/remote
   * transport falls back to the `acpInstallApi` facade (Tauri vs HTTP
   * resolved at runtime); the desktop transport delegates to the new
   * `acp_install_agent` Tauri command. The request is `{ agentId }` only; the
   * host resolves everything from the trusted catalog.
   */
  installAcpAgent(agentId: string): Promise<InstallAcpRegistryBinaryOutcome>
  probeRuntime(): Promise<AcpRuntimeAvailability>
  setTurnTimeout(secs: number | null): Promise<void>
  setTurnIdleTimeout(secs: number | null): Promise<void>
  setSessionNewTimeout(secs: number | null): Promise<void>
  setSessionReopenTimeout(secs: number | null): Promise<void>
  fetchRegistrySnapshot(forceRefresh?: boolean): Promise<AcpRegistrySnapshot>
  /**
   * On-demand MCP client probe (Termul's own rmcp client connection — NOT the
   * agent's). Stateless: takes the renderer-supplied wire config, opens a fresh
   * rmcp client, calls `initialize` + `tools/list`, then closes. Desktop↔web
   * parity: on web the probe runs on the termul-server host via
   * `POST /mcp-servers/probe`. Never logs env/header values, tokens, or
   * credentials. The probe never throws on a disconnected server — it returns
   * `ProbeResult { status: 'disconnected', error }`; only transport/parse
   * failures throw `AcpTransportError`.
   */
  probeMcpServer(server: McpServerConfig): Promise<ProbeResult>
  spawnAgent(config: AgentConfig): Promise<SpawnAgentResult>
  killAgent(agentId: AgentId): Promise<void>
  listAgents(): Promise<AgentId[]>
  /**
   * CAP-11: identity-rich agent summaries (`{ id, name, configId?, namespace?,
   * capabilities }`). WS: the `list_agents` reply; desktop: the
   * `acp_list_agent_details` command. `listAgents` keeps returning bare ids.
   */
  listAgentDetails?(): Promise<WsAgentSummary[]>
  /**
   * CAP-11: permanently delete a host-persisted session (WS `delete_session`).
   * Server-mode only; desktop history delete flows through `acp_history_delete`
   * (`acpHistoryApi.delete`). Boolean contract (finding 6): resolves `true`
   * when the record was deleted, `false` when it was already absent
   * (idempotent no-op); genuine errors reject. Older servers report an
   * unknown id as `AcpTransportError` (`not_found`) — callers treat that as
   * the same idempotent success.
   */
  deleteSession?(sessionId: SessionId): Promise<boolean>
  newSession(
    agentId: AgentId,
    cwd: string,
    mcpServers?: McpServer[],
    options?: {
      ephemeral?: boolean
      /**
       * Story 8: the ephemeral session may later be promoted to durable via
       * `promoteSession` — the host keeps the plan-MCP injection it would
       * otherwise skip for ephemeral sessions. Ignored for non-ephemeral
       * creates; older servers ignore the unknown field (additive).
       */
      promotable?: boolean
      projectId?: string
      /** Worktree path + branch (CAP-3) — desktop-only; ignored on the WS path. */
      worktreePath?: string
      worktreeBranch?: string
    }
  ): Promise<NewSessionOutcome>
  loadSession(agentId: AgentId, sessionId: SessionId, cwd: string): Promise<SessionReopenOutcome>
  resumeSession(agentId: AgentId, sessionId: SessionId, cwd: string): Promise<SessionReopenOutcome>
  closeSession(agentId: AgentId, sessionId: SessionId): Promise<void>
  disposeEphemeralSession(agentId: AgentId, sessionId: SessionId): Promise<void>
  /**
   * Story 8: promote a backend-ephemeral warm-pool session to durable
   * (registers persistence metadata + clears the ephemeral mark server-side),
   * then (web) subscribe so subsequent turns stream to this client.
   * Idempotent for already-durable sessions.
   */
  promoteSession?(agentId: AgentId, sessionId: SessionId): Promise<void>
  listSessions(agentId: AgentId, cwd?: string, cursor?: string): Promise<ListSessionsResponse>
  registerDiscoveredSession(input: {
    sessionId: SessionId
    agentId: AgentId
    cwd: string
    title?: string | null
    updatedAt?: number
    projectId?: string
  }): Promise<PersistedSessionSummary>
  /**
   * CAP-2 (spec-in-chat-agent-switch): durably record an agent-switch
   * marker. Host is the sole author — one durable `agent_switch` record,
   * then the synthetic `acp:agent_switch` event fans out to live clients.
   * Tauri: `acp_record_agent_switch`; WS: `record_agent_switch`. Throws on
   * a host write failure (no partial state).
   */
  recordAgentSwitch(
    sessionId: SessionId,
    record: {
      fromConfigId: string
      toConfigId: string
      newSessionId: string
      summaryText: string
    }
  ): Promise<void>
  sendPrompt(
    agentId: AgentId,
    sessionId: SessionId,
    text: string,
    turnId?: string,
    /**
     * Display-side content persisted as the durable `user_prompt` record in
     * place of `text`/`content` (spec-agent-switch-separator-redesign): the
     * switch handoff wires `summary + --- + draft` to the agent but only the
     * draft belongs in the replayed transcript. Absent → the wire content is
     * persisted verbatim.
     */
    displayContent?: ContentBlock[]
  ): Promise<StopReason>
  sendPromptBlocks(
    agentId: AgentId,
    sessionId: SessionId,
    content: ContentBlock[],
    turnId?: string,
    displayContent?: ContentBlock[]
  ): Promise<StopReason>
  cancelPrompt(agentId: AgentId, sessionId: SessionId): Promise<void>
  setConfigOption(
    agentId: AgentId,
    sessionId: SessionId,
    configId: string,
    valueId: string
  ): Promise<SessionConfigOption[] | null>
  setMode(agentId: AgentId, sessionId: SessionId, modeId: string): Promise<void>
  setModel(agentId: AgentId, sessionId: SessionId, modelId: string): Promise<void>
  respondPermission(agentId: AgentId, requestId: string, optionId?: string): Promise<void>
  answerQuestion(agentId: AgentId, questionId: string, values?: string[]): Promise<void>
  /** Agent ACP auth (methodId) — NOT the WS relay token gate. */
  authenticate(agentId: AgentId, methodId: string): Promise<void>
  /**
   * Headless ACP auth paste-back (spec-acp-terminal-auth): deliver a
   * user-pasted loopback OAuth redirect URL to the agent's callback listener
   * on the host. The host validates http(s) + loopback-only before fetching
   * (SSRF guard) and returns the replay's HTTP status. Tauri:
   * `acp_auth_deliver_redirect`; WS: `acp_deliver_auth_redirect`.
   */
  deliverAuthRedirect(agentId: AgentId, url: string): Promise<number>
  /** Web/remote only: switch now or report that the switch was queued. */
  switchProject?(projectId: string): Promise<SwitchProjectReply>
  historyMode?(): HistoryMode | 'tauri_store'
  listPersistedSessions?(): Promise<PersistedSessionSummary[]>
  openPersistedSession?(sessionId: SessionId, lastSeq?: number): Promise<void>
  /** Web/remote: fetch the full stored transcript for a session (server mode). */
  getSessionPayload?(sessionId: SessionId): Promise<SessionPayload | null>
  /** Tail-first variant of `getSessionPayload`: fetches only the last `limit` messages. */
  getSessionPayloadTail?(sessionId: SessionId, limit: number): Promise<SessionPayload | null>
  /**
   * `eventSeq` is the server envelope seq of a per-session event (web only —
   * absent on Tauri IPC and on agent-level/relay frames). It lets store
   * handlers drop events already covered by the authoritative fetched payload
   * (CAP-3 replay contract).
   */
  onEvent<T>(eventName: string, callback: (payload: T, eventSeq?: number) => void): () => void
  /** Web: open socket + placeholder authenticate. No-op on Tauri. */
  connect(): Promise<void>
  /** Web: subscribe to a session with cursor for reconnect/gap-fill. */
  subscribeSession?(sessionId: SessionId, lastSeq?: number | null, force?: boolean): Promise<void>
  /**
   * Story 5.3 (AC3): register a listener for transport-level reconnect state.
   * Only on the WS transport — absent on Tauri IPC (desktop). The store
   * checks for the method before calling it.
   */
  setReconnectListener?(listener: (reconnecting: boolean) => void): void
  /**
   * Story 10: register a listener for coarse connection-health state (feeds
   * the global StatusBar indicator via the connection-status store). Only on
   * the WS transport — absent on Tauri IPC (desktop). Fires 'connecting' at
   * initial socket open, 'connected' once the auth handshake completes, and
   * 'reconnecting' when the backoff loop engages after a drop. Distinct from
   * `setReconnectListener` (boolean, session-overlay semantics): this one
   * also covers the initial connect.
   */
  setConnectionStateListener?(listener: (state: AcpConnectionState) => void): void
  /**
   * Story 10: the transport's current connection-health state (the last
   * value the listener saw, or the initial 'connecting'). The
   * connection-status store wiring replays it on registration so states
   * emitted before wiring are reflected. Only on the WS transport.
   */
  getConnectionState?(): AcpConnectionState
  setRecoveryHandler?(
    handler: (
      recovery: SessionSnapshotEvent | { sessionId: string; degraded: true },
      reopenGeneration?: number
    ) => Promise<void>
  ): void
  /**
   * Register a provider for the store's per-session reopen generation. The
   * transport captures it BEFORE the recovery round-trip and threads it to
   * the recovery handler so a late snapshot cannot install over a session
   * that was torn down or replaced mid-recovery. WS only.
   */
  setRecoveryGenerationProvider?(provider: (sessionId: SessionId) => number): void
  getSessionCursor?(sessionId: SessionId): number | null
  /** R2: fetch the server-authoritative replay watermark for a session
   * (without subscribing). Used by the refresh-resume hook to seed a fresh
   * transport's `lastSeq` BEFORE the first `subscribeSession` so the
   * reload-gap events replay instead of running live-only. Desktop: absent
   * (Tauri IPC resumes via `session/load` replay — no WS cursor). */
  fetchSessionCursor?(sessionId: SessionId): Promise<number>
  /** R2: seed the in-memory `lastSeq` from a server watermark without
   * subscribing (WS only). Call before `resumeSession` so its built-in
   * re-subscribe uses the server cursor, not a dead per-instance 0. */
  seedSessionCursor?(sessionId: SessionId, cursor: number): void
  setReconnectPriorityProvider?(provider: () => SessionId[]): void
  dispose(): void
}
