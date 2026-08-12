/**
 * WS relay protocol frame schema (Story 1.4).
 *
 * Single source of truth for the wire contract between the standalone
 * `termul-server` WS relay (`src-tauri/src/web/ws.rs`) and any browser client.
 * Mirrors the Rust structs/enums in `web/ws.rs` one-to-one.
 *
 * # Wire casing (AC3 — deviation from architecture text, MUST follow)
 *
 * The **envelope** fields (`sid`, `seq`, `type`, `payload`) are snake_case.
 * The **payload** is the existing camelCase-serialized ACP event struct
 * `Value` (byte-identical to what `TauriEventSink` emits today). The relay
 * serializes the payload ONCE via `fan_out` and forwards the `Value`
 * verbatim — this file does NOT re-case payload fields. `acp-api.ts` becomes
 * a no-op case boundary for payload fields; only the envelope is mapped.
 *
 * # Reliability tiers (AC5)
 *
 * `WS_RELAY_TIERS` is the single registry mapping each event `type` to its
 * delivery tier. Mirrors the Rust `ReliabilityTier` enum + `tier_of(type_)`.
 * Lossy events drop-oldest on a slow client; reliable events never drop
 * (unbounded per-client queue in this story); idempotent events dedup by
 * turn-id. Full ack/backpressure lands in Story 1.7.
 *
 * # OS vs human cap boundary (AC8)
 *
 * `WS_OS_FULFILLED_CAPS` / `WS_HUMAN_RELAYED_CAPS` mirror the Rust
 * `OS_FULFILLED_CAPS` / `HUMAN_RELAYED_CAPS` registries. The server is the
 * ACP client-of-record: OS caps are fulfilled locally; only human caps are
 * relayed to the browser. A browser WS request for an OS cap is rejected
 * with `err.code: "unsupported"`.
 *
 * Runtime-neutral: no `@tauri-apps/*` imports, no `@renderer/*` imports.
 * ESM-first. Strict-typed (no `any`).
 */

// ============================================================================
// Event `type` names (17) — acp:* prefix-dropped, snake_case (AC2)
// ============================================================================

/**
 * The 16 `acp:*` event names from `src-tauri/src/acp/events.rs` with the
 * `acp:` prefix dropped, plus the relay-level `auth_required` (not from
 * `events.rs`) and `projects_changed` (Epic-4 bridge — desktop project-list
 * live push). 18 total.
 */
export const WS_EVENT_TYPES = [
  // Session/agent lifecycle (reliable)
  'agent_spawned',
  'session_created',
  'session_closed',
  'agent_disconnected',
  'agent_error',
  // Session state (reliable)
  'tool_call',
  'mode_update',
  'config_options_update',
  'session_info_update',
  'usage_update',
  // Permission (reliable)
  'permission_request',
  // Prompt turn lifecycle (idempotent)
  'prompt_complete',
  // High-frequency streams (lossy)
  'message_chunk',
  'tool_call_update',
  'commands_update',
  'plan_update',
  // Relay-level (not from events.rs) (reliable)
  'auth_required',
  // Desktop project-list live push (Epic-4 bridge — agent-level, seq 0)
  'projects_changed',
  // Queued project switch outcome (connection-local, seq 0)
  'project_switch_completed',
  'project_switch_failed',
  // Server-authored authoritative user input (durable/replayable).
  'user_prompt',
  // Desktop chat-history live push (Epic-4 bridge — agent-level, seq 0).
  // Fired when the renderer-fed ChatHistoryCache mutates so connected web
  // clients refetch the session index.
  'chat_history_changed'
] as const

/** Union of all WS event `type` strings. */
export type WsEventType = (typeof WS_EVENT_TYPES)[number]

// ============================================================================
// Request `type` names (13) — acp_* command names prefix-dropped (AC2)
// ============================================================================

/**
 * The 17 WS request `type` names. Mirror the existing `acp_*` Tauri command
 * names with the `acp_` prefix dropped, snake_case. `create_session` maps to
 * the Tauri command `acp_new_session` (NOT `acp_create_session`); the WS
 * request `type` is `create_session` per architecture naming.
 *
 * Agent lifecycle (`spawn_agent` / `kill_agent` / `list_agents`) mirrors
 * `acp_spawn_agent` / `acp_kill_agent` / `acp_list_agents` for web desktop parity.
 *
 * `subscribe` (Story 1.6) is relay-level (not an `acp_*` command): binds a
 * connection to a session event log with an optional `lastSeq` cursor.
 * `ping` is a relay-level heartbeat: a client-emitted request that round-trips
 * an ok reply so the server's keepalive watchdog (`last_activity`) stays fresh
 * through proxies that strip WS-level Ping/Pong control frames.
 */
export const WS_REQUEST_TYPES = [
  'send_prompt',
  'cancel_prompt',
  'set_config_option',
  'set_mode',
  'set_model',
  'respond_permission',
  'answer_question',
  'create_session',
  'load_session',
  'resume_session',
  'close_session',
  'dispose_ephemeral_session',
  'list_sessions',
  'register_discovered_session',
  'spawn_agent',
  'kill_agent',
  'list_agents',
  'switch_project',
  // WS connection token-gate handshake (pre-auth). Distinct from
  // `authenticate_agent` (the ACP agent method).
  'authenticate',
  // ACP agent-advertised `authenticate` method (e.g. `pi_terminal_login`).
  // Post-auth request routed to `AcpManager::authenticate` on the host.
  'authenticate_agent',
  'subscribe',
  'ping',
  'list_persisted_sessions',
  'open_persisted_session',
  'get_session_payload',
  'recover_session_snapshot',
  // R2: lightweight server-authoritative replay cursor (no snapshot payload).
  // Unlike `recover_session_snapshot` (which re-registers a subscription),
  // this only returns the durable `{ sessionId, watermark }` so a refreshed
  // transport can seed `lastSeq` before its first subscribe.
  'get_session_cursor',
  // CAP-6 / Story 8: host-owned ACP catalog resolution. The web client
  // resolves the catalog through `list_acp_catalog` (the host's OS/arch/
  // runtime + per-agent `SupportedAcpAgentStatus`) + `set_catalog_opt_in`
  // (the host-persisted opt-in that gates CDN registry augmentation). The
  // web client never probes `@tauri-apps/plugin-os` or PATH locally — the
  // host is the single source of truth.
  'list_acp_catalog',
  'set_catalog_opt_in',
  // CAP-6 / Story 9: host-owned verified-atomic ACP install. The web client
  // installs a catalog agent through `install_acp_agent` (the host downloads +
  // verifies sha256 + extracts + atomically activates). The request is
  // `{ agentId }` only; the host resolves everything from the trusted catalog.
  'install_acp_agent'
] as const

/** Union of all WS request `type` strings. */
export type WsRequestType = (typeof WS_REQUEST_TYPES)[number]

// ============================================================================
// Error codes (9) — stable machine strings (AC2)
// ============================================================================

/**
 * The 10 stable `err.code` machine strings. Mirrors the Rust `WsErrorCode`
 * enum (snake_case `code`). Extended from the architecture's 7 by
 * `unsupported` (OS-cap rejection, AC8), `not_implemented` (stub request
 * handlers, AC10), and `no_agent` (switch_project with no live agent, Epic-4
 * bridge).
 */
export const WS_ERROR_CODES = {
  NOT_FOUND: 'not_found',
  UNAUTHORIZED: 'unauthorized',
  RATE_LIMITED: 'rate_limited',
  AGENT_CRASHED: 'agent_crashed',
  PERMISSION_DENIED: 'permission_denied',
  STALE: 'stale',
  DUPLICATE: 'duplicate',
  UNSUPPORTED: 'unsupported',
  NOT_IMPLEMENTED: 'not_implemented',
  // switch_project with no live agent on the connection (Epic-4 bridge).
  NO_AGENT: 'no_agent'
} as const

/** Union of all WS error code strings. */
export type WsErrorCode = (typeof WS_ERROR_CODES)[keyof typeof WS_ERROR_CODES]

// ============================================================================
// Reliability tiers (AC5) — single registry mirroring the Rust enum
// ============================================================================

/** The three delivery tiers. Mirrors the Rust `ReliabilityTier` enum. */
export const WS_RELAY_TIERS = {
  LOSSY: 'lossy',
  RELIABLE: 'reliable',
  IDEMPOTENT: 'idempotent'
} as const

/** A WS event delivery tier. */
export type ReliabilityTier = (typeof WS_RELAY_TIERS)[keyof typeof WS_RELAY_TIERS]

/**
 * The single tier registry: maps each `WsEventType` to its `ReliabilityTier`.
 * Mirrors the Rust `tier_of(type_: &str) -> ReliabilityTier`.
 *
 * - `lossy` (drop-oldest on slow client): `message_chunk`, `tool_call_update`,
 *   `commands_update`, `plan_update`.
 * - `idempotent` (dedup by turn-id): `prompt_complete`.
 * - `reliable` (never dropped; unbounded per-client queue in this story):
 *   everything else, including `permission_request` and all request↔reply.
 *
 * Full ack/backpressure + timeout=deny lands in Story 1.7.
 */
export const WS_EVENT_TIERS: Readonly<Record<WsEventType, ReliabilityTier>> = {
  // Lossy — high-frequency, low-value streams.
  message_chunk: WS_RELAY_TIERS.LOSSY,
  tool_call_update: WS_RELAY_TIERS.LOSSY,
  commands_update: WS_RELAY_TIERS.LOSSY,
  plan_update: WS_RELAY_TIERS.LOSSY,
  // Idempotent — dedup by turn-id.
  prompt_complete: WS_RELAY_TIERS.IDEMPOTENT,
  // Reliable — state/lifecycle/permission events must not be dropped.
  agent_spawned: WS_RELAY_TIERS.RELIABLE,
  session_created: WS_RELAY_TIERS.RELIABLE,
  session_closed: WS_RELAY_TIERS.RELIABLE,
  agent_disconnected: WS_RELAY_TIERS.RELIABLE,
  agent_error: WS_RELAY_TIERS.RELIABLE,
  tool_call: WS_RELAY_TIERS.RELIABLE,
  mode_update: WS_RELAY_TIERS.RELIABLE,
  config_options_update: WS_RELAY_TIERS.RELIABLE,
  session_info_update: WS_RELAY_TIERS.RELIABLE,
  usage_update: WS_RELAY_TIERS.RELIABLE,
  permission_request: WS_RELAY_TIERS.RELIABLE,
  auth_required: WS_RELAY_TIERS.RELIABLE,
  projects_changed: WS_RELAY_TIERS.RELIABLE,
  project_switch_completed: WS_RELAY_TIERS.RELIABLE,
  project_switch_failed: WS_RELAY_TIERS.RELIABLE,
  user_prompt: WS_RELAY_TIERS.RELIABLE,
  chat_history_changed: WS_RELAY_TIERS.RELIABLE
}

export type HistoryMode = 'server' | 'live_only'

/** Additive policy negotiated during the relay authenticate handshake. */
export interface AcpRuntimePolicy {
  /** Authoritative absolute server turn ceiling, in ms. `0` is the
   *  unlimited sentinel — no hard cap is imposed (the default). */
  turnTimeoutMs: number
  /** Matching session activity refreshes the renderer timer to this budget,
   *  in ms. `0` is the unlimited sentinel — no inactivity timer is imposed
   *  (the default). */
  promptInactivityTimeoutMs: number
  /** Grace before a last-subscriber disconnect denies pending permissions. */
  permissionReconnectGraceMs: number
  pingIntervalMs: number
  pongTimeoutMs: number
}

export interface AcpAuthenticateReply {
  historyMode?: HistoryMode
  runtimePolicy?: AcpRuntimePolicy
}

/** Atomic stale-recovery payload emitted before post-watermark live events. */
export interface SessionSnapshotEvent {
  sessionId: string
  watermark: number
  events: WsEvent[]
}

export interface PersistedSessionSummary {
  storageKey: string
  sessionId: string
  stableAgentNamespace: string | null
  runtimeAgentId?: string
  projectId?: string
  cwd: string
  title: string | null
  createdAt: number
  lastActivityAt: number
  status: 'active' | 'closed' | 'error'
  messageCount: number
  toolCount: number
  lastSeq: number
  /** Agent-owned metadata mirror; transcript remains authoritative in the agent. */
  discovered?: boolean
  resumeEligible: boolean
  /**
   * Worktree path the agent runs in (CAP-3). Additive: absent on pre-feature
   * sessions. Used by the CAP-6 indicator + the deleted-worktree fallback.
   * State isolation still keys on `cwd`; this field is for display only.
   */
  worktreePath?: string
  worktreeBranch?: string
}

export interface UserPromptEvent {
  agentId: string
  sessionId: string
  turnId?: string
  content: unknown[]
}

/**
 * Look up the reliability tier for an event `type`. Mirrors the Rust
 * `tier_of(type_)` free function. Unknown types default to `reliable`
 * (the safe choice — never drop an event the relay does not recognize).
 */
export function wsTierOf(type: WsEventType): ReliabilityTier {
  return WS_EVENT_TIERS[type] ?? WS_RELAY_TIERS.RELIABLE
}

// ============================================================================
// OS vs human cap boundary (AC8) — TS-side mirror of the Rust registries
// ============================================================================

/**
 * ACP caps the SERVER fulfills locally (the browser cannot perform them).
 * The browser must never send these as WS requests; a request for one is
 * rejected with `err.code: "unsupported"`.
 *
 * `terminal/*` is a prefix — every cap under the `terminal/` namespace is
 * OS-fulfilled. The enforcement layer matches prefixes ending in `/*`.
 */
export const WS_OS_FULFILLED_CAPS = [
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/*'
] as const

/**
 * ACP caps RELAYED to the browser (human-in-the-loop). The server forwards
 * these to the connected browser client which renders the human UI.
 * `session_notification` fan-out + `request_permission`.
 */
export const WS_HUMAN_RELAYED_CAPS = ['session_notification', 'request_permission'] as const

/**
 * Whether `cap` matches an OS-fulfilled cap entry (exact match, or prefix
 * match for entries ending in `/*`). Mirrors the Rust enforcement check.
 */
export function isOsFulfilledCap(cap: string): boolean {
  return WS_OS_FULFILLED_CAPS.some(
    (entry) => entry === cap || (entry.endsWith('/*') && cap.startsWith(entry.slice(0, -1)))
  )
}

/**
 * Whether `cap` matches a human-relayed cap entry (exact match).
 */
export function isHumanRelayedCap(cap: string): boolean {
  return WS_HUMAN_RELAYED_CAPS.some((entry) => entry === cap)
}

// ============================================================================
// Frame envelopes (AC2 + AC3)
// ============================================================================

/**
 * A WS event envelope pushed server→client.
 *
 * Envelope fields are snake_case (`sid`, `seq`, `type`, `payload`); the
 * `payload` is the existing camelCase ACP event struct value (byte-identical
 * to `TauriEventSink`'s emission). `sid` is `null` for agent-level events
 * (`agent_spawned`, `agent_disconnected`, `agent_error` without a session,
 * `auth_required`); `seq` is `0` for agent-level + relay-level events.
 */
export interface WsEvent {
  /** Session id, or `null` for agent-level / relay-level events. */
  sid: string | null
  /** Per-session monotonic sequence number (starts at 1). `0` for agent-level. */
  seq: number
  /** The event `type` (one of `WsEventType`). */
  type: WsEventType
  /** The camelCase ACP event struct value (passed through verbatim). */
  payload: unknown
}

/**
 * A WS request frame sent client→server.
 *
 * `id` is a client-chosen correlation id echoed back in the `WsReply`.
 */
export interface WsRequest {
  /** Client-chosen correlation id (echoed in the reply). */
  id: string
  /** The request `type` (one of `WsRequestType`). */
  type: WsRequestType
  /** Request payload (shape depends on `type`). */
  payload: unknown
}

/**
 * A WS reply envelope sent server→client in response to a `WsRequest`.
 *
 * Discriminated union on `ok`: success carries `payload`; failure carries
 * `err` with a stable machine `code` (one of `WsErrorCode`) + human message.
 * Mirrors the `IpcResult<T>` philosophy from `ipc.types.ts`.
 */
export type WsReply<T = unknown> =
  | { id: string; ok: true; payload?: T; err?: never }
  | { id: string; ok: false; payload?: never; err: { code: WsErrorCode; message: string } }

/**
 * The `err` object shape inside a failing `WsReply`.
 */
export interface WsError {
  code: WsErrorCode
  message: string
}
