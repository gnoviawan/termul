/**
 * ACP transport abstraction (Story 1.6).
 *
 * Desktop: Tauri `invoke` / `listen`.
 * Web: multiplexed `/ws` client — request/reply by `id`, events with `seq`
 * dedup + gap-fill, cursor reconnect via `subscribe`, reliability tiers from
 * `@shared/types/web-protocol.types`.
 *
 * Envelope fields are snake_case; payloads stay camelCase (Story 1.4 AC3).
 * Event names: store uses `acp:*`; WS uses prefix-dropped types — translated here.
 *
 * Error bridge: WS `{ok:false,err:{code,message}}` throws `AcpTransportError`
 * (`.message` is the human string callers already toast).
 */

import type { IpcResult } from '@shared/types/ipc.types'
import type {
  ProjectSwitchCompletedEvent,
  SwitchProjectReply
} from '@shared/types/web-projects.types'
import {
  type AcpAuthenticateReply,
  type AcpRuntimePolicy,
  type HistoryMode,
  type PersistedSessionSummary,
  type SessionSnapshotEvent,
  WS_ERROR_CODES,
  type WsEvent,
  type WsReply,
  type WsRequest,
  type WsRequestType,
  wsTierOf
} from '@shared/types/web-protocol.types'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'
import { isTauriContext } from '@/lib/tauri-runtime'
import { webServerMcpProbe } from '@/lib/web-server-api'

/**
 * CAP-6 / Story 8: the host-resolved catalog shape returned by the WS
 * `list_acp_catalog` request. Mirrors `AcpCatalog` from
 * `@shared/types/acp-catalog.types` but kept local to avoid a cross-module
 * import cycle (acp-transport ↔ acp-catalog-api). The shape is byte-identical.
 */
interface AcpCatalogFromHost {
  host: {
    os: string
    arch: string
    runtimes: { npx: boolean; uvx: boolean; node: boolean; bun: boolean; python3: boolean }
  }
  agents: unknown[]
}

/** Thrown on WS (and mapped) failures — callers may toast `.message`. */
export class AcpTransportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AcpTransportError'
    this.code = code
  }
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
  installAcpAgent(agentId: string): Promise<InstallAcpRegistryBinaryOutcome>
  probeRuntime(): Promise<AcpRuntimeAvailability>
  setTurnTimeout(secs: number | null): Promise<void>
  setTurnIdleTimeout(secs: number | null): Promise<void>
  setSessionNewTimeout(secs: number | null): Promise<void>
  setSessionReopenTimeout(secs: number | null): Promise<void>
  setFirstPromptWarmupTimeout(secs: number | null): Promise<void>
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
  newSession(
    agentId: AgentId,
    cwd: string,
    mcpServers?: McpServer[],
    options?: { ephemeral?: boolean; projectId?: string }
  ): Promise<NewSessionOutcome>
  loadSession(agentId: AgentId, sessionId: SessionId, cwd: string): Promise<SessionReopenOutcome>
  resumeSession(agentId: AgentId, sessionId: SessionId, cwd: string): Promise<SessionReopenOutcome>
  closeSession(agentId: AgentId, sessionId: SessionId): Promise<void>
  disposeEphemeralSession(agentId: AgentId, sessionId: SessionId): Promise<void>
  listSessions(agentId: AgentId, cwd?: string, cursor?: string): Promise<ListSessionsResponse>
  sendPrompt(
    agentId: AgentId,
    sessionId: SessionId,
    text: string,
    turnId?: string
  ): Promise<StopReason>
  sendPromptBlocks(
    agentId: AgentId,
    sessionId: SessionId,
    content: ContentBlock[],
    turnId?: string
  ): Promise<StopReason>
  cancelPrompt(agentId: AgentId, sessionId: SessionId): Promise<void>
  setConfigOption(
    agentId: AgentId,
    sessionId: SessionId,
    configId: string,
    valueId: string
  ): Promise<SessionConfigOption[]>
  setMode(agentId: AgentId, sessionId: SessionId, modeId: string): Promise<void>
  setModel(agentId: AgentId, sessionId: SessionId, modelId: string): Promise<void>
  respondPermission(agentId: AgentId, requestId: string, optionId?: string): Promise<void>
  answerQuestion(agentId: AgentId, questionId: string, values?: string[]): Promise<void>
  /** Agent ACP auth (methodId) — NOT the WS relay token gate. */
  authenticate(agentId: AgentId, methodId: string): Promise<void>
  /** Web/remote only: switch now or report that the switch was queued. */
  switchProject?(projectId: string): Promise<SwitchProjectReply>
  historyMode?(): HistoryMode | 'tauri_store'
  listPersistedSessions?(): Promise<PersistedSessionSummary[]>
  openPersistedSession?(sessionId: SessionId, lastSeq?: number): Promise<void>
  /** Web/remote: fetch the full stored transcript for a session (server mode). */
  getSessionPayload?(
    sessionId: SessionId
  ): Promise<import('@/lib/acp-history-persistence').SessionPayload | null>
  onEvent<T>(eventName: string, callback: (payload: T) => void): () => void
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
  setRecoveryHandler?(
    handler: (
      recovery: SessionSnapshotEvent | { sessionId: string; degraded: true }
    ) => Promise<void>
  ): void
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

// ---------------------------------------------------------------------------
// Event name translation
// ---------------------------------------------------------------------------

export function toWsEventType(tauriEventName: string): string {
  return tauriEventName.startsWith('acp:') ? tauriEventName.slice(4) : tauriEventName
}

export function toTauriEventName(wsType: string): string {
  return wsType.startsWith('acp:') ? wsType : `acp:${wsType}`
}

// ---------------------------------------------------------------------------
// Tauri transport
// ---------------------------------------------------------------------------

function createTauriAcpTransport(): AcpTransport {
  return {
    installRegistryBinary: (request) =>
      invoke<InstallAcpRegistryBinaryOutcome>('acp_install_registry_binary', { request }),
    // CAP-6 / Story 9: the host-owned verified-atomic install. The Tauri
    // adapter invokes the new `acp_install_agent` command (the host resolves
    // the agent by id from the catalog — no browser-supplied URLs/args). The
    // command returns `IpcResult<InstallOutcome>`; this adapter unwraps the
    // envelope so the launcher's `installedBinaryConfig(installed, ...)` gets
    // the bare `{ command, args }` (mirrors the web/WS transport). A failure
    // throws `AcpTransportError` carrying the install error code.
    installAcpAgent: async (agentId) => {
      const result = await invoke<IpcResult<InstallAcpRegistryBinaryOutcome>>('acp_install_agent', {
        request: { agentId }
      })
      if (result.success) {
        return result.data
      }
      throw new AcpTransportError(result.code, result.error)
    },
    probeRuntime: () => invoke<AcpRuntimeAvailability>('acp_probe_runtime'),
    setTurnTimeout: (secs) => invoke<void>('acp_set_turn_timeout', { secs }),
    setTurnIdleTimeout: (secs) => invoke<void>('acp_set_turn_idle_timeout', { secs }),
    setSessionNewTimeout: (secs) => invoke<void>('acp_set_session_new_timeout', { secs }),
    setSessionReopenTimeout: (secs) => invoke<void>('acp_set_session_reopen_timeout', { secs }),
    setFirstPromptWarmupTimeout: (secs) =>
      invoke<void>('acp_set_first_prompt_warmup_timeout', { secs }),
    fetchRegistrySnapshot: (forceRefresh = false) =>
      invoke<AcpRegistrySnapshot>('acp_fetch_registry_snapshot', { forceRefresh }),
    probeMcpServer: (server) => invoke<ProbeResult>('acp_probe_mcp_server', { server }),
    spawnAgent: (config) => invoke<SpawnAgentResult>('acp_spawn_agent', { config }),
    killAgent: async (agentId) => {
      await invoke('acp_kill_agent', { agentId })
    },
    listAgents: () => invoke<AgentId[]>('acp_list_agents'),
    newSession: (agentId, cwd, mcpServers, options) =>
      invoke<NewSessionOutcome>('acp_new_session', {
        agentId,
        cwd,
        mcpServers,
        ...(options?.ephemeral ? { ephemeral: true } : {}),
        ...(options?.projectId ? { projectId: options.projectId } : {})
      }),
    loadSession: (agentId, sessionId, cwd) =>
      invoke<SessionReopenOutcome>('acp_load_session', { agentId, sessionId, cwd }),
    resumeSession: (agentId, sessionId, cwd) =>
      invoke<SessionReopenOutcome>('acp_resume_session', { agentId, sessionId, cwd }),
    closeSession: async (agentId, sessionId) => {
      await invoke('acp_close_session', { agentId, sessionId })
    },
    disposeEphemeralSession: async (agentId, sessionId) => {
      await invoke('acp_dispose_ephemeral_session', { agentId, sessionId })
    },
    listSessions: (agentId, cwd, cursor) =>
      invoke<ListSessionsResponse>('acp_list_sessions', { agentId, cwd, cursor }),
    sendPrompt: (agentId, sessionId, text, _turnId) =>
      invoke<StopReason>('acp_send_prompt', { agentId, sessionId, text }),
    sendPromptBlocks: (agentId, sessionId, content, _turnId) =>
      invoke<StopReason>('acp_send_prompt', { agentId, sessionId, content }),
    cancelPrompt: async (agentId, sessionId) => {
      await invoke('acp_cancel_prompt', { agentId, sessionId })
    },
    setConfigOption: (agentId, sessionId, configId, valueId) =>
      invoke<SessionConfigOption[]>('acp_set_config_option', {
        agentId,
        sessionId,
        configId,
        valueId
      }),
    setMode: async (agentId, sessionId, modeId) => {
      await invoke('acp_set_mode', { agentId, sessionId, modeId })
    },
    setModel: async (agentId, sessionId, modelId) => {
      await invoke('acp_set_model', { agentId, sessionId, modelId })
    },
    respondPermission: async (agentId, requestId, optionId) => {
      await invoke('acp_respond_permission', { agentId, requestId, optionId })
    },
    answerQuestion: async (agentId, questionId, values) => {
      await invoke('acp_answer_question', { agentId, questionId, values })
    },
    authenticate: async (agentId, methodId) => {
      await invoke('acp_authenticate', { agentId, methodId })
    },
    onEvent<T>(eventName: string, callback: (payload: T) => void): () => void {
      let resolvedUnlisten: UnlistenFn | null = null
      let unlistenCalledEarly = false

      void listen<T>(eventName, (event) => {
        callback(event.payload)
      })
        .then((unlisten) => {
          if (unlistenCalledEarly) {
            unlisten()
            return
          }
          resolvedUnlisten = unlisten
        })
        .catch(console.error)

      return () => {
        if (resolvedUnlisten) {
          resolvedUnlisten()
          resolvedUnlisten = null
        } else {
          unlistenCalledEarly = true
        }
      }
    },
    connect: async () => {
      /* desktop uses Tauri IPC — no socket */
    },
    dispose: () => {
      /* no-op */
    }
  }
}

// ---------------------------------------------------------------------------
// WS URL + client
// ---------------------------------------------------------------------------

/** Resolve `ws(s)://{host}/ws` — same origin in the web build. */
export function resolveWsUrl(
  locationLike: { protocol: string; host: string } = window.location
): string {
  const proto = locationLike.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${locationLike.host}/ws`
}

const REQUEST_TIMEOUT_MS = 60_000
/**
 * Grace margin added on top of the server turn budget so the server's typed
 * `turn timeout` reply wins the race instead of the client's generic timeout.
 * Rust `CANCEL_GRACE` is 5s (`src-tauri/src/acp/manager.rs`), so 10s leaves
 * headroom for that plus reply latency.
 */
const SEND_PROMPT_GRACE_MS = 10_000
/**
 * Fallback only until the authenticate reply publishes the authoritative policy.
 * Timeout for `send_prompt`, which awaits the full agent turn on the server. The
 * server's default turn (hard-cap + idle) timeout is **unlimited** (the
 * published `turnTimeoutMs` / `promptInactivityTimeoutMs` are `0` to signal
 * unlimited), so once authenticated the client imposes no client-side timer.
 * This fallback only covers the brief pre-auth window (send_prompt requires a
 * session, so it normally never fires pre-auth) with a bounded, setTimeout-safe
 * 1h budget.
 *
 * NOTE: a deployment that sets `TERMUL_ACP_TURN_TIMEOUT_SECS` /
 * `TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS` publishes those bounded values, which the
 * client honours instead of this fallback.
 */
const FALLBACK_SEND_PROMPT_INACTIVITY_MS = 3_600_000
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8_000
/**
 * How long the page must stay hidden before a return triggers a proactive
 * reconnect. Mobile browsers suspend JS in backgrounded tabs, so the server's
 * keepalive Ping goes un-ponged and the server tears the socket down at its
 * ~75s Pong-timeout (`web/ws.rs::PONG_TIMEOUT`) — but the client only learns
 * this when `onclose` is finally delivered on resume (late, or never on a
 * half-open link). 30s sits between the server's 20s Ping interval and its 75s
 * Pong-timeout: long enough to ride out a brief tab switch without a needless
 * reconnect, short enough that a real background/idle triggers recovery before
 * the user sees a dead chat. Tunable.
 */
const VISIBILITY_STALE_THRESHOLD_MS = 30_000

/**
 * Application-level heartbeat interval. A client-emitted `ping` text request
 * refreshes the server keepalive watchdog (`last_activity`) through proxies
 * that strip WS-level Ping/Pong control frames (Cloudflare tunnels, etc.), so
 * a focused tab no longer false-positive drops at the server's ~75s
 * `PONG_TIMEOUT`. ~30s sits under both the 75s timeout and the 20s Ping
 * interval, so even a single tick keeps a healthy peer alive. Tunable.
 */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Consecutive ping failures that trigger a forced reconnect. A single missed
 * reply can be transient (slow link); two in a row (~60s+ of no round-trip) is
 * a strong half-open signal — the inbound ping keeps the *server's* watchdog
 * fresh, so without this the client could sit on a dead socket whose `onclose`
 * never fires (the server→client reply path is broken but client→server works).
 */
const HEARTBEAT_FAILURE_THRESHOLD = 2

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  /** Inactivity timer; `null` when the server policy is unlimited (no
   * client-side inactivity timer is imposed). */
  timer: ReturnType<typeof setTimeout> | null
  type: WsRequestType
  sessionId?: string
  /** Absolute deadline (epoch-ms) for send_prompt — the inactivity timer never
   * extends past it. `undefined` when the server imposes no hard cap
   * (unlimited) or for non-send_prompt requests. */
  deadline?: number
}

type EventListener = (payload: unknown) => void

/**
 * Multiplexed ACP WS client.
 *
 * On `stale` subscribe reply: clear per-session seq/buffer + turn-id dedup and
 * resubscribe live-only (omit `lastSeq`).
 */
export class WsAcpTransport implements AcpTransport {
  private socket: WebSocket | null = null
  private authed = false
  private negotiatedHistoryMode: HistoryMode = 'live_only'
  private runtimePolicy: AcpRuntimePolicy | null = null
  private connecting: Promise<void> | null = null
  private disposed = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Application-level heartbeat timer (`setInterval`) — cleared on close /
   * dispose / force-reconnect. `null` while no socket is live. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** Consecutive heartbeat ping failures — forces a reconnect at the threshold. */
  private consecutivePingFailures = 0
  /** When the page became hidden (epoch-ms), or null while visible. Drives the
   * visibility-triggered proactive reconnect on mobile idle/background resume. */
  private lastHiddenAt: number | null = null
  /** Bound DOM-listener refs so `dispose()` can detach them. */
  private visibilityHandler: (() => void) | null = null
  private focusHandler: (() => void) | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Map<string, Set<EventListener>>()
  /** Per-session last contiguous delivered seq. */
  private readonly lastSeq = new Map<string, number>()
  /** Sessions we should re-subscribe after reconnect. */
  private readonly subscribed = new Set<string>()
  /** Idempotent prompt_complete turn ids already delivered, scoped by session. */
  private readonly seenTurnIds = new Map<string, Set<string>>()
  private recoveryHandler?: (
    recovery: SessionSnapshotEvent | { sessionId: string; degraded: true }
  ) => Promise<void>
  private reconnectPriorityProvider?: () => SessionId[]
  private readonly wsUrl: string
  private readonly webSocketCtor: typeof WebSocket
  /**
   * Story 5.3 (AC3): transport-level reconnect listener. Fired `true` when
   * `scheduleReconnect` runs (WS drop detected) and `false` when `reconnect`
   * succeeds (socket re-opened + sessions re-subscribed). The store subscribes
   * to flip its `transportReconnecting` flag, which drives the non-blocking
   * `AgentConnectionLamp` overlay in `AgentChatPanel`. Desktop Tauri never
   * uses the WS transport, so the listener stays unset there.
   */
  private onReconnectStateChange?: (reconnecting: boolean) => void

  constructor(opts?: { url?: string; WebSocketImpl?: typeof WebSocket }) {
    this.wsUrl =
      opts?.url ?? (typeof window !== 'undefined' ? resolveWsUrl() : 'ws://127.0.0.1:8080/ws')
    this.webSocketCtor = opts?.WebSocketImpl ?? WebSocket
  }

  /**
   * Story 5.3 (AC3): register a listener for transport-level reconnect state.
   * Fired `true` on WS drop (before the reconnect timer is set) and `false`
   * on successful reconnect (after sessions are re-subscribed). Does NOT fire
   * on the initial `connect()` — only on reconnect transitions.
   */
  setReconnectListener(listener: (reconnecting: boolean) => void): void {
    this.onReconnectStateChange = listener
  }

  setRecoveryHandler(
    handler: (
      recovery: SessionSnapshotEvent | { sessionId: string; degraded: true }
    ) => Promise<void>
  ): void {
    this.recoveryHandler = handler
  }

  setReconnectPriorityProvider(provider: () => SessionId[]): void {
    this.reconnectPriorityProvider = provider
  }

  getSessionCursor(sessionId: SessionId): number | null {
    return this.lastSeq.get(sessionId) ?? null
  }

  async fetchSessionCursor(sessionId: SessionId): Promise<number> {
    // R2: proactively fetch the server watermark (NOT only on a STALE error)
    // so a refreshed transport seeds `lastSeq` before its first subscribe.
    await this.connect()
    const reply = await this.request<{ sessionId: string; watermark: number }>(
      'get_session_cursor',
      { sessionId }
    )
    return reply?.watermark ?? 0
  }

  seedSessionCursor(sessionId: SessionId, cursor: number): void {
    // Seed the in-memory watermark without subscribing so the subsequent
    // `resumeSession`/`subscribeSession` built-in re-subscribe resumes from
    // the server cursor (replays only the gap), not a dead per-instance 0.
    if (cursor > 0) this.lastSeq.set(sessionId, cursor)
  }

  async connect(): Promise<void> {
    if (this.disposed) return
    this.attachVisibilityListeners()
    if (this.socket?.readyState === WebSocket.OPEN && this.authed) return
    if (this.connecting) return this.connecting
    this.connecting = this.openSocket()
    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  dispose(): void {
    this.disposed = true
    this.detachVisibilityListeners()
    this.clearHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new AcpTransportError('closed', 'transport disposed'))
    }
    this.pending.clear()
    this.socket?.close()
    this.socket = null
  }

  async subscribeSession(
    sessionId: SessionId,
    lastSeq?: number | null,
    force = false
  ): Promise<void> {
    await this.connect()
    // Skip no-op re-subscribe when already live-subscribed (sendPrompt path).
    if (!force && lastSeq === undefined && this.subscribed.has(sessionId)) {
      return
    }
    this.subscribed.add(sessionId)
    const payload: { sessionId: string; lastSeq?: number } = { sessionId }
    if (lastSeq != null) {
      payload.lastSeq = lastSeq
    } else if (lastSeq === undefined && this.lastSeq.has(sessionId)) {
      payload.lastSeq = this.lastSeq.get(sessionId)
    }
    // lastSeq === null → omit field → server live-only (stale recovery).
    try {
      await this.request('subscribe', payload)
    } catch (err) {
      if (err instanceof AcpTransportError && err.code === WS_ERROR_CODES.STALE) {
        if (this.negotiatedHistoryMode === 'server') {
          const recovery = await this.request<SessionSnapshotEvent>('recover_session_snapshot', {
            sessionId
          })
          this.lastSeq.set(sessionId, recovery.watermark)
          this.seenTurnIds.delete(sessionId)
          await this.recoveryHandler?.(recovery)
          // handle_recover_session_snapshot server-side re-registers the
          // subscription for continued live delivery — no separate subscribe
          // call needed here.
          return
        }
        this.lastSeq.delete(sessionId)
        this.seenTurnIds.delete(sessionId)
        await this.request('subscribe', { sessionId })
        await this.recoveryHandler?.({ sessionId, degraded: true })
        return
      }
      throw err
    }
  }

  onEvent<T>(eventName: string, callback: (payload: T) => void): () => void {
    const wsType = toWsEventType(eventName)
    let set = this.listeners.get(wsType)
    if (!set) {
      set = new Set()
      this.listeners.set(wsType, set)
    }
    const wrapped: EventListener = (payload) => callback(payload as T)
    set.add(wrapped)
    // Ensure socket is up so events can arrive.
    void this.connect().catch(console.error)
    return () => {
      set?.delete(wrapped)
      if (set && set.size === 0) this.listeners.delete(wsType)
    }
  }

  // --- Desktop-only / short-circuit methods --------------------------------

  async installRegistryBinary(
    _request: InstallAcpRegistryBinaryRequest
  ): Promise<InstallAcpRegistryBinaryOutcome> {
    throw new AcpTransportError('unsupported', 'Registry binary install is desktop-only')
  }

  /**
   * CAP-6 / Story 9: host-owned verified-atomic install. The WS transport
   * routes the install through the authenticated WS connection
   * (`install_acp_agent`), NOT a separate HTTP POST — the server's
   * `handle_install_acp_agent` resolves the agent by id from the trusted
   * catalog, downloads + verifies sha256 + atomically activates. `handleReply`
   * maps the WS reply: success → resolve with the `InstallOutcome` payload
   * `{ command, args }`; failure → reject with `AcpTransportError` carrying
   * the install-specific SCREAMING_SNAKE_CASE code (via
   * `WsReply::err_with_code`, byte-identical to the Tauri `IpcResult.code` +
   * HTTP `IpcBody.code`). The request is `{ agentId }` only; the host resolves
   * everything from the trusted catalog.
   */
  async installAcpAgent(agentId: string): Promise<InstallAcpRegistryBinaryOutcome> {
    return this.request<InstallAcpRegistryBinaryOutcome>('install_acp_agent', { agentId })
  }

  /**
   * CAP-6 / Story 8: probeRuntime is replaced by the host-resolved catalog.
   * The web client calls `acpCatalogApi.listCatalog()` (the facade) which
   * returns the host's `host.runtimes` block — the web client never probes
   * `@tauri-apps/plugin-os` or PATH locally. This method now returns the
   * host's runtime availability from the catalog; callers that only need the
   * runtime probe (the existing `useAcpAgents` hook) switch to
   * `listCatalog()` instead.
   */
  async probeRuntime(): Promise<AcpRuntimeAvailability> {
    // Delegate to the host-resolved catalog. The WS transport sends a
    // `list_acp_catalog` request; the host probes npx/uvx/node/bun/python3
    // and returns the result. This replaces the fake `{npx:true,uvx:true}`
    // hardcoded stub (CAP-6: the host is the single source of truth).
    try {
      const catalog = await this.request<AcpCatalogFromHost>('list_acp_catalog', {})
      return {
        npx: catalog.host.runtimes.npx,
        uvx: catalog.host.runtimes.uvx
      }
    } catch {
      // Degrade gracefully: if the catalog is unavailable, assume no
      // runtimes (the caller will mark agents as needs-runtime).
      return { npx: false, uvx: false }
    }
  }

  async probeMcpServer(server: McpServerConfig): Promise<ProbeResult> {
    // Web parity: POST /mcp-servers/probe runs the rmcp client on the
    // termul-server host (where stdio commands execute). The route returns
    // `IpcBody<ProbeResult>`; a `success:false` body is a transport/config
    // failure (mapped to AcpTransportError), while `success:true` carries the
    // probe outcome (which may itself be `status:'disconnected'` — that is a
    // successful probe of an unreachable server, NOT a transport failure).
    const res = await webServerMcpProbe.post(server)
    if (!res.success) {
      throw new AcpTransportError(res.code, res.error)
    }
    return res.data as ProbeResult
  }

  async setTurnTimeout(_secs: number | null): Promise<void> {
    // Desktop-only: the standalone server has no settings surface and
    // configures the turn timeout via TERMUL_ACP_TURN_TIMEOUT_SECS.
  }

  async setTurnIdleTimeout(_secs: number | null): Promise<void> {
    // Desktop-only: the standalone server has no settings surface and
    // configures the turn idle timeout via TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS.
  }

  async setSessionNewTimeout(_secs: number | null): Promise<void> {
    // Desktop-only: the standalone server has no settings surface and configures
    // the session/new timeout via TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS.
  }

  async setSessionReopenTimeout(_secs: number | null): Promise<void> {
    // Desktop-only: the standalone server has no settings surface and configures
    // the session reopen timeout via TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS.
  }

  async setFirstPromptWarmupTimeout(_secs: number | null): Promise<void> {
    // Desktop-only: the standalone server has no settings surface and configures
    // the first-prompt warmup timeout via TERMUL_ACP_FIRST_PROMPT_WARMUP_SECS.
  }

  /**
   * CAP-6 / Story 8: fetchRegistrySnapshot is replaced by the host-resolved
   * catalog. The web client calls `acpCatalogApi.listCatalog()` (the facade)
   * which returns the host's resolved catalog including CDN entries (when
   * the opt-in is set). This method now delegates to the WS
   * `list_acp_catalog` request; the fake `{agents:[]}` hardcoded stub is
   * removed. Callers that need the full catalog (the registry-catalog hook)
   * switch to `acpCatalogApi.listCatalog()` instead.
   */
  async fetchRegistrySnapshot(forceRefresh = false): Promise<AcpRegistrySnapshot> {
    // Delegate to the host-resolved catalog. The host embeds the trusted
    // bundled `agents.json` + optionally augments with the CDN snapshot
    // (gated on the host-persisted opt-in). This replaces the fake
    // `{agents:[], source:'empty'}` hardcoded stub.
    //
    // The WS `list_acp_catalog` payload field is `refresh` (camelCase, matching
    // the Rust `ListAcpCatalogPayload.refresh` + the HTTP `?refresh=true` query).
    // Propagate `forceRefresh` so an explicit user refresh bypasses the host's
    // 60s TTL — the previous `{}` left `refresh` defaulted to `false`, so a
    // "check for updates" action could serve a stale cached catalog.
    try {
      const catalog = await this.request<AcpCatalogFromHost>('list_acp_catalog', {
        refresh: forceRefresh
      })
      return {
        agents: catalog.agents,
        source: 'network',
        fetchedAt: null
      }
    } catch {
      return { agents: [], source: 'empty', fetchedAt: null }
    }
  }

  // --- Agent lifecycle (desktop parity over WS) ----------------------------

  historyMode(): HistoryMode {
    return this.negotiatedHistoryMode
  }

  async listPersistedSessions(): Promise<PersistedSessionSummary[]> {
    return this.request<PersistedSessionSummary[]>('list_persisted_sessions', {})
  }

  async openPersistedSession(sessionId: SessionId, lastSeq = 0): Promise<void> {
    await this.connect()
    this.subscribed.add(sessionId)
    await this.request('open_persisted_session', { sessionId, lastSeq })
  }

  async getSessionPayload(
    sessionId: SessionId
  ): Promise<import('@/lib/acp-history-persistence').SessionPayload | null> {
    try {
      return await this.request<import('@/lib/acp-history-persistence').SessionPayload>(
        'get_session_payload',
        { sessionId }
      )
    } catch (err) {
      // `not_found` → the session is absent from the cache (web shows "chat
      // unavailable"); other errors propagate.
      if (err instanceof AcpTransportError && err.code === 'not_found') return null
      throw err
    }
  }

  async spawnAgent(config: AgentConfig): Promise<SpawnAgentResult> {
    return this.request<SpawnAgentResult>('spawn_agent', { config })
  }

  async killAgent(agentId: AgentId): Promise<void> {
    await this.request('kill_agent', { agentId })
  }

  async listAgents(): Promise<AgentId[]> {
    return this.request<AgentId[]>('list_agents', {})
  }

  // --- WS-mapped session/prompt methods ------------------------------------

  async newSession(
    agentId: AgentId,
    cwd: string,
    mcpServers?: McpServer[],
    options?: { ephemeral?: boolean; projectId?: string }
  ): Promise<NewSessionOutcome> {
    // Web/remote: the host attributes the session to a project by resolving
    // `cwd` against its registry (CAP-2), so no explicit projectId is sent.
    const outcome = await this.request<NewSessionOutcome>('create_session', {
      agentId,
      cwd,
      mcpServers,
      ephemeral: options?.ephemeral ?? false
    })
    if (outcome?.sessionId && !options?.ephemeral) {
      await this.subscribeSession(outcome.sessionId, null)
    }
    return outcome
  }

  /** Web/remote: subscribe immediately only when the server completed the switch. */
  async disposeEphemeralSession(agentId: AgentId, sessionId: SessionId): Promise<void> {
    await this.request('dispose_ephemeral_session', { agentId, sessionId })
    this.subscribed.delete(sessionId)
    this.lastSeq.delete(sessionId)
    this.seenTurnIds.delete(sessionId)
  }

  async switchProject(projectId: string): Promise<SwitchProjectReply> {
    const outcome = await this.request<SwitchProjectReply>('switch_project', { projectId })
    if (outcome.status === 'completed') {
      await this.subscribeSession(outcome.sessionId, null)
    }
    return outcome
  }

  async loadSession(
    agentId: AgentId,
    sessionId: SessionId,
    cwd: string
  ): Promise<SessionReopenOutcome> {
    const outcome = await this.request<SessionReopenOutcome>('load_session', {
      agentId,
      sessionId,
      cwd
    })
    await this.subscribeSession(sessionId, this.lastSeq.get(sessionId) ?? 0, true)
    return outcome
  }

  async resumeSession(
    agentId: AgentId,
    sessionId: SessionId,
    cwd: string
  ): Promise<SessionReopenOutcome> {
    const outcome = await this.request<SessionReopenOutcome>('resume_session', {
      agentId,
      sessionId,
      cwd
    })
    await this.subscribeSession(sessionId, this.lastSeq.get(sessionId) ?? 0, true)
    return outcome
  }

  async closeSession(agentId: AgentId, sessionId: SessionId): Promise<void> {
    await this.request('close_session', { agentId, sessionId })
    this.subscribed.delete(sessionId)
    this.lastSeq.delete(sessionId)
  }

  async listSessions(
    agentId: AgentId,
    cwd?: string,
    cursor?: string
  ): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>('list_sessions', { agentId, cwd, cursor })
  }

  async sendPrompt(
    agentId: AgentId,
    sessionId: SessionId,
    text: string,
    turnId?: string
  ): Promise<StopReason> {
    await this.subscribeSession(sessionId) // no-op if already subscribed
    // The turn-id is minted by the store (`runPromptTurn`) so the optimistic
    // user message can share the same `turn:<turnId>` id as the server's
    // `user_prompt` echo → reliable dedup in `_onUserPrompt` regardless of
    // block differences (issue: the echo rendered a second user bubble because
    // the optimistic id (`newId('msg')`) never matched the echo's `turn:<uuid>`).
    // Fall back to a fresh UUID for callers that omit it (backward-compat / tests).
    const id = turnId ?? crypto.randomUUID()
    return this.request<StopReason>('send_prompt', { agentId, sessionId, text, turnId: id })
  }

  async sendPromptBlocks(
    agentId: AgentId,
    sessionId: SessionId,
    content: ContentBlock[],
    turnId?: string
  ): Promise<StopReason> {
    await this.subscribeSession(sessionId)
    const id = turnId ?? crypto.randomUUID()
    return this.request<StopReason>('send_prompt', { agentId, sessionId, content, turnId: id })
  }

  async cancelPrompt(agentId: AgentId, sessionId: SessionId): Promise<void> {
    await this.request('cancel_prompt', { agentId, sessionId })
  }

  async setConfigOption(
    agentId: AgentId,
    sessionId: SessionId,
    configId: string,
    valueId: string
  ): Promise<SessionConfigOption[]> {
    return this.request<SessionConfigOption[]>('set_config_option', {
      agentId,
      sessionId,
      configId,
      valueId
    })
  }

  async setMode(agentId: AgentId, sessionId: SessionId, modeId: string): Promise<void> {
    await this.request('set_mode', { agentId, sessionId, modeId })
  }

  async setModel(agentId: AgentId, sessionId: SessionId, modelId: string): Promise<void> {
    await this.request('set_model', { agentId, sessionId, modelId })
  }

  async respondPermission(agentId: AgentId, requestId: string, optionId?: string): Promise<void> {
    await this.request('respond_permission', { agentId, requestId, optionId })
  }

  async answerQuestion(agentId: AgentId, questionId: string, values?: string[]): Promise<void> {
    await this.request('answer_question', { agentId, questionId, values })
  }

  /** Agent method auth — distinct from relay `authenticate` token gate. */
  async authenticate(agentId: AgentId, methodId: string): Promise<void> {
    // Not in WS_REQUEST_TYPES as agent auth; server may still stub.
    // Keep a clear error until 1.8 wires agent auth over WS if needed.
    throw new AcpTransportError(
      'not_implemented',
      `Agent authenticate(${agentId}, ${methodId}) is not available over WS yet`
    )
  }

  // --- Internals -----------------------------------------------------------

  private async openSocket(): Promise<void> {
    if (this.disposed) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settleOk = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const settleErr = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }

      const ws = new this.webSocketCtor(this.wsUrl)
      this.socket = ws
      this.authed = false

      ws.onmessage = (ev) => {
        void this.onMessage(String(ev.data))
          .then(() => {
            if (this.authed) settleOk()
          })
          .catch((err) => {
            try {
              ws.close()
            } catch {
              /* ignore */
            }
            settleErr(err instanceof Error ? err : new AcpTransportError('closed', String(err)))
          })
      }

      ws.onerror = () => {
        this.rejectAllPending('closed', 'WebSocket error')
        settleErr(new AcpTransportError('closed', 'WebSocket error'))
      }

      ws.onclose = () => {
        this.socket = null
        this.authed = false
        this.clearHeartbeat()
        this.rejectAllPending('closed', 'WebSocket closed')
        if (!this.disposed) this.scheduleReconnect()
        settleErr(new AcpTransportError('closed', 'WebSocket closed before auth'))
      }

      setTimeout(() => {
        if (!this.authed) {
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          settleErr(new AcpTransportError('closed', 'WebSocket auth handshake timeout'))
        }
      }, REQUEST_TIMEOUT_MS)
    })
  }

  private rejectAllPending(code: string, message: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new AcpTransportError(code, message))
    }
    this.pending.clear()
  }

  /**
   * Attach `visibilitychange` + `focus` listeners (web only) so a return from a
   * backgrounded mobile tab proactively reconnects instead of waiting for an
   * `onclose` the suspended browser delivers late or never. Idempotent; detached
   * in {@link dispose}. `visibilitychange` is the primary signal (it carries
   * hidden/visible timing); `focus` is a fallback for platforms where
   * `visibilitychange` is unreliable.
   */
  private attachVisibilityListeners(): void {
    if (this.visibilityHandler || typeof document === 'undefined') return
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        this.lastHiddenAt = Date.now()
        return
      }
      // visible — a backgrounded tab returning to the foreground.
      this.maybeReconnectOnReturn()
    }
    const onFocus = (): void => {
      // Fallback: focus implies the window is active again. Only acts when we
      // previously recorded a hide, so normal interaction is a no-op.
      this.maybeReconnectOnReturn()
    }
    this.visibilityHandler = onVisibility
    this.focusHandler = onFocus
    document.addEventListener('visibilitychange', onVisibility)
    // `focus`/`blur` for tab/window backgrounding are window-level events and do
    // NOT bubble — attach to `window`, not `document` (a document-level listener
    // would never fire for window focus changes, making the fallback dead code).
    window.addEventListener('focus', onFocus)
  }

  /** Detach the visibility/focus listeners (called from {@link dispose}). */
  private detachVisibilityListeners(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    if (this.focusHandler && typeof window !== 'undefined') {
      window.removeEventListener('focus', this.focusHandler)
      this.focusHandler = null
    }
  }

  /**
   * On a return-to-foreground, if the page was hidden past the staleness
   * threshold OR the socket is not OPEN, force a reconnect. The existing
   * `reconnect()` + `subscribeSession(lastSeq)` cursor path then replays missed
   * events from the server's per-session event log and resumes streaming — no
   * manual page reload. Consumes `lastHiddenAt` so a `focus` following a
   * `visibilitychange` (or vice-versa) does not double-trigger.
   */
  private maybeReconnectOnReturn(): void {
    if (this.disposed) return
    const hiddenAt = this.lastHiddenAt
    this.lastHiddenAt = null
    if (hiddenAt == null) return // never recorded a hide — nothing to recover
    const hiddenFor = Date.now() - hiddenAt
    const socketDown = this.socket?.readyState !== WebSocket.OPEN
    if (hiddenFor > VISIBILITY_STALE_THRESHOLD_MS || socketDown) {
      this.forceReconnect(
        socketDown ? 'socket closed while page was hidden' : 'visibility return after idle'
      )
    }
  }

  /**
   * Force a clean reconnect, bypassing the `connect()` fast path that trusts
   * `readyState === OPEN`. Used by the visibility-triggered path: a mobile
   * browser backgrounded the tab, the server tore the socket down at its
   * Pong-timeout, and the client's `onclose` may not have fired yet (or the
   * link is half-open and still reports OPEN). Tears down the suspect socket
   * (detaching its handlers so its eventual close does not double-trigger
   * `scheduleReconnect`/`rejectAllPending`), then reuses `scheduleReconnect()`
   * so the existing backoff + `reconnect()` + cursor-resubscribe +
   * `onReconnectStateChange` machinery runs unchanged.
   */
  private forceReconnect(reason: string): void {
    if (this.disposed) return
    const old = this.socket
    this.socket = null
    this.authed = false
    this.connecting = null
    this.rejectAllPending('closed', reason)
    this.clearHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    if (old) {
      // Detach so the old socket's close does not double-fire scheduleReconnect
      // / rejectAllPending on an already-tearing-down transport.
      old.onclose = null
      old.onerror = null
      old.onmessage = null
      try {
        old.close()
      } catch {
        /* ignore — already closed */
      }
    }
    this.scheduleReconnect()
  }

  /**
   * Start the application-level heartbeat that keeps the server's keepalive
   * watchdog fresh through proxies that strip WS-level Ping/Pong control
   * frames. A periodic `ping` text request lands in the server read loop,
   * which stamps `last_activity` on every inbound frame — so a focused tab no
   * longer false-positive drops at the ~75s `PONG_TIMEOUT`. Idempotent: clears
   * any prior timer first. Stopped on close / dispose / force-reconnect.
   */
  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.disposed) return
      // Only tick while OPEN; the reconnect path owns recovery otherwise. A
      // failed ping (half-open link) is swallowed per-tick but counted — at the
      // threshold, force a reconnect so a dead reply path doesn't strand the
      // client on a socket whose onclose may never fire.
      if (this.socket?.readyState === WebSocket.OPEN) {
        void this.request<void>('ping', {})
          .then(() => {
            this.consecutivePingFailures = 0
          })
          .catch(() => {
            this.consecutivePingFailures += 1
            if (!this.disposed && this.consecutivePingFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
              this.forceReconnect(
                `ping heartbeat: ${this.consecutivePingFailures} consecutive failures (half-open link)`
              )
            }
          })
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** Stop the heartbeat timer (on close / dispose / force-reconnect). */
  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.consecutivePingFailures = 0
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS)
    this.reconnectAttempt += 1
    // Story 5.3 (AC3): fire the reconnect listener BEFORE setting the timer so
    // the store can flip `transportReconnecting` immediately — the UI overlay
    // should appear as soon as the WS drop is detected, not after the backoff
    // delay. The listener is a no-op on Tauri desktop (never set).
    this.onReconnectStateChange?.(true)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.reconnect()
    }, delay)
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect()
      this.reconnectAttempt = 0
      const prioritized = this.reconnectPriorityProvider?.() ?? []
      const ordered = [
        ...prioritized.filter((sid) => this.subscribed.has(sid)),
        ...[...this.subscribed].filter((sid) => !prioritized.includes(sid))
      ]
      for (const sid of ordered) {
        const last = this.lastSeq.get(sid)
        // Force re-subscribe after reconnect; pass an explicit boundary.
        // A single failing session must NOT abort the whole resubscribe pass —
        // log + continue so remaining sessions still recover.
        try {
          await this.subscribeSession(sid, last ?? 0, true)
        } catch (err) {
          console.error('[acp-transport] resubscribe failed for session', sid, err)
        }
      }
      // Story 5.3 (AC3): fire `false` AFTER the socket re-opens and all
      // sessions are re-subscribed so the overlay stays visible for the
      // full reconnect window (drop → backoff → reopen → resubscribe).
      this.onReconnectStateChange?.(false)
    } catch (err) {
      console.error('[acp-transport] reconnect failed', err)
      this.scheduleReconnect()
    }
  }

  private async onMessage(raw: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const obj = parsed as Record<string, unknown>

    // Reply frame: has `ok` boolean + `id`
    if (typeof obj.id === 'string' && typeof obj.ok === 'boolean') {
      this.handleReply(obj as unknown as WsReply)
      return
    }

    // Event frame: has `type` + `seq`
    if (typeof obj.type === 'string' && typeof obj.seq === 'number') {
      await this.handleEvent(obj as unknown as WsEvent)
    }
  }

  private handleReply(reply: WsReply): void {
    const pending = this.pending.get(reply.id)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    this.pending.delete(reply.id)
    if (reply.ok) {
      pending.resolve(reply.payload)
    } else {
      pending.reject(new AcpTransportError(reply.err.code, reply.err.message || reply.err.code))
    }
  }

  private async handleEvent(evt: WsEvent): Promise<void> {
    if (evt.type === 'auth_required') {
      // Placeholder relay token until Epic 2 — never store in localStorage/query.
      // Send directly (socket is already open); do NOT call request()→connect()
      // or we deadlock on the in-flight connect promise.
      try {
        const auth = await this.sendWhenOpen<AcpAuthenticateReply>('authenticate', {
          token: 'dev'
        })
        this.negotiatedHistoryMode = auth?.historyMode ?? 'live_only'
        this.runtimePolicy = auth?.runtimePolicy ?? null
        this.authed = true
        // Start the application-level heartbeat now that the socket is OPEN
        // + authed — it refreshes the server keepalive watchdog through proxies
        // that strip WS-level Ping/Pong so a focused tab stops dropping at ~75s.
        this.startHeartbeat()
      } catch (err) {
        try {
          this.socket?.close()
        } catch {
          /* ignore */
        }
        throw err instanceof Error ? err : new AcpTransportError('closed', 'authenticate failed')
      }
      this.emitLocal(evt.type, evt.payload)
      return
    }

    // Agent-level / relay events (seq 0, or sid null): deliver immediately.
    if (evt.sid == null || evt.seq === 0) {
      if (evt.type === 'project_switch_completed') {
        const payload = evt.payload as ProjectSwitchCompletedEvent
        await this.subscribeSession(payload.sessionId, null)
      }
      this.emitLocal(evt.type, evt.payload)
      return
    }

    const sid = evt.sid
    this.refreshPromptActivity(sid)
    const tier = wsTierOf(evt.type)
    const last = this.lastSeq.get(sid) ?? 0

    if (evt.seq <= last) {
      // Duplicate — ignore.
      return
    }

    // Idempotent prompt_complete: drop a duplicate turn-id but advance the
    // cursor unconditionally so the seq pipeline cannot stall. A single FIFO
    // WebSocket never reorders (see the deliver-on-arrival model below), so
    // advancing only when contiguous would strand a replayed duplicate behind
    // an unfillable pre-subscribe gap.
    if (tier === 'idempotent' && evt.type === 'prompt_complete') {
      const turnId = extractTurnId(evt.payload)
      if (turnId && this.seenTurnIds.get(sid)?.has(turnId)) {
        this.lastSeq.set(sid, evt.seq)
        return
      }
    }

    // Deliver on arrival (desktop parity). A single FIFO WebSocket never
    // reorders, so the only gap sources (missed pre-subscribe emits, server
    // lossy drop-oldest) never fill later — an indefinite hold can only strand.
    // Advance the cursor to the delivered seq so live + reconnect-replay events
    // flow without duplication.
    this.deliverContiguous(sid, evt)
    return
  }

  private deliverContiguous(sid: string, evt: WsEvent): void {
    this.lastSeq.set(sid, evt.seq)
    if (evt.type === 'prompt_complete') {
      const turnId = extractTurnId(evt.payload)
      if (turnId) {
        let seen = this.seenTurnIds.get(sid)
        if (!seen) {
          seen = new Set()
          this.seenTurnIds.set(sid, seen)
        }
        seen.add(turnId)
      }
    }
    this.emitLocal(evt.type, evt.payload)
  }

  private emitLocal(wsType: string, payload: unknown): void {
    const set = this.listeners.get(wsType)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch (err) {
        console.error('[acp-transport] listener error', err)
      }
    }
  }

  private refreshPromptActivity(sessionId: string): void {
    const serverInactivityMs =
      this.runtimePolicy?.promptInactivityTimeoutMs ?? FALLBACK_SEND_PROMPT_INACTIVITY_MS
    // 0 = server-imposed unlimited inactivity: no inactivity budget is imposed.
    const inactivityMs = serverInactivityMs > 0 ? serverInactivityMs + SEND_PROMPT_GRACE_MS : 0
    for (const [id, pending] of this.pending) {
      if (pending.type !== 'send_prompt' || pending.sessionId !== sessionId) continue
      // Reset the inactivity timer but never extend past the absolute deadline.
      const timerMs = this.computeSendPromptTimerMs(inactivityMs, pending.deadline)
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer =
        timerMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              pending.reject(new AcpTransportError('timeout', 'Request send_prompt timed out'))
            }, timerMs)
          : null
    }
  }

  /**
   * Compute the send_prompt inactivity timer, in ms, honouring the server's
   * unlimited (0) sentinels. Returns 0 when both the inactivity budget and the
   * hard-cap deadline are unlimited — the caller then sets no client-side
   * timer (the request waits for a reply / cancel / socket close only).
   */
  private computeSendPromptTimerMs(inactivityMs: number, deadline: number | undefined): number {
    if (inactivityMs > 0) {
      const remaining = deadline != null ? deadline - Date.now() : inactivityMs
      return Math.min(inactivityMs, Math.max(0, remaining))
    }
    if (deadline != null) return Math.max(0, deadline - Date.now())
    return 0
  }

  private request<T = unknown>(type: WsRequestType, payload: unknown): Promise<T> {
    // Ensure connected first (unless socket already open — avoids reconnect loops).
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.sendWhenOpen(type, payload)
    }
    return this.connect().then(() => this.sendWhenOpen(type, payload))
  }

  /** Send a request assuming the socket is already OPEN (used during auth handshake). */
  private sendWhenOpen<T = unknown>(type: WsRequestType, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = crypto.randomUUID()
      const frame: WsRequest = { id, type, payload }
      const payloadRecord =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
      const sessionId =
        type === 'send_prompt' && typeof payloadRecord?.sessionId === 'string'
          ? payloadRecord.sessionId
          : undefined
      const isSendPrompt = type === 'send_prompt'
      const serverInactivityMs = isSendPrompt
        ? (this.runtimePolicy?.promptInactivityTimeoutMs ?? FALLBACK_SEND_PROMPT_INACTIVITY_MS)
        : 0
      const serverHardCapMs = isSendPrompt
        ? (this.runtimePolicy?.turnTimeoutMs ?? FALLBACK_SEND_PROMPT_INACTIVITY_MS)
        : 0
      // 0 = server-imposed unlimited; a non-zero value is the bounded budget
      // plus the grace margin so the server's typed timeout wins the race.
      const inactivityMs = serverInactivityMs > 0 ? serverInactivityMs + SEND_PROMPT_GRACE_MS : 0
      // Absolute ceiling: the inactivity refresh never extends past this
      // deadline so a long-stalled turn still times out despite intermittent
      // activity. `0` (unlimited hard cap) → no absolute deadline.
      const deadline =
        serverHardCapMs > 0 ? Date.now() + serverHardCapMs + SEND_PROMPT_GRACE_MS : undefined
      const timerMs = isSendPrompt
        ? this.computeSendPromptTimerMs(inactivityMs, deadline)
        : REQUEST_TIMEOUT_MS
      const timer =
        timerMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new AcpTransportError('timeout', `Request ${type} timed out`))
            }, timerMs)
          : null
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        type,
        sessionId,
        deadline
      })
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        if (timer) clearTimeout(timer)
        this.pending.delete(id)
        reject(new AcpTransportError('closed', 'WebSocket not open'))
        return
      }
      this.socket.send(JSON.stringify(frame))
    })
  }
}

function extractTurnId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.turnId === 'string') return p.turnId
  if (typeof p.turn_id === 'string') return p.turn_id
  // No unsafe sessionId:stopReason composite — that collapses distinct turns.
  return null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let singleton: AcpTransport | null = null

/** Create (or return) the process-wide ACP transport. */
export function createAcpTransport(opts?: {
  force?: 'tauri' | 'ws'
  ws?: { url?: string; WebSocketImpl?: typeof WebSocket }
}): AcpTransport {
  if (opts?.force === 'tauri') return createTauriAcpTransport()
  if (opts?.force === 'ws') return new WsAcpTransport(opts.ws)
  if (isTauriContext()) return createTauriAcpTransport()
  return new WsAcpTransport(opts?.ws)
}

/** Lazy singleton used by `acp-api.ts`. Resettable in tests via `_resetAcpTransportForTests`. */
export function getAcpTransport(): AcpTransport {
  if (!singleton) singleton = createAcpTransport()
  return singleton
}

/** @internal test helper */
export function _resetAcpTransportForTests(next?: AcpTransport | null): void {
  singleton?.dispose()
  singleton = next ?? null
}

/** @internal test helper — inject a pre-built transport as the singleton. */
export function _setAcpTransportForTests(transport: AcpTransport): void {
  singleton?.dispose()
  singleton = transport
}
