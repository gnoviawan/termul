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

import type {
  ProjectSwitchCompletedEvent,
  SwitchProjectReply
} from '@shared/types/web-projects.types'
import {
  type HistoryMode,
  type PersistedSessionSummary,
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
  NewSessionOutcome,
  SessionConfigOption,
  SessionId,
  SessionReopenOutcome,
  StopReason
} from '@/lib/acp-api'
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'
import { isTauriContext } from '@/lib/tauri-runtime'

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
  probeRuntime(): Promise<AcpRuntimeAvailability>
  fetchRegistrySnapshot(forceRefresh?: boolean): Promise<AcpRegistrySnapshot>
  spawnAgent(config: AgentConfig): Promise<AgentId>
  killAgent(agentId: AgentId): Promise<void>
  listAgents(): Promise<AgentId[]>
  newSession(agentId: AgentId, cwd: string, mcpServers?: McpServer[]): Promise<NewSessionOutcome>
  loadSession(agentId: AgentId, sessionId: SessionId, cwd: string): Promise<SessionReopenOutcome>
  resumeSession(agentId: AgentId, sessionId: SessionId, cwd: string): Promise<SessionReopenOutcome>
  closeSession(agentId: AgentId, sessionId: SessionId): Promise<void>
  listSessions(agentId: AgentId, cwd?: string, cursor?: string): Promise<ListSessionsResponse>
  sendPrompt(agentId: AgentId, sessionId: SessionId, text: string): Promise<StopReason>
  sendPromptBlocks(
    agentId: AgentId,
    sessionId: SessionId,
    content: ContentBlock[]
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
    probeRuntime: () => invoke<AcpRuntimeAvailability>('acp_probe_runtime'),
    fetchRegistrySnapshot: (forceRefresh = false) =>
      invoke<AcpRegistrySnapshot>('acp_fetch_registry_snapshot', { forceRefresh }),
    spawnAgent: (config) => invoke<AgentId>('acp_spawn_agent', { config }),
    killAgent: async (agentId) => {
      await invoke('acp_kill_agent', { agentId })
    },
    listAgents: () => invoke<AgentId[]>('acp_list_agents'),
    newSession: (agentId, cwd, mcpServers) =>
      invoke<NewSessionOutcome>('acp_new_session', { agentId, cwd, mcpServers }),
    loadSession: (agentId, sessionId, cwd) =>
      invoke<SessionReopenOutcome>('acp_load_session', { agentId, sessionId, cwd }),
    resumeSession: (agentId, sessionId, cwd) =>
      invoke<SessionReopenOutcome>('acp_resume_session', { agentId, sessionId, cwd }),
    closeSession: async (agentId, sessionId) => {
      await invoke('acp_close_session', { agentId, sessionId })
    },
    listSessions: (agentId, cwd, cursor) =>
      invoke<ListSessionsResponse>('acp_list_sessions', { agentId, cwd, cursor }),
    sendPrompt: (agentId, sessionId, text) =>
      invoke<StopReason>('acp_send_prompt', { agentId, sessionId, text }),
    sendPromptBlocks: (agentId, sessionId, content) =>
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
 * Timeout for `send_prompt`, which awaits the full agent turn on the server.
 * Stays slightly above Rust `TURN_TIMEOUT` (600s / `TERMUL_ACP_TURN_TIMEOUT_SECS`)
 * plus {@link SEND_PROMPT_GRACE_MS} so the server's specific `turn timeout`
 * error reaches the client before this generic timeout fires. A 60s client
 * budget caused `AcpTransportError: Request send_prompt timed out` on
 * mobile/ngrok whenever a turn (tools, thinking, slow models) exceeded a
 * minute — even while streaming events were still arriving.
 *
 * NOTE: if a deployment raises `TERMUL_ACP_TURN_TIMEOUT_SECS` above 600s,
 * this constant must be raised to match (ideally the server would publish its
 * turn budget to the client — tracked separately).
 */
const SEND_PROMPT_TIMEOUT_MS = 600_000 + SEND_PROMPT_GRACE_MS
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

function requestTimeoutMs(type: WsRequestType): number {
  return type === 'send_prompt' ? SEND_PROMPT_TIMEOUT_MS : REQUEST_TIMEOUT_MS
}

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
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
  private connecting: Promise<void> | null = null
  private disposed = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
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
  /** Idempotent prompt_complete turn ids already delivered. */
  private readonly seenTurnIds = new Set<string>()
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
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
        // Stale: clear cursor + turn-id dedup, then live-only resubscribe (no lastSeq).
        this.lastSeq.delete(sessionId)
        this.seenTurnIds.clear()
        await this.request('subscribe', { sessionId })
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

  async probeRuntime(): Promise<AcpRuntimeAvailability> {
    return { npx: true, uvx: true }
  }

  async fetchRegistrySnapshot(_forceRefresh = false): Promise<AcpRegistrySnapshot> {
    return { agents: [], source: 'empty', fetchedAt: null }
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

  async spawnAgent(config: AgentConfig): Promise<AgentId> {
    return this.request<AgentId>('spawn_agent', { config })
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
    mcpServers?: McpServer[]
  ): Promise<NewSessionOutcome> {
    const outcome = await this.request<NewSessionOutcome>('create_session', {
      agentId,
      cwd,
      mcpServers
    })
    if (outcome?.sessionId) {
      await this.subscribeSession(outcome.sessionId, null)
    }
    return outcome
  }

  /** Web/remote: subscribe immediately only when the server completed the switch. */
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
    await this.subscribeSession(sessionId)
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
    await this.subscribeSession(sessionId)
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

  async sendPrompt(agentId: AgentId, sessionId: SessionId, text: string): Promise<StopReason> {
    await this.subscribeSession(sessionId) // no-op if already subscribed
    // Story 1.8 T3.1 (FR11): generate a client turn-id so the server echoes it
    // back on `prompt_complete` → our `seenTurnIds` dedup fires (no duplicate
    // completion on reconnect replay). `crypto.randomUUID()` (available in
    // browsers + Node 19+; the web build targets modern evergreen browsers).
    const turnId = crypto.randomUUID()
    return this.request<StopReason>('send_prompt', { agentId, sessionId, text, turnId })
  }

  async sendPromptBlocks(
    agentId: AgentId,
    sessionId: SessionId,
    content: ContentBlock[]
  ): Promise<StopReason> {
    await this.subscribeSession(sessionId)
    const turnId = crypto.randomUUID()
    return this.request<StopReason>('send_prompt', { agentId, sessionId, content, turnId })
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
      clearTimeout(p.timer)
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
      for (const sid of [...this.subscribed]) {
        const last = this.lastSeq.get(sid)
        // Force re-subscribe after reconnect; pass cursor when known.
        await this.subscribeSession(sid, last ?? null, true)
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
    clearTimeout(pending.timer)
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
        const auth = await this.sendWhenOpen<{ historyMode?: HistoryMode }>('authenticate', {
          token: 'dev'
        })
        this.negotiatedHistoryMode = auth?.historyMode ?? 'live_only'
        this.authed = true
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
      if (turnId && this.seenTurnIds.has(turnId)) {
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
      if (turnId) this.seenTurnIds.add(turnId)
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
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AcpTransportError('timeout', `Request ${type} timed out`))
      }, requestTimeoutMs(type))
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer
      })
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        clearTimeout(timer)
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
