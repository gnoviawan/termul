/**
 * ACP transport contract (Story 1.6): the shared error surface +
 * {@link AcpTransport} interface implemented by the multiplexed `/ws` client
 * (`./ws-transport`) and its desktop subclass over the Tauri IPC Channel
 * (`./desktop-transport`).
 */

import {
  type HistoryMode,
  type PersistedSessionSummary,
  type SessionSnapshotEvent,
  WS_ERROR_CODES,
  type WsAgentSummary
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
  PromptDispatchResult,
  SessionConfigOption,
  SessionId,
  SessionReopenOutcome,
  SpawnAgentResult
} from '@/lib/acp-api'
import type { SessionPayload } from '@/lib/acp-history-persistence'
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'
import type { WatchClient } from './watch-client'

/**
 * What the user reads for a host `outcome_unknown` (the spec label): the host no
 * longer knows whether the command took effect, and will not run it again.
 */
export const OUTCOME_UNKNOWN_MESSAGE = 'Outcome unknown — check whether it took effect'

/** Thrown on WS (and mapped) failures — callers may toast `.message`. */
export class AcpTransportError extends Error {
  readonly code: string
  /**
   * The session seq at which the host's reply became visible (`visible_at`),
   * when the reply carried one. Absent on transport-local failures.
   */
  readonly visibleAt?: number

  constructor(code: string, message: string, visibleAt?: number) {
    super(code === WS_ERROR_CODES.OUTCOME_UNKNOWN ? OUTCOME_UNKNOWN_MESSAGE : message)
    this.name = 'AcpTransportError'
    this.code = code
    if (visibleAt !== undefined) this.visibleAt = visibleAt
  }
}

/**
 * Local code for "the first run of this command is still going" — the `/ws`
 * `{ receipt: "in_progress" }` payload. The command is neither accepted nor rejected: it stays pending.
 */
export const COMMAND_IN_PROGRESS_CODE = 'command_in_progress'
/**
 * Local code for a `command_accepted` verdict: the command ran, its
 * result is not retained. Resolves the command as accepted without a payload.
 */
export const COMMAND_ACCEPTED_CODE = 'command_accepted'

/** Optional trailing bag on the ledgered mutating transport methods. */
export interface CommandCallOptions {
  /**
   * Client-minted command id (AD-5): set on the frame (`/ws`) or passed as the
   * `commandId` argument (Tauri) so the host can dedupe a same-id resend.
   */
  commandId?: string
  /** Called with the host's `visible_at` session seq when the reply carries one. */
  onVisibleAt?: (visibleAt: number) => void
}

/** `visible_at` is a session seq; anything else on the wire is ignored. */
export function parseVisibleAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function isTransientAcpTransportError(error: unknown): error is AcpTransportError {
  return (
    error instanceof AcpTransportError &&
    (error.code === 'closed' || error.code === 'timeout' || error.code === 'agent_crashed')
  )
}

/**
 * A command failed in a way that says nothing about whether the host accepted
 * it: the socket dropped / timed out (transient), the local client refused to
 * connect (`unauthorized` — the token-halt state), the host no longer knows
 * the outcome (`outcome_unknown`) or is still running the first attempt
 * (`command_in_progress`). Such a command stays pending / pending-reconcile and
 * is never reported as rejected; only any OTHER code is an explicit host
 * rejection.
 */
export function isOutcomeUncertainError(error: unknown): error is AcpTransportError {
  return (
    isTransientAcpTransportError(error) ||
    (error instanceof AcpTransportError &&
      (error.code === WS_ERROR_CODES.UNAUTHORIZED ||
        error.code === WS_ERROR_CODES.OUTCOME_UNKNOWN ||
        error.code === COMMAND_IN_PROGRESS_CODE))
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

/**
 * A session replay cursor. `lastSeq` is only meaningful against the host log
 * incarnation `logEpoch` names (`null` when the host did not report one).
 */
export interface SessionCursor {
  lastSeq: number
  logEpoch: string | null
}

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
  installAcpAgent(
    agentId: string,
    options?: CommandCallOptions
  ): Promise<InstallAcpRegistryBinaryOutcome>
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
  spawnAgent(config: AgentConfig, options?: CommandCallOptions): Promise<SpawnAgentResult>
  killAgent(agentId: AgentId): Promise<void>
  listAgents(): Promise<AgentId[]>
  /**
   * CAP-11: identity-rich agent summaries (`{ id, name, configId?, namespace?,
   * capabilities, ownsSession? }`). WS: the `list_agents` reply; desktop: the
   * `acp_list_agent_details` command. `listAgents` keeps returning bare ids.
   * `ownsSession` (issue #837) is the agent's owned-session set — current
   * servers always send it; older servers omit it (treated as unknown/none).
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
      additionalDirectories?: string[]
    } & CommandCallOptions
  ): Promise<NewSessionOutcome>
  loadSession(
    agentId: AgentId,
    sessionId: SessionId,
    cwd: string,
    additionalDirectories?: string[],
    options?: CommandCallOptions
  ): Promise<SessionReopenOutcome>
  resumeSession(
    agentId: AgentId,
    sessionId: SessionId,
    cwd: string,
    additionalDirectories?: string[],
    options?: CommandCallOptions
  ): Promise<SessionReopenOutcome>
  deleteAgentSession(
    agentId: AgentId,
    sessionId: SessionId,
    options?: CommandCallOptions
  ): Promise<void>
  logout(agentId: AgentId, options?: CommandCallOptions): Promise<void>
  respondElicitation(
    agentId: AgentId,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    // GH-935: `string[]` = multi-select (`multi-enum`) answers; both
    // transports forward the map verbatim to the host.
    content?: Record<string, string | number | boolean | string[]>,
    options?: CommandCallOptions
  ): Promise<void>
  closeSession(agentId: AgentId, sessionId: SessionId, options?: CommandCallOptions): Promise<void>
  disposeEphemeralSession(
    agentId: AgentId,
    sessionId: SessionId,
    options?: CommandCallOptions
  ): Promise<void>
  /**
   * Story 8: promote a backend-ephemeral warm-pool session to durable
   * (registers persistence metadata + clears the ephemeral mark server-side),
   * then (web) subscribe so subsequent turns stream to this client.
   * Idempotent for already-durable sessions.
   */
  promoteSession?(
    agentId: AgentId,
    sessionId: SessionId,
    options?: CommandCallOptions
  ): Promise<void>
  listSessions(agentId: AgentId, cwd?: string, cursor?: string): Promise<ListSessionsResponse>
  registerDiscoveredSession(
    input: {
      sessionId: SessionId
      agentId: AgentId
      cwd: string
      title?: string | null
      updatedAt?: number
      projectId?: string
    },
    options?: CommandCallOptions
  ): Promise<PersistedSessionSummary>
  /**
   * CAP-2 (spec-in-chat-agent-switch): durably record an agent-switch
   * marker. Host is the sole author — one `agent_switch` record that the
   * relay numbers, persists and delivers live under the same seq.
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
    },
    options?: CommandCallOptions
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
  ): Promise<PromptDispatchResult>
  sendPromptBlocks(
    agentId: AgentId,
    sessionId: SessionId,
    content: ContentBlock[],
    turnId?: string,
    displayContent?: ContentBlock[]
  ): Promise<PromptDispatchResult>
  cancelPrompt(agentId: AgentId, sessionId: SessionId): Promise<void>
  setConfigOption(
    agentId: AgentId,
    sessionId: SessionId,
    configId: string,
    valueId: string | boolean
  ): Promise<SessionConfigOption[] | null>
  setMode(agentId: AgentId, sessionId: SessionId, modeId: string): Promise<void>
  setModel(agentId: AgentId, sessionId: SessionId, modelId: string): Promise<void>
  respondPermission(
    agentId: AgentId,
    requestId: string,
    optionId?: string,
    options?: CommandCallOptions
  ): Promise<void>
  answerQuestion(
    agentId: AgentId,
    questionId: string,
    values?: string[],
    options?: CommandCallOptions
  ): Promise<void>
  /** Agent ACP auth (methodId) — NOT the WS relay token gate. */
  authenticate(
    agentId: AgentId,
    methodId: string,
    gateway?: { baseUrl: string; apiKey?: string },
    options?: CommandCallOptions
  ): Promise<void>
  /**
   * Headless ACP auth paste-back (spec-acp-terminal-auth): deliver a
   * user-pasted loopback OAuth redirect URL to the agent's callback listener
   * on the host. The host validates http(s) + loopback-only before fetching
   * (SSRF guard) and returns the replay's HTTP status. Tauri:
   * `acp_auth_deliver_redirect`; WS: `acp_deliver_auth_redirect`.
   */
  deliverAuthRedirect(agentId: AgentId, url: string, options?: CommandCallOptions): Promise<number>
  /**
   * Web/remote only: the watches (projects, chat-history index, agent roster,
   * project file changes, store keys, terminal sets). Absent on Tauri IPC
   * (desktop), where those stores are local.
   */
  readonly watches?: WatchClient
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
   * The second argument is only meaningful when `reconnecting` is `false`:
   * `true` = the channel genuinely recovered (open, authed, re-subscribed);
   * `false` = the cycle ended WITHOUT recovery (token-class halt), so
   * nothing may assume the host is reachable.
   * Only on the WS transport — absent on Tauri IPC (desktop). The store
   * checks for the method before calling it.
   */
  setReconnectListener?(listener: (reconnecting: boolean, recovered?: boolean) => void): void
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
  getSessionCursor?(sessionId: SessionId): SessionCursor | null
  /** R2: fetch the server-authoritative replay watermark for a session
   * (without subscribing). Used by the refresh-resume hook to seed a fresh
   * transport's `lastSeq` BEFORE the first `subscribeSession` so the
   * reload-gap events replay instead of running live-only. Desktop: absent
   * (Tauri IPC resumes via `session/load` replay — no WS cursor). */
  fetchSessionCursor?(sessionId: SessionId): Promise<SessionCursor>
  /** R2: seed the in-memory `lastSeq` from a server watermark without
   * subscribing (WS only). Call before `resumeSession` so its built-in
   * re-subscribe uses the server cursor, not a dead per-instance 0. */
  seedSessionCursor?(sessionId: SessionId, cursor: SessionCursor): void
  setReconnectPriorityProvider?(provider: () => SessionId[]): void
  dispose(): void
}
