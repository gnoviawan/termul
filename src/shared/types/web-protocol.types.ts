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
 * The `acp:*` event names from `src-tauri/src/acp/events.rs` with the `acp:`
 * prefix dropped (18, including `browser_open_request`), plus the relay-level
 * `auth_required` event and the top-level delivery frames (`gap`, `heartbeat`).
 * The `watch` frame has the same name as the `watch` request, so its type
 * lives in {@link WS_WATCH_FRAME_TYPE}, outside this registry.
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
  // Server-authored authoritative user input (durable/replayable).
  'user_prompt',
  // Headless ACP auth (spec-acp-terminal-auth): the host's browser-open shim
  // captured the agent's auth URL. Agent-level event (sid null, seq 0);
  // payload `{ agentId, url }` — the renderer shows the BrowserAuthDialog.
  'browser_open_request',
  // CAP-2 (spec-in-chat-agent-switch): durable agent-switch marker (Reliable
  // tier). The host numbers it once; the durable record and this live event
  // share one seq.
  'agent_switch',
  // Host-authored durable title record (Reliable tier). Occupies a seq in the
  // session log like any record, so live delivery keeps the seq run
  // contiguous; the title itself reaches the UI through the
  // `session_info_update` that follows it, so clients have no handler for it.
  'local_title_generated',
  // #856 (web explorer live refresh): server-side FS watcher batch. Agent-
  // level event (sid null, seq 0), delivered only to connections that sent
  // `watch_project`; payload `{ projectId, root, paths: string[] }` —
  // the renderer's filesystem facade dispatches the paths through its
  // onFileChanged/onFileCreated/onFileDeleted chain (web parity with the
  // desktop notify watcher).
  'fs_changed',
  // The host ended this connection's watch of a project because it is no
  // longer watchable (archived/removed/root gone). Agent-level event (sid
  // null, seq 0); payload `{ projectId, reason }` — the client forgets the
  // watch so the next `watchDirectory` re-requests it.
  'fs_watch_ended',
  // Shell revamp story 16 (CAP-5): the host renamed a worktree's git branch
  // and rewrote every session on it. Agent-level event (sid null, seq 0);
  // payload `{ worktreePath, oldBranch, newBranch }` — the renderer reconciles
  // worktrees and refreshes the session index.
  'worktree_branch_renamed',
  // Top-level frame `{ type: 'gap', sid }` (no `seq`): LOSSY events of `sid`
  // were dropped for this connection because it could not keep up. The client
  // installs an atomic snapshot of the session.
  'gap',
  // Top-level frame `{ type: 'heartbeat' }` (no `seq`): the host writes one
  // every 10 s straight to the socket, so the client judges liveness from any
  // host frame instead of a ping round trip.
  'heartbeat'
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
 * `acp_spawn_agent` / `acp_kill_agent` for web desktop parity; since CAP-11 the
 * identity-rich WS `list_agents` reply pairs with `acp_list_agent_details`
 * (desktop `acp_list_agents` keeps returning bare ids).
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
  // Story 8: promote a backend-ephemeral warm-pool session to durable
  // (registers persistence metadata + clears the ephemeral mark).
  'promote_session',
  'list_sessions',
  'register_discovered_session',
  'spawn_agent',
  'kill_agent',
  'list_agents',
  // WS connection token-gate handshake (pre-auth). Distinct from
  // `authenticate_agent` (the ACP agent method).
  'authenticate',
  // ACP agent-advertised `authenticate` method (e.g. `pi_terminal_login`).
  // Post-auth request routed to `AcpManager::authenticate` on the host.
  'authenticate_agent',
  'logout_agent',
  'delete_agent_session',
  'respond_elicitation',
  'subscribe',
  'ping',
  'list_persisted_sessions',
  // CAP-11: host-owned session delete (desktop parity with the
  // `acp_history_delete` Tauri command). Boolean reply (finding 6): `true` =
  // deleted, `false` = record already absent (idempotent no-op); genuine
  // errors reject. Publishes a `chat_history` watch delta on a real delete;
  // live-only mode → `unsupported`.
  'delete_session',
  'open_persisted_session',
  'get_session_payload',
  'recover_session_snapshot',
  // R2: lightweight server-authoritative replay cursor (no snapshot payload).
  // Unlike `recover_session_snapshot` (which re-registers a subscription),
  // this only returns the durable `{ sessionId, watermark }` (plus the log's
  // `logEpoch`/`headSeq`, see `SessionCursorReply`) so a refreshed transport
  // can seed its `(logEpoch, lastSeq)` cursor before its first subscribe.
  'get_session_cursor',
  // Tail-first variant of `get_session_payload`: fetches only the last `limit`
  // messages + matching tool calls so the renderer can install the recent
  // transcript immediately and lazy-load the full payload on scroll-up.
  'get_session_payload_tail',
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
  'install_acp_agent',
  // Headless ACP auth (spec-acp-terminal-auth): deliver a user-pasted
  // loopback OAuth redirect URL to the agent's callback listener on the
  // host. Payload `{ agentId, url }`; reply `{ status }` (the replay's HTTP
  // status). The host validates http(s) + loopback-only before fetching
  // (SSRF guard). NOTE: this request keeps the `acp_` prefix — the wire
  // name is fixed by the contract, not the prefix-drop convention.
  'acp_deliver_auth_redirect',
  // Issue #613: server-side generic key-value store — the web client routes
  // its `persistenceApi` through these (replacing the per-browser localStorage
  // stub) so settings / layout / command history / SSH profiles survive
  // browser switches + server restarts. Errors carry SCREAMING_SNAKE_CASE
  // codes via `err_with_code`: `STORE_UNAVAILABLE` (no store attached),
  // `STORE_WRITE_FAILED` / `STORE_DELETE_FAILED` (IO), `VALIDATION_ERROR`
  // (malformed payload, empty/whitespace key, key > 1024 bytes — CAP-11),
  // `STORE_VALUE_TOO_LARGE` (serialized value > 256 KiB — CAP-11).
  'store_read',
  'store_write',
  'store_delete',
  // Option B: project-list mutations (the standalone server is a first-class
  // project-list authority). Mirrors `POST /projects`, `PUT /projects/{id}`,
  // `DELETE /projects/{id}` HTTP routes (transport parity). The WS variants
  // persist to `FileProjectRegistry` (VPS) with rollback + publish the new
  // state to every `projects` watcher.
  'add_project',
  'update_project',
  'remove_project',
  // CAP-2 (spec-in-chat-agent-switch): host-authored durable agent-switch
  // marker. Mirrors the `acp_record_agent_switch` Tauri command: the host
  // numbers ONE `agent_switch` record, appends it durably and delivers the
  // `acp:agent_switch` event to live clients under the same seq. Reply `{}`;
  // unknown session → `not_found`; live-only mode → `unsupported`.
  'record_agent_switch',
  // Per-project fs watch: `{ projectId }` subscribes/unsubscribes THIS
  // connection to the host watcher of a registered project; `fs_changed`
  // events then reach only subscribed connections. `watch_project` of an
  // unknown/archived project → `not_found`; `unwatch_project` is idempotent
  // (always ok for a well-formed request).
  'watch_project',
  'unwatch_project',
  // State watches `{ watch, scope? }` (`projects`, `chat_history`, `agents`):
  // `watch` queues the full-state frame, then replies `{ watch, scope,
  // revision }`; later changes arrive as deltas under `n + 1`. A second
  // `watch` of the same (watch, scope) replaces the subscription and sends
  // fresh state. `unwatch` is idempotent. Unknown watch or scope → `unsupported`.
  'watch',
  'unwatch',
  // Explicit host-default project change (updates `default_project_id`,
  // persists on file-backed hosts, publishes the project state to every
  // `projects` watcher).
  'set_default_project'
] as const

/** Union of all WS request `type` strings. */
export type WsRequestType = (typeof WS_REQUEST_TYPES)[number]

/** How the host's receipt ledger treats a request type. Mirrors the Rust `ClassKind`. */
export type WsCommandKind = 'create' | 'command' | 'idempotent' | 'read'

/**
 * How a settled command is answered on a same-id resend: `payload` replays the
 * stored reply, `entity` rebuilds it from the entity stamped with the
 * `commandId` (`send_prompt`: its `turnId` is its `commandId`), `receipt-only`
 * never stores a payload (credential-bearing kinds). `null` for `idempotent`
 * and `read`. Mirrors the Rust `Replay`.
 */
export type WsCommandReplay = 'payload' | 'entity' | 'receipt-only'

/**
 * The command class of every `/ws` request type — mirrors the Rust
 * `WS_COMMAND_CLASSES` table row for row (pinned by the Rust
 * `command_ledger::class_tests` parity test). `create` and `command` mint a
 * `commandId`; `idempotent` and `read` never need one.
 */
export const WS_COMMAND_CLASSES: Readonly<
  Record<WsRequestType, readonly [WsCommandKind, WsCommandReplay | null]>
> = {
  send_prompt: ['command', 'entity'],
  cancel_prompt: ['idempotent', null],
  set_config_option: ['idempotent', null],
  set_mode: ['idempotent', null],
  set_model: ['idempotent', null],
  respond_permission: ['command', 'payload'],
  answer_question: ['command', 'payload'],
  create_session: ['create', 'entity'],
  load_session: ['command', 'payload'],
  resume_session: ['command', 'payload'],
  close_session: ['command', 'payload'],
  dispose_ephemeral_session: ['command', 'payload'],
  promote_session: ['command', 'payload'],
  list_sessions: ['read', null],
  register_discovered_session: ['command', 'payload'],
  spawn_agent: ['create', 'entity'],
  kill_agent: ['idempotent', null],
  list_agents: ['read', null],
  authenticate: ['read', null],
  authenticate_agent: ['command', 'receipt-only'],
  logout_agent: ['idempotent', null],
  delete_agent_session: ['idempotent', null],
  respond_elicitation: ['command', 'receipt-only'],
  subscribe: ['read', null],
  ping: ['read', null],
  list_persisted_sessions: ['read', null],
  delete_session: ['idempotent', null],
  open_persisted_session: ['read', null],
  get_session_payload: ['read', null],
  recover_session_snapshot: ['read', null],
  get_session_cursor: ['read', null],
  get_session_payload_tail: ['read', null],
  list_acp_catalog: ['read', null],
  set_catalog_opt_in: ['idempotent', null],
  install_acp_agent: ['command', 'payload'],
  acp_deliver_auth_redirect: ['command', 'receipt-only'],
  store_read: ['read', null],
  store_write: ['idempotent', null],
  store_delete: ['idempotent', null],
  add_project: ['idempotent', null],
  update_project: ['idempotent', null],
  remove_project: ['idempotent', null],
  set_default_project: ['idempotent', null],
  record_agent_switch: ['command', 'payload'],
  watch_project: ['read', null],
  unwatch_project: ['read', null],
  watch: ['read', null],
  unwatch: ['read', null]
}

/** Longest accepted `commandId`, in bytes. Mirrors the Rust `MAX_COMMAND_ID_LEN`. */
export const MAX_COMMAND_ID_LEN = 128

/** A well-formed `commandId`: 1-128 characters of `[A-Za-z0-9_-]`. */
export const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

// ============================================================================
// Session history lifecycle (CAP-11) — request payloads + reply contracts
// ============================================================================

/**
 * `delete_session` request payload. Permanently removes a persisted session
 * from the host-owned store. Boolean reply (finding 6): `true` = deleted,
 * `false` = record already absent (idempotent no-op); `unsupported` in
 * live-only mode. Older servers may still reply `not_found` for an unknown id.
 */
export interface DeleteSessionPayload {
  sessionId: string
}

/**
 * `record_agent_switch` request payload (CAP-2, spec-in-chat-agent-switch).
 * Host-authored durable agent-switch marker — mirrors the
 * `acp_record_agent_switch` Tauri command args; the durable record's payload
 * is the `agent_switch` event built from them (these fields plus the
 * runtime `agentId`). Reply: `{}` on success; `not_found` for an unknown
 * session; `unsupported` in live-only mode or on a storage failure.
 */
export interface RecordAgentSwitchPayload {
  sessionId: string
  fromConfigId: string
  toConfigId: string
  /** The NEW session id the conversation continues in (CAP-7 reopen). */
  newSessionId: string
  summaryText: string
}

// Frozen replay contract 1: `resume_session` NEVER emits replay events or a
// replay snapshot — history reconstruction belongs to `get_session_payload` /
// `recover_session_snapshot`. The `resume_session` ok payload carries the
// explicit `"replaySnapshot": null` marker documenting that absence.

/**
 * ACP agent capabilities as advertised at `initialize` (camelCase on the
 * wire). Open shape — unknown keys pass through. Declared here (the wire
 * contract) and re-exported by `@/lib/acp-api`: shared types must not import
 * renderer modules (tsconfig.node.json covers `src/shared` without the `@/`
 * alias).
 */
export interface AgentCapabilities {
  loadSession?: boolean
  sessionCapabilities?: {
    resume?: unknown
    close?: unknown
    list?: unknown
    delete?: unknown
    additionalDirectories?: unknown
  } | null
  auth?: { logout?: unknown } | null
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean } | null
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean } | null
  [k: string]: unknown
}

/**
 * `list_agents` reply element (CAP-11): identity-rich agent summary —
 * `{ id, name, configId?, namespace?, capabilities, ownsSession }` replacing
 * the bare id-string array. `configId`/`namespace` are omitted when absent
 * (server-side `skip_serializing_if`). `WsAcpTransport.listAgents` maps
 * these to bare ids; `listAgentDetails` returns the full summaries.
 * Desktop parity: the `acp_list_agent_details` Tauri command.
 */
export interface WsAgentSummary {
  id: string
  name: string
  configId?: string
  namespace?: string
  capabilities: AgentCapabilities
  /**
   * Session ids whose workspace roots are registered on this agent's driver
   * (issue #837). Always serialized by the current server (as `[]` when the
   * agent owns no session); older servers omit it — consumers treat absent
   * as "unknown/none".
   */
  ownsSession?: string[]
}

// ============================================================================
// Server-side key-value store (issue #613) — request payloads + replies
// ============================================================================

/** `store_read` request payload. Reply: `{ value: unknown | null }`. */
export interface StoreReadPayload {
  key: string
}

/** `store_write` request payload. `value` is any JSON value. Reply: `{}`. */
export interface StoreWritePayload {
  key: string
  value: unknown
}

/** `store_delete` request payload. Reply: `{ existed: boolean }`. */
export interface StoreDeletePayload {
  key: string
}

// ============================================================================
// Project-list mutations (Option B) — request payloads + replies
// ============================================================================

/** `add_project` request payload. Reply: `{ project: ProjectSummary }`. */
export interface AddProjectPayload {
  id: string
  name: string
  path: string
  color: string
  isArchived?: boolean
}

/** `update_project` request payload. All fields optional. Reply: `{}`. */
export interface UpdateProjectPayload {
  projectId: string
  name?: string
  color?: string
  isArchived?: boolean
}

/** `remove_project` request payload. Reply: `{}`. */
export interface RemoveProjectPayload {
  projectId: string
}

// ============================================================================
// Error codes — stable machine strings (AC2)
// ============================================================================

/**
 * The stable `err.code` machine strings. Mirrors the Rust `WsErrorCode`
 * enum (snake_case `code`). Extended from the architecture's 7 by
 * `unsupported` (OS-cap rejection, AC8), `not_implemented` (stub request
 * handlers, AC10), and `agent_auth_required` (agent rejected session entry with ACP
 * AuthRequired -32000, Story 7).
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
  // Agent rejected session entry with ACP AuthRequired (-32000) — the user
  // must authenticate first (Story 7; additive — old clients ignore unknown
  // codes).
  AGENT_AUTH_REQUIRED: 'agent_auth_required',
  // resume_session/load_session rejected because a DIFFERENT live agent owns
  // the session and is mid-turn (issue #837). Retryable: re-ask the host for
  // the owner (`list_agents.ownsSession`) and resume on that agent.
  SESSION_OWNED_BY_OTHER: 'session_owned_by_other',
  // `authenticate` carried a missing or different `protocolVersion`
  // (`WS_PROTOCOL_VERSION`). The client must reload; no compat shim (AD-15).
  PROTOCOL_VERSION_MISMATCH: 'protocol_version_mismatch',
  // `authenticate` carried a missing, empty or oversized `deviceId` /
  // `clientInstanceId` (AD-4). The host never mints either id.
  INVALID_CLIENT_IDENTITY: 'invalid_client_identity',
  // Reserved names — handler behavior lands in later slices.
  // A host terminal cap (per project or global) refused a spawn.
  TERMINAL_LIMIT: 'terminal_limit',
  // Project remove/archive refused while bound sessions/PTYs are live.
  PROJECT_BUSY: 'project_busy',
  // A command resend found no stored outcome (evicted ledger entry or an
  // interrupted handler); never re-executed.
  OUTCOME_UNKNOWN: 'outcome_unknown',
  // Branch switch / worktree removal refused while a session in the target
  // path has an active turn.
  DESTRUCTIVE_OP_BLOCKED: 'destructive_op_blocked',
  // Upstream provider refused the call: quota / usage limit.
  PROVIDER_QUOTA_EXCEEDED: 'provider_quota_exceeded',
  // Upstream provider refused the call: session limit.
  PROVIDER_SESSION_LIMIT: 'provider_session_limit',
  // Upstream provider rejected the request with a 4xx class error.
  PROVIDER_REQUEST_REJECTED: 'provider_request_rejected',
  // The connection lacks the capability the request needs (view-only
  // connection attempting a mutation outside `device/<deviceId>/`).
  FORBIDDEN: 'forbidden',
  // respond_permission / answer_question named a ticket that was already
  // resolved (bounded tombstones; an older ticket reads `stale`).
  ALREADY_RESOLVED: 'already_resolved',
  // Spawn rejected deterministically: the agent binary is missing, not
  // installed, or cannot start. Definite (AD-5): never auto-retried.
  AGENT_UNAVAILABLE: 'agent_unavailable',
  // Spawn rejected deterministically: empty/invalid agent name, command or
  // configId. Definite (AD-5): never auto-retried.
  INVALID_AGENT_CONFIG: 'invalid_agent_config',
  // A `commandId` was resent with a different request than it was first used
  // for. Never replayed, never executed.
  COMMAND_CONFLICT: 'command_conflict',
  // A request's `commandId` is malformed (not 1-128 chars of [A-Za-z0-9_-]).
  INVALID_COMMAND_ID: 'invalid_command_id'
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
 * - `lossy` (dropped for a slow client, followed by a `gap` frame): `message_chunk`, `tool_call_update`,
 *   `commands_update`, `plan_update`.
 * - `idempotent` (dedup by turn-id): `prompt_complete`.
 * - `reliable` (never dropped silently; a subscriber that cannot take one loses
 *   its connection and resumes by cursor): everything else, including
 *   `permission_request` and all request↔reply.
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
  user_prompt: WS_RELAY_TIERS.RELIABLE,
  browser_open_request: WS_RELAY_TIERS.RELIABLE,
  // CAP-2: switch markers are one-shot durable-backed events — reliable.
  agent_switch: WS_RELAY_TIERS.RELIABLE,
  // Durable host record that owns a seq — reliable so no seq goes missing.
  local_title_generated: WS_RELAY_TIERS.RELIABLE,
  // #856: fs_changed batches are debounced snapshots — a lost one is
  // recovered by the next batch or a manual refresh, but reliable keeps
  // the tree consistent without polling.
  fs_changed: WS_RELAY_TIERS.RELIABLE,
  // One-shot host fact that a watch ended — dropping it would leave the
  // client believing it still watches, so reliable.
  fs_watch_ended: WS_RELAY_TIERS.RELIABLE,
  // Story 16: a one-shot host fact (every session on the worktree changed) —
  // dropping it would leave stale branch labels, so reliable.
  worktree_branch_renamed: WS_RELAY_TIERS.RELIABLE,
  // Frames about delivery itself: a gap must reach the client in order, and a
  // heartbeat is never queued, so neither may be a lossy event.
  gap: WS_RELAY_TIERS.RELIABLE,
  heartbeat: WS_RELAY_TIERS.RELIABLE
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
  pingIntervalMs: number
  pongTimeoutMs: number
}

/**
 * The `authenticate` protocol version this client speaks. Mirrors the Rust
 * `WS_PROTOCOL_VERSION`. Bump it on any wire-contract change (AD-15).
 */
export const WS_PROTOCOL_VERSION = 6

/** Longest accepted `deviceId` / `clientInstanceId`, in bytes. */
export const MAX_CLIENT_ID_LEN = 128

/**
 * `authenticate` payload (AD-4, AD-15). `token` is omitted only when no web
 * auth token is configured. Neither id is a credential, and the host never
 * mints or rewrites either.
 */
export interface AcpAuthenticatePayload {
  token?: string
  protocolVersion: number
  /** Per install / browser profile; persisted locally. */
  deviceId: string
  /** Per tab or window; kept in `sessionStorage`. */
  clientInstanceId: string
}

export interface AcpAuthenticateReply {
  historyMode?: HistoryMode
  runtimePolicy?: AcpRuntimePolicy
  /** The protocol version the host speaks. */
  protocolVersion?: number
}

/**
 * Atomic stale-recovery payload emitted before post-watermark live events.
 * `logEpoch` + `headSeq` are read under the host's seq lock at registration:
 * the client's next cursor is `(logEpoch, watermark)`.
 */
export interface SessionSnapshotEvent {
  sessionId: string
  watermark: number
  /** The allocated seq frontier at registration (equals `watermark`). */
  headSeq: number
  /** Identity of the log incarnation the cursor belongs to. */
  logEpoch: string
  events: WsEvent[]
}

/**
 * `subscribe` reply. A cursor (`lastSeq`, optionally with the `logEpoch` it was
 * issued under) from another epoch or ahead of `headSeq` is answered with a
 * `stale` error instead and registers nothing. Events with `seq <= headSeq` are
 * replay (durable replay may skip non-durable seqs); anything above is live and
 * must be contiguous.
 */
export interface SessionSubscribeReply {
  sessionId: string
  replayed: number
  logEpoch: string
  headSeq: number
}

/**
 * `get_session_cursor` reply: the durable `watermark` plus, for a session the
 * host knows, the log's epoch and allocated frontier. An unknown session has
 * neither (the client subscribes live-only).
 */
export interface SessionCursorReply {
  sessionId: string
  watermark: number
  logEpoch?: string
  headSeq?: number
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
  /**
   * True while a prompt turn is still open. Older hosts omit it; readers
   * derive the open turn from the session payload before launch recovery.
   */
  turnActive?: boolean
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
  /**
   * Host-recorded current model (CAP-3): id plus a display-name snapshot taken
   * when it was recorded. Additive: absent on old entries and on
   * discovered/imported sessions; never written by a client.
   */
  modelId?: string
  modelName?: string
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

/** Top-level `gap` frame: LOSSY events of `sid` were dropped for this connection. */
export interface WsGapFrame {
  type: 'gap'
  sid: string
}

/** Top-level `heartbeat` frame: the host is alive. */
export interface WsHeartbeatFrame {
  type: 'heartbeat'
}

/**
 * `type` of the top-level watch frame (no `seq`): the full state of a watch
 * (`reset: true`, revision `n = 1`) or one delta after it. It shares its name
 * with the `watch` request, which is told apart by the request's `id`. It has
 * no tier: a delta the host cannot queue leaves a revision gap, and the client
 * resubscribes for fresh state.
 */
export const WS_WATCH_FRAME_TYPE = 'watch'

/** The state watches a connection can hold. All three have the empty scope. */
export const WS_WATCH_NAMES = ['projects', 'chat_history', 'agents'] as const

/** One of {@link WS_WATCH_NAMES}. */
export type WsWatchName = (typeof WS_WATCH_NAMES)[number]

/**
 * `(hostEpoch, n)`: which serve start produced a watch frame, and its position
 * in that subscription's stream. `n` is `1` for the full state and then rises
 * by one per frame.
 */
export interface WsWatchRevision {
  hostEpoch: string
  n: number
}

/** Fields every `watch` frame carries. */
interface WsWatchFrameBase {
  type: typeof WS_WATCH_FRAME_TYPE
  watch: WsWatchName
  scope: string
  revision: WsWatchRevision
}

/** Top-level `watch` frame with the full state of a watch (revision `n = 1`). */
export interface WsWatchStateFrame extends WsWatchFrameBase {
  reset: true
  state: unknown
  delta?: undefined
}

/** Top-level `watch` frame with one delta after the state. */
export interface WsWatchDeltaFrame extends WsWatchFrameBase {
  reset?: undefined
  state?: undefined
  delta: unknown
}

/** Top-level `watch` frame: exactly one of the state and delta forms. */
export type WsWatchFrame = WsWatchStateFrame | WsWatchDeltaFrame

/** `watch` reply payload. */
export interface WsWatchReply {
  watch: WsWatchName
  scope: string
  revision: WsWatchRevision
}

/**
 * A `chat_history` delta: the session ids whose index entry changed (an empty
 * list means the index changed in bulk). The client refetches the index.
 */
export interface ChatHistoryWatchDelta {
  changed: string[]
}

/**
 * An `agents` delta: an agent-level lifecycle event, with the payload it had
 * as an event.
 */
export interface AgentsWatchDelta {
  event:
    | 'agent_spawned'
    | 'agent_crashed'
    | 'agent_error'
    | 'agent_disconnected'
    // An intentional kill emits no lifecycle event; the payload is `{ agentId }`.
    | 'agent_removed'
  payload: unknown
}

/** A delta the host sends when it could not queue the one before it. */
export interface WatchResyncDelta {
  resync: true
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
  /**
   * Client-minted command id for a mutating request. The field name is fixed
   * here; the host ignores it until the command/receipt work lands.
   */
  command_id?: string
}

/**
 * A WS reply envelope sent server→client in response to a `WsRequest`.
 *
 * Discriminated union on `ok`: success carries `payload`; failure carries
 * `err` with a stable machine `code` (one of `WsErrorCode`) + human message.
 * Mirrors the `IpcResult<T>` philosophy from `ipc.types.ts`.
 */
export type WsReply<T = unknown> =
  | { id: string; ok: true; payload?: T; err?: never; visible_at?: unknown }
  | {
      id: string
      ok: false
      payload?: never
      err: { code: WsErrorCode; message: string }
      visible_at?: unknown
    }

/**
 * The `err` object shape inside a failing `WsReply`.
 */
export interface WsError {
  code: WsErrorCode
  message: string
}
