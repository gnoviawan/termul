/**
 * Shared types for the ACP store — extracted from `../acp-store.ts`
 * (spec-04 PR A). Pure declarations only: no store logic lives here.
 */

import type { SwitchProjectReply } from '@shared/types/web-projects.types'
import type { PendingLauncherOptions } from '@/components/agents/pending-launcher-options'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type {
  AgentCapabilities,
  AgentConfig,
  AgentCrashedEvent,
  AgentDisconnectedEvent,
  AgentErrorEvent,
  AgentId,
  AgentSpawnedEvent,
  AgentSwitchEvent,
  AskUserQuestionEvent,
  AuthMethod,
  AvailableCommand,
  acpApi,
  BrowserAgentTabEvent,
  BrowserConsentRequestEvent,
  BrowserOpenRequestEvent,
  CommandsUpdateEvent,
  ConfigOptionsUpdateEvent,
  ContentBlock,
  ElicitationField,
  ElicitationRequestEvent,
  McpServer,
  McpToolInfo,
  MessageChunkEvent,
  ModeUpdateEvent,
  PermissionOption,
  PermissionRequestEvent,
  PlanEntry,
  PlanUpdateEvent,
  ProbeStatus,
  PromptCompleteEvent,
  QuestionOption,
  SessionClosedEvent,
  SessionConfigOption,
  SessionCreatedEvent,
  SessionId,
  SessionInfo,
  SessionInfoUpdateEvent,
  SessionModelState,
  SessionModeState,
  SessionUsage,
  StopReason,
  ToolCall,
  ToolCallEvent,
  ToolCallUpdateEvent,
  UsageUpdateEvent,
  UserPromptEvent
} from '@/lib/acp-api'
import type { AgentSwitchRecord, SessionIndexEntry } from '@/lib/acp-history-persistence'
import type { StoredMcpServer } from '@/lib/acp-mcp-persistence'
import type { TurnEndNotice } from '@/lib/agent-chat-notify'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import type { QueuedPrompt } from '../prompt-queue-orchestration'

export type AgentStatus = 'idle' | 'spawning' | 'connected' | 'error'
export type SessionStatus = 'initializing' | 'active' | 'error' | 'closed'
export type MessageRole = 'user' | 'agent' | 'thought'

/**
 * Last-known model/mode/config options for an agent config id (in-memory only).
 * Used as stale-while-revalidate paint while `prepareChat` / `session/new` catch up.
 */
export interface AgentOptionsCacheEntry {
  models: SessionModelState | null
  modes: SessionModeState | null
  configOptions: SessionConfigOption[]
  updatedAt: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  blocks: ContentBlock[]
  streaming: boolean
  timestamp: number
  /**
   * Monotonic arrival sequence stamped at append time. Orders messages and
   * tool calls on one chronological timeline, robust against same-millisecond
   * ties that `timestamp` alone can't break. Absent on history persisted
   * before seq existed (those order by `timestamp`).
   */
  seq?: number
  /**
   * spec-agent-switch-separator-redesign: a summary-only handoff
   * `user_prompt` folds to a boundary row — it renders nothing (empty
   * blocks, filtered before display) but keeps the turn's reply visible in
   * `partitionTranscriptTurns`: a switch turn is real, not a hidden
   * synthetic greeting turn.
   */
  handoffBoundary?: boolean
  /**
   * ACP `messageId` for this bubble. Chunks with the same id merge into it.
   * A different id starts a new bubble.
   */
  messageId?: string
}

export interface AcpSession {
  id: SessionId
  agentId: AgentId
  cwd: string
  /**
   * Owning `Project.id`. Persisted onto every history entry so the index can
   * be scoped per-project + per-worktree (`(projectId, cwd)`, with a
   * projectId-only fallback when the exact cwd yields nothing). See ADR 0002.
   */
  projectId: string
  status: SessionStatus
  title: string | null
  /** True while a prompt turn is in flight (UI spinners, cancel). */
  activeTurn: boolean
  /** Project-scoped MCP attachments active for this session when known. */
  mcpServerCount?: number
  /**
   * Non-null while this session may still accept streamed chunks for the
   * current turn. Cleared on a deferred macrotask after completion so chunk
   * events that lose the IPC race against `acp_send_prompt` / `prompt_complete`
   * are not dropped.
   */
  openTurnId: string | null
  modes: SessionModeState | null
  models?: SessionModelState | null
  configOptions: SessionConfigOption[]
  lastError: string | null
  createdAt: number
  /**
   * Set while a `session/load` replay may still deliver history chunks.
   * 'pending' → load sent, no replayed chunk yet (the locally persisted
   * transcript stays visible); 'streaming' → the first replayed chunk replaced
   * the local transcript and later chunks append. Chunks for a session in
   * either state are accepted even while `status` is still 'closed' (the load
   * IPC is in flight). Cleared on a deferred macrotask after the load resolves
   * (see `scheduleReplayEnd`) so stragglers that lose the IPC race still land.
   * Absent/null means no replay is in flight.
   */
  replaying?: 'pending' | 'streaming' | null
  /**
   * Worktree path + branch the agent runs in (CAP-3). Additive: absent on
   * current-branch-mode sessions. When set, the chat indicator (CAP-6) shows
   * `{worktreeBranch} · New worktree` (the full worktree path stays on the
   * hover tooltip); relaunch reattaches to the stored path (no second
   * `git worktree add`). State isolation still keys on `cwd`.
   */
  worktreePath?: string
  worktreeBranch?: string
  /**
   * Correlation id into `useWorktreeProgressStore` for the in-timeline
   * worktree-creation progress card. Set on the launch placeholder before the
   * worktree create call and carried across the placeholder→real-session
   * merge so the card stays bound to this chat. Ephemeral — never persisted.
   */
  worktreeProgressId?: string
  /**
   * Origin marker for sessions opened via `openDiscoveredSession` (external
   * `session/list` chats). Carried on the live record so `persistSession`
   * preserves it even when no `sessionIndex` entry exists yet (the
   * disconnect/close path would otherwise default a discovered session to
   * `discovered: false` and leak it into the Termul-only Chats tab).
   * Absent/`false` for sessions Termul created via `createSession`.
   */
  discovered?: boolean
  /**
   * Agent config id recorded when a chat launch fails (`finalizeChatLaunch`
   * catch). Present only on failed-launch placeholder sessions; consumed by
   * `retryFailedLaunch` to re-run prepare against the same config. Cleared by
   * replacement: a successful retry swaps the placeholder for the real
   * session record, which never carries this field.
   */
  launchConfigId?: string
  /**
   * Launcher model/mode/config selections captured when a chat launch fails
   * (`finalizeChatLaunch` catch, same lifetime as `launchConfigId`). Consumed
   * by `retryFailedLaunch` so Retry re-applies the user's original selections
   * instead of launching with defaults. Cleared by replacement along with
   * `launchConfigId`: a successful retry swaps the placeholder for the real
   * session record, which never carries this field.
   */
  pendingLauncherOptions?: {
    modelId?: string
    modeId?: string
    configValues: Record<string, string>
  } | null
  /**
   * Option values the agent advertised at session creation — the `session/new`
   * result (recorded by `createSession`) or the `session_created` payload when
   * the event beat the local record. `_onModeUpdate` and
   * `mergeAgentConfigOptions` compare incoming snapshots against these: a
   * snapshot that merely re-asserts the creation default must not revert a
   * value the session has since moved off (while that value is still
   * advertised), but a genuinely new agent-side value still applies. Never
   * persisted; absent on sessions whose creation path exposes no options.
   */
  creationOptionDefaults?: {
    modeId?: string
    modelId?: string
    configValues: Record<string, string>
  }
  /**
   * Dedupe ledger for creation-default echo preservation: '__mode__' for
   * the native mode picker (namespaced so a `mode`-id config option can't
   * collide), otherwise the config option id — each key logs the
   * preserved-vs-echo warn once per session (repeated stale snapshots would
   * otherwise spam the log). Never persisted.
   */
  creationEchoLogged?: Record<string, true>
  /**
   * Story 3 (spec-in-chat-agent-switch): armed in-chat agent switch. Set by
   * `armAgentSwitch` (selection arms), cleared by `cancelAgentSwitch` or by
   * replacement (the switch executing / failing / the session closing). Same
   * additive lifetime pattern as `launchConfigId`: nothing else reads it
   * except the send interception (staged switch-on-send) and the switcher UI
   * (story 4). `status` is 'pending' while armed; the orchestration never
   * leaves it dangling — every exit path (success, rollback, busy-gate
   * rejection) clears it.
   */
  switching?: {
    toConfigId: string
    status: 'pending'
    /**
     * Composer option picks made while the switch is armed — the composer
     * binds to the TARGET config's advertised options (prepared session /
     * `agentOptionsCache`) while armed, and picks route through
     * `setSwitchPendingOption` instead of the old session's setters.
     * `switchAgent` applies them to the NEW session before the handoff
     * prompt dispatches; the field dies with `switching` on completion,
     * cancel, or rollback.
     */
    pendingOptions?: PendingLauncherOptions
  } | null
}

export interface PendingPermission {
  requestId: string
  agentId: AgentId
  sessionId: SessionId
  options: PermissionOption[]
  toolCall: unknown
}

/**
 * A permission the server denied because this device disconnected (L-09). The
 * server emits no event for it, so the store infers it: a request that was
 * pending at a transport loss and later left `pendingPermissions` without the
 * user answering. `tool` is the request's tool title for the notice copy.
 */
export interface PermissionDenialNotice {
  requestId: string
  tool: string
}

/** A pending structured question (issue #411), keyed by `questionId`. */
export interface PendingQuestion {
  questionId: string
  agentId: AgentId
  sessionId: SessionId
  question: string
  options: QuestionOption[]
}

export interface PendingElicitation {
  requestId: string
  agentId: AgentId
  sessionId: SessionId
  mode: string
  message: string
  url?: string
  fields: ElicitationField[]
  /**
   * GH-935: the agent permits a free-text "Other" answer per question field
   * (`_meta["cognition.ai/allowOther"]` on the elicitation request).
   */
  allowOther?: boolean
}

export interface GeneratedCommitMessage {
  summary: string
  description: string
}

export interface AcpState {
  // Agent registry
  agents: Record<
    AgentId,
    {
      id: AgentId
      capabilities: AgentCapabilities | null
      /**
       * Authentication methods the agent advertised at `initialize`, retained so
       * preparation can `authenticate` a single unambiguous method before
       * `session/new` and the launcher can offer a Sign-in action. Absent/empty
       * means the agent requires no authentication.
       */
      authMethods?: AuthMethod[]
      /**
       * Host-validated auth for a managed agent, if applicable. Residual
       * (finding 8, intentionally unfixed): this flag is the wire expression
       * of the registry `auth.mode: 'host-managed'` policy fact
       * (`acp-registry.ts`) — it stays a separate field because it crosses
       * the Rust spawn/spawned-event contract.
       */
      hostAuthReady?: boolean
    }
  >
  agentStatus: Record<AgentId, AgentStatus>
  /**
   * Headless ACP auth (spec-acp-terminal-auth): the URL an agent tried to
   * open via the host's browser-open shim, keyed by agentId. Set by the
   * `acp:browser_open_request` event; drives the BrowserAuthDialog in the
   * launcher. Cleared on auth success, agent kill, transport eviction, and
   * disconnect — a stale URL must never outlive the flow that produced it.
   */
  pendingBrowserOpen: Record<AgentId, string>
  /**
   * Agent browser automation consent prompts keyed by `requestId`
   * (`acp:browser_consent_request`). Once-per-session grant; the dialog
   * resolves each entry via `respondBrowserConsent`. Entries are host-side
   * deduped per session.
   */
  pendingBrowserConsents: Record<string, BrowserConsentRequestEvent>
  /**
   * Applied-update versions awaiting a user-facing chat (configId → applied
   * version). Set by `applyAgentUpdate`; cleared when a non-ephemeral chat
   * for that config is created. Spawn alone must not clear it — a failed
   * `createSession` after spawn would otherwise hide Restart.
   */
  pendingRestartVersions: Record<string, string>

  // User-configured agents (persisted, distinct from the live `agents` map)
  agentConfigs: StoredAgentConfig[]
  /**
   * Maps a per-project agent reuse key (`agentReuseKey(configId, cwd)`) to its
   * live spawned AgentId (for reuse). Keyed by config+cwd — not config alone —
   * so the same configured agent runs an independent process per project/cwd
   * and one process's disconnect can't cascade to another project's sessions.
   */
  configToLiveAgent: Record<string, AgentId>
  /** Reuse keys (`agentReuseKey`) whose background pre-warm spawn is in flight. */
  warmingConfigs: Record<string, true>
  /** Background `session/new` results keyed by prepare key (see `prepareChat`). */
  preparedSessions: Record<string, SessionId>
  /** Prepare keys with `session/new` currently in flight. */
  preparingChatKeys: Record<string, true>
  /** Last background prepare error keyed by prepare key (classified by cause). */
  prepareChatErrors: Record<string, PrepareChatError>
  /**
   * In-memory last-known models/modes/configOptions keyed by agent config id.
   * Invalidated only when cmd/args/env (identity) change — not on launcher close
   * or cwd-only navigation.
   */
  agentOptionsCache: Record<string, AgentOptionsCacheEntry>
  /** The agent the warm-session pool targets (drives refill-on-consume +
   * agent-switch drain). Null = no active pool (no refill, no drain). */
  selectedAgentConfigId: string | null

  // Persisted chat-history index (loaded on mount; payloads load lazily)
  sessionIndex: SessionIndexEntry[]

  /** Session ids whose `openHistorySession` is in flight (drives reconnect banners). */
  openingHistoryIds: Record<string, true>
  /**
   * Session ids whose newly focused chat tab should show the branded restore
   * preload. This clears once usable content is ready, independently of a
   * slower background reconnect.
   */
  restoringChatIds: Record<SessionId, true>
  /**
   * Placeholder session ids created for instant launcher→chat handoff while
   * `startChat` / first send still run in the background.
   */
  launchingSessionIds: Record<string, true>

  // Discovered (agent-native) sessions via `session/list` — ephemeral, not persisted.
  // Keyed by `discoveryKey(agentId, cwd)` so each (agent, cwd) pair owns its own
  // result slot; switching cwd never clobbers another cwd's results, and a slow
  // in-flight discovery for one cwd can't overwrite a newer cwd's results.
  discoveredSessions: Record<string, SessionInfo[]>
  /** discoveryKeys whose discovery is currently in flight (prevents duplicate requests). */
  discoveringKeys: Record<string, true>
  /** Ephemeral retry metadata for failed agent-native session reopens. */
  discoveredReopenContexts: Record<SessionId, DiscoveredReopenContext>

  // Global MCP server registry (persisted)
  mcpServers: StoredMcpServer[]
  // True once `loadMcpServers` has resolved at least once. Guards
  // `syncMcpRegistryToProjectFile` against syncing the initial empty state
  // (which would overwrite a project's `.termul/mcp-servers.json` with `[]`
  // before the app-store registry is loaded — CAP-7 race guard).
  mcpServersLoaded: boolean

  // MCP probe state — on-demand only (no persistent always-on connections).
  // `mcpProbeStatus` reflects Termul's own rmcp client connection, NOT the
  // agent's; the dot answers "can Termul reach this server and list its tools?".
  // `mcpTools` is the cached `tools/list` output; `mcpToolsLoaded` gates the
  // auto-probe on first expand; `mcpProbing` dedupes concurrent probes.
  mcpProbeStatus: Record<string, ProbeStatus>
  mcpTools: Record<string, McpToolInfo[]>
  mcpToolsLoaded: Record<string, boolean>
  mcpProbing: Record<string, boolean>
  /**
   * Last probe error per server (the backend's redacted `ProbeResult.error` —
   * already stripped of env/header values, tokens, and credentials). Set on
   * `status:'disconnected'`, cleared on `connected` and on the transport-throw
   * path (which synthesizes a disconnected status). Surfaced inline in Settings
   * and as the chatbox "Probe failed" tooltip so failures are diagnosable.
   */
  mcpProbeError: Record<string, string | undefined>
  /** Per-server OAuth connecting state (true while the browser OAuth flow is in progress). */
  mcpOAuthConnecting: Record<string, boolean>
  /** Per-server OAuth connected state (true when a stored token exists). */
  mcpOAuthConnected: Record<string, boolean>

  // Sessions
  sessions: Record<SessionId, AcpSession>
  activeSessionId: SessionId | null

  /** Agent-reported context window utilization keyed by session id. */
  sessionUsage: Record<SessionId, SessionUsage>

  // Per-session conversation state
  messages: Record<SessionId, ChatMessage[]>
  toolCalls: Record<SessionId, ToolCall[]>
  /**
   * CAP-2 (spec-in-chat-agent-switch): durable agent-switch markers per
   * session (mirror of `toolCalls`). Host-authored only — installed from
   * fetched payloads on reopen and appended by the watermark-guarded
   * `_onAgentSwitch` live handler.
   */
  agentSwitches: Record<SessionId, AgentSwitchRecord[]>
  /** ACP agent-plan entries per session (`session/update` plan, full replace). */
  plans: Record<SessionId, PlanEntry[]>
  commands: Record<SessionId, AvailableCommand[]>
  pendingPermissions: Record<string, PendingPermission> // P3 renders, keyed by requestId
  pendingQuestions: Record<string, PendingQuestion> // issue #411, keyed by questionId
  pendingElicitations: Record<string, PendingElicitation>
  /**
   * Per-session notice that a permission was denied by a disconnect (see
   * `PermissionDenialNotice`). Set by `attachPermissionDenialTracking`; cleared
   * when the session's next turn starts or the session goes away.
   */
  permissionDenialNotices: Record<SessionId, PermissionDenialNotice>
  /** Pending user prompts keyed by session (sent FIFO when the turn ends). */
  promptQueues: Record<SessionId, QueuedPrompt[]>
  /**
   * In-memory turn-close signal for system notifications. Not written to the
   * session index. `seq` increases each time the turn actually closes.
   */
  turnEndNotices: Record<SessionId, TurnEndNotice>
  /** Sessions whose auto-flush is suppressed during cancel+send-now. */
  suppressQueueFlush: Record<SessionId, true>

  /**
   * Story 5.3 (AC3): WS transport-level reconnect flag. True while the WS
   * transport is reconnecting (drop detected, backoff in flight). Drives the
   * non-blocking `AgentConnectionLamp` overlay in `AgentChatPanel`. Stays
   * `false` on Tauri desktop (no WS transport) and on the initial connect.
   * Distinct from the session-level `isClosed && isOpeningHistory` banner
   * (which fires when `openHistorySession` is in flight — both can show).
   */
  transportReconnecting: boolean
  /** Sessions recovered live-only after stale because no server snapshot exists. */
  degradedRecoverySessions: Record<SessionId, true>
  /** Target project waiting for the current turn to finish, if any. */
  queuedProjectSwitchId: string | null
  /** Target project whose switch just failed (transient inline indicator). */
  failedProjectSwitchId: string | null
  /**
   * Target project of a `switchProject` call that is awaiting the transport.
   * Null otherwise. The only store-visible signal for an in-flight switch;
   * the mobile shell announcer derives "Switching to {project}…" from it.
   */
  switchingProjectId: string | null

  // Actions — lifecycle
  spawnAgent: (config: Parameters<typeof acpApi.spawnAgent>[0]) => Promise<AgentId>
  killAgent: (agentId: AgentId) => Promise<void>
  /**
   * Headless ACP auth (spec-acp-terminal-auth): dismiss the BrowserAuthDialog
   * for an agent — drops its captured browser-open URL. The agent may re-emit
   * `browser_open_request` if it retries the open.
   */
  clearPendingBrowserOpen: (agentId: AgentId) => void
  /**
   * Headless ACP auth (spec-acp-terminal-auth): the user pasted back the
   * loopback redirect and the host's replay succeeded — the agent IS
   * authenticated now. Marks it so `createSession` skips its own
   * authenticate, drops the captured URL, and re-prepares any chats whose
   * prepare failed on auth so the banner clears without a manual Retry.
   */
  completeBrowserAuth: (agentId: AgentId) => void
  /**
   * Run the ACP `authenticate` method for an agent with an explicit method id
   * (from the advertised metadata) — used by the launcher's Sign-in action so a
   * subsequent prepare can create the session without re-authenticating. The id
   * is trimmed and must be non-empty and currently advertised (when the agent
   * advertises methods). Marks the agent authenticated on success so
   * `authenticateBeforeSession` skips its own authenticate step, and persists
   * the method id as this config's remembered sign-in for future processes.
   */
  authenticateAgent: (
    agentId: AgentId,
    methodId: string,
    gateway?: { baseUrl: string; apiKey?: string }
  ) => Promise<void>
  createSession: (
    agentId: AgentId,
    cwd: string,
    mcpServers: McpServer[] | undefined,
    projectId: string,
    opts?: {
      ephemeral?: boolean
      backendEphemeral?: boolean
      /**
       * Story 8: the backend-ephemeral session may be promoted to durable
       * later (`promote_session` on claim) — keeps the host plan-MCP
       * injection ephemeral one-shots would otherwise skip.
       */
      promotable?: boolean
      /** Worktree path + branch (CAP-3) — persisted onto the durable record. */
      worktreePath?: string
      worktreeBranch?: string
    }
  ) => Promise<SessionId>
  closeSession: (sessionId: SessionId) => Promise<void>
  setActiveSession: (sessionId: SessionId | null) => void
  switchProject: (projectId: string) => Promise<SwitchProjectReply>
  setFailedProjectSwitch: (projectId: string | null) => void

  // Actions — configured agents (P4)
  loadAgentConfigs: () => Promise<void>
  saveAgentConfig: (config: StoredAgentConfig) => Promise<void>
  /**
   * Update Application (see CONTEXT.md / ADR-0002): overwrite the
   * registry-derived fields of the persisted config for this config id with
   * data derived from the given registry agent. Persisted env values win on
   * conflict; the config identity is preserved. Returns 'applied', or
   * 'unchanged' when there is no persisted config (the next spawn derives
   * fresh from the registry anyway).
   */
  applyAgentUpdate: (configId: string, agent: RegistryAgent) => Promise<'applied' | 'unchanged'>
  deleteAgentConfig: (id: string) => Promise<void>
  testConnection: (config: AgentConfig) => Promise<AgentCapabilities | null>
  /**
   * Best-effort background spawn so a later `startChat` reuses a warm agent for
   * this config+cwd. Idempotent (dedupes against an in-flight or connected warm
   * for the same reuse key) and silent on failure — chat still lazy-spawns if
   * warm-up fails. No-op when `cwd` is empty.
   */
  prewarmAgent: (configId: string, cwd: string) => Promise<void>
  /** Use a fresh process on the next prepare without closing existing sessions. */
  detachAgentForNewCredentials: (configId: string, cwd: string) => void
  /**
   * Best-effort background `session/new` for a config+cwd (+ MCP selection) so
   * "Start Chat" can reuse a prepared session. Fire-and-forget from the UI;
   * dedupes in-flight work for the same key.
   */
  prepareChat: (
    configId: string,
    cwd: string,
    mcpServers: McpServer[] | undefined,
    projectId: string,
    opts?: { silent?: boolean }
  ) => void
  /** Drop any prepared session for this key (e.g. dialog closed or inputs changed). */
  cancelPreparedChat: (key: string) => void
  /** Spawn (or reuse a connected) agent for a config, create a session, return its id. */
  startChat: (
    configId: string,
    cwd: string,
    mcpServers: McpServer[] | undefined,
    projectId: string,
    opts?: { worktreePath?: string; worktreeBranch?: string }
  ) => Promise<SessionId>
  /**
   * Take ownership of a prepared session so launcher unmount cleanup cannot
   * reap it after the chat tab is already open. Promotes ephemeral pooled
   * sessions into persisted history.
   */
  claimPreparedChat: (key: string, projectId: string) => SessionId | null
  /**
   * Local-only initializing session so the chat tab can open before ACP
   * `session/new` finishes. Painted from options cache (+ pending overlays).
   */
  createLaunchPlaceholder: (args: {
    cwd: string
    projectId: string
    models?: SessionModelState | null
    modes?: SessionModeState | null
    configOptions?: SessionConfigOption[]
    /** Optimistic first-turn content so the chat looks like a normal send. */
    initialUserBlocks?: ContentBlock[]
    /** Worktree path + branch (CAP-3) — painted on the placeholder immediately. */
    worktreePath?: string
    worktreeBranch?: string
    /** Links the in-timeline worktree-creation progress card to this chat. */
    worktreeProgressId?: string
  }) => SessionId
  /** Drop a launch placeholder that will not be remapped (e.g. after fatal error). */
  discardLaunchPlaceholder: (sessionId: SessionId) => void
  /** Paint an optimistic user turn on an already-live session (prepared-path launch). */
  seedLaunchUserMessage: (sessionId: SessionId, blocks: ContentBlock[]) => void
  /** Clear the launching indicator once the first turn is handed off. */
  clearLaunchingSession: (sessionId: SessionId) => void
  /**
   * Complete an instant launch: `startChat`, apply pending options, send the
   * first turn, and tear down the placeholder when the real session id differs.
   * Throws `ChatLaunchCancelledError` when the chat was deleted from history
   * while `startChat` was in flight: the late session is closed + removed and
   * neither the merge nor the prompt send runs.
   */
  finalizeChatLaunch: (args: {
    placeholderId: SessionId
    configId: string
    cwd: string
    projectId: string
    mcpServers?: McpServer[]
    pending?: {
      modelId?: string
      modeId?: string
      configValues: Record<string, string>
    } | null
    initialText?: string | null
    initialBlocks?: ContentBlock[] | null
    /** Remap the workspace tab as soon as the real session exists (before send). */
    adoptSession?: (fromSessionId: SessionId, toSessionId: SessionId) => void
    /**
     * Worktree path + branch (CAP-3). When set, the durable record carries
     * them (CAP-4 relaunch + CAP-6 indicator) and `cwd` is the worktree path.
     */
    worktreePath?: string
    worktreeBranch?: string
  }) => Promise<SessionId>
  /** Apply launcher pending model/mode/config selections to a live session. */
  applyPendingLauncherOptions: (
    sessionId: SessionId,
    pending:
      | {
          modelId?: string
          modeId?: string
          configValues: Record<string, string>
        }
      | null
      | undefined
  ) => Promise<void>
  /** Set the agent the warm-session pool targets (reactive driver for retarget + refill gate). */
  setSelectedAgentConfigId: (configId: string | null) => void
  /** Drain stale pooled sessions for `cwd` (other agents) and seed `configId`'s pool. */
  retargetWarmPool: (configId: string, cwd: string, projectId: string) => void
  /** Generate a commit message in a hidden, non-persisted one-shot ACP session. */
  generateCommitMessage: (cwd: string, stagedDiff: string) => Promise<GeneratedCommitMessage>
  /** Inline terminal AI assist (#259): explain selected output or suggest a
   *  fix for it in a hidden, non-persisted one-shot ACP session. Returns the
   *  agent's markdown response; suggested commands are surfaced as fenced
   *  blocks the caller can offer for insertion (never executed). */
  assistTerminal: (
    kind: 'explain' | 'fix',
    cwd: string,
    selection: string,
    exitCode: number | null
  ) => Promise<string>

  // Actions — chat history (P5)
  loadSessionIndex: () => Promise<void>
  openHistorySession: (id: string) => Promise<void>
  /** R1: Proactively reattach a still-running ACP session on refresh. Mirrors
   * `openHistorySessionInner`'s transcript-install + resume but skips
   * `ensureLiveAgent` (no cold-spawn): the caller passes the authoritative
   * live `agentId` still owned by the Rust `AcpManager` across a webview/
   * phone reload. The backend `gate_resume_session` enforces the capability
   * (reused, not duplicated); a rejection rejects here so the hook can record
   * `acp-resume-skipped` and leave the transcript read-only. */
  resumeLiveSession: (id: string, agentId: AgentId, cwd: string) => Promise<void>
  /** R4: force-flush a non-debounced snapshot of every live session's cached
   * payload on refresh unload so the durable copy is at worst one turn behind
   * (never truncated by a live-window trim). Reuses `persistSession`'s guards
   * (skip mid-replay, strip `streaming:true`). Pair with `flushSessionHistory()`
   * to drain the queued writes. */
  flushLiveSessionSaves: () => void
  deleteHistorySession: (id: string) => Promise<void>
  /** Restart the agent for a crashed chat and replay the last user prompt.
   * User-initiated (Retry click) — honors ADR-003's no-silent-respawn (the crash
   * is still surfaced; respawn only happens on explicit user action). */
  retryCrashedSession: (sessionId: SessionId) => Promise<void>
  /** Re-run prepare for a failed chat launch (status 'error' +
   * `launchConfigId`) against the recorded agent config. On success the real
   * session replaces the placeholder and the tab remaps; on failure the
   * session lands back in 'error' with a re-surfaced actionable banner.
   * If the failed chat is deleted mid-retry, the cancellation tombstone
   * (`cancelledChatLaunches`) resolves this cleanly after tearing down the
   * late session — no ghost chat, no resurrected failure banner.
   * User-initiated (Retry click) — honors ADR-003's no-silent-respawn. */
  retryFailedLaunch: (sessionId: SessionId) => Promise<void>

  // Actions — live window (memory bounding + scroll-up lazy-load)
  /** Lazy-load older messages from the cached full payload on scroll-up. */
  loadOlderMessages: (sessionId: SessionId, count: number) => Promise<void>
  /** Drop the per-session backfill allowance (reader returned to the live edge). */
  clearSessionBackfill: (sessionId: SessionId) => void

  // Actions — session discovery (gh-407)
  /** Discover agent-native sessions via `session/list` for the given cwd. Best-effort, silent on failure. */
  discoverSessions: (agentId: AgentId, cwd: string) => Promise<void>
  /** Continue a discovered (non-mirror) session via load/resume, following the decideResume policy. */
  openDiscoveredSession: (
    agentId: AgentId,
    sessionId: SessionId,
    cwd: string,
    projectId: string
  ) => Promise<void>

  // Actions — MCP server registry (P6)
  loadMcpServers: () => Promise<void>
  saveMcpServer: (server: StoredMcpServer) => Promise<void>
  /**
   * Append multiple new registry entries atomically: one optimistic state
   * update, one disk write, rollback on failure. Used by the Settings JSON add
   * flow so a multi-server import persists as a single batch — no per-entry
   * writes, no partial prefix left behind to duplicate on retry.
   */
  importMcpServers: (servers: StoredMcpServer[]) => Promise<void>
  setMcpServerEnabled: (id: string, enabled: boolean) => Promise<void>
  deleteMcpServer: (id: string) => Promise<void>
  /**
   * OpenPencil canvas mode (CAP-2 / AD-5): upsert the project's persisted
   * http MCP entry pointing at the stable Termul-proxied canvas MCP
   * endpoint. Preserves the user's `enabled` flag, refreshes the URL (the
   * desktop agentation port is dynamic per boot). Serialized through the
   * registry mutation queue — canvas-store calls this action, never the
   * persistence key directly.
   *
   * `token` is the desktop managed token (the open response's
   * `canvasToken` — the agentation canvas MCP routes are gated behind it);
   * web ignores it in favor of the web-auth token, which server-side
   * agent clients present as the /canvas/mcp bearer.
   */
  upsertCanvasMcpServer: (projectId: string, url: string, token?: string) => Promise<void>
  /**
   * CAP-7: mirror the app-store MCP registry to the active project's
   * `.termul/mcp-servers.json` (best-effort, non-fatal). Called on a desktop
   * host-level project switch so the new project's file is synced with the
   * desktop's app-store registry before the web route reads it.
   */
  syncMcpRegistryToProjectFile: () => Promise<void>

  // Actions — MCP probe (on-demand, read-only). State slices above.
  /**
   * Probe a registered MCP server by id (Termul's own rmcp client — NOT the
   * agent's). Updates `mcpProbeStatus[id]` + `mcpTools[id]` +
   * `mcpToolsLoaded[id]=true`, and `mcpProbeError[id]` with the redacted
   * `ProbeResult.error` on a disconnected result (cleared on connected and on
   * the transport-throw path). Read-only — no persistence, no rollback.
   * Dedupes concurrent probes for the same id (`mcpProbing[id]`).
   */
  probeMcpServer: (id: string) => Promise<void>
  /**
   * Auto-probe on first expand of a server's tool list. No-op if already
   * loaded; otherwise delegates to `probeMcpServer(id)`.
   */
  loadMcpTools: (id: string) => Promise<void>
  /** Start the OAuth flow for an HTTP/SSE MCP server that returned `authRequired`.
   * Opens the system browser, waits for the callback, stores the token. */
  connectMcpOAuth: (id: string) => Promise<void>
  /** Check whether a stored OAuth token exists and update `mcpOAuthConnected`. */
  checkMcpOAuthStatus: (id: string) => Promise<void>
  /** Delete the stored OAuth token (the "Disconnect" action). */
  disconnectMcpOAuth: (id: string) => Promise<void>

  // Actions — conversation
  sendPrompt: (sessionId: SessionId, text: string) => Promise<void>
  /** Send a prompt turn carrying structured content blocks (text + image/resource).
   *
   * `blocks` is the wire payload dispatched to the agent. `options.displayBlocks`
   * (optional) overrides the optimistic user message's blocks so the timeline
   * can render inline skill chips (token text) while the agent receives the
   * path-based wire framing. When omitted, the wire blocks are also used for
   * the optimistic message (display == wire). */
  sendPromptBlocks: (
    sessionId: SessionId,
    blocks: ContentBlock[],
    options?: { skipUserAppend?: boolean; displayBlocks?: ContentBlock[] }
  ) => Promise<void>
  cancelPrompt: (sessionId: SessionId) => Promise<void>
  removeQueuedPrompt: (sessionId: SessionId, queueId: string) => void
  /** Cancel the active turn if needed, then send a queued prompt immediately. */
  sendQueuedPromptNow: (sessionId: SessionId, queueId: string) => Promise<void>
  /**
   * Story 3 (spec-in-chat-agent-switch): arm a staged switch-on-send for this
   * session — the NEXT send executes it (CAP-1/CAP-4 flow). Busy gate: when
   * the session has an active turn / queued prompts / pending permission or
   * question, the arm is rejected with `lastError` set on the session (banner
   * pattern; no spawn, no marker, draft intact) so no silent queue-jump can
   * occur. Resolves false when rejected.
   */
  armAgentSwitch: (sessionId: SessionId, toConfigId: string) => Promise<boolean>
  /** Clear an armed switch (picker closed / picked none). Send then behaves normally. */
  cancelAgentSwitch: (sessionId: SessionId) => void
  /**
   * Composer option pick made while `session.switching` is armed. Merges into
   * `switching.pendingOptions` (applied to the new session inside
   * `switchAgent` before the handoff prompt), persists under the TARGET
   * config, and live-applies to the target's prepared session when one exists
   * — the armed session's own options and its agent's wire are never touched.
   */
  setSwitchPendingOption: (
    sessionId: SessionId,
    patch: { modelId?: string; modeId?: string; configValues?: Record<string, string> }
  ) => Promise<void>
  /**
   * Execute the switch: busy gate → handoff summary → `ensureLiveAgent`
   * (to-config) → `createSession` → durable `acpRecordAgentSwitch` marker
   * (failure = warn + continue) → guarded tab remap → first handoff turn on
   * the NEW session → old-agent detach (kill only idle) → ordered-agent
   * index cache → `switching` cleared. On spawn/new-session failure the
   * ORIGINAL session stays live and usable (`lastError` banner; never
   * `status:'error'` on a live session). Throws only on unexpected internal
   * errors — failure classification lands in `lastError`.
   */
  switchAgent: (
    sessionId: SessionId,
    toConfigId: string,
    pending?: {
      pendingText?: string
      wireBlocks?: ContentBlock[]
      displayBlocks?: ContentBlock[]
    }
  ) => Promise<void>

  // Actions — config (P2 drives the UI; method available now)
  setConfigOption: (
    sessionId: SessionId,
    configId: string,
    valueId: string | boolean
  ) => Promise<void>
  setMode: (sessionId: SessionId, modeId: string) => Promise<void>
  setModel: (sessionId: SessionId, modelId: string) => Promise<void>

  // Actions — permission (P3 drives the UI; method available now)
  respondPermission: (requestId: string, optionId?: string) => Promise<void>

  // Actions — structured questions (issue #411)
  answerQuestion: (questionId: string, values?: string[]) => Promise<void>
  respondElicitation: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    // GH-935: `string[]` = multi-select (`multi-enum`) answers.
    content?: Record<string, string | number | boolean | string[]>
  ) => Promise<void>
  logoutAgent: (agentId: AgentId) => Promise<void>

  // Internal event reducers (exposed for tests)
  _onAgentSpawned: (e: AgentSpawnedEvent) => void
  _onSessionCreated: (e: SessionCreatedEvent) => void
  _onUserPrompt: (e: UserPromptEvent, eventSeq?: number) => void
  _onMessageChunk: (e: MessageChunkEvent, eventSeq?: number) => void
  _onToolCall: (e: ToolCallEvent, eventSeq?: number) => void
  _onToolCallUpdate: (e: ToolCallUpdateEvent, eventSeq?: number) => void
  /** CAP-2: live `acp:agent_switch` marker → append to `agentSwitches`. */
  _onAgentSwitch: (e: AgentSwitchEvent, eventSeq?: number) => void
  _onPlanUpdate: (e: PlanUpdateEvent) => void
  _onCommandsUpdate: (e: CommandsUpdateEvent) => void
  _onModeUpdate: (e: ModeUpdateEvent) => void
  _onConfigOptionsUpdate: (e: ConfigOptionsUpdateEvent) => void
  _onSessionInfoUpdate: (e: SessionInfoUpdateEvent) => void
  _onUsageUpdate: (e: UsageUpdateEvent) => void
  _onPermissionRequest: (e: PermissionRequestEvent, eventSeq?: number) => void
  _onQuestionRequest: (e: AskUserQuestionEvent, eventSeq?: number) => void
  _onElicitationRequest: (e: ElicitationRequestEvent, eventSeq?: number) => void
  _onPromptComplete: (e: PromptCompleteEvent, eventSeq?: number) => void
  _onAgentError: (e: AgentErrorEvent) => void
  /** Story 1.9 FR26: typed crash event → `status: 'error'` + manual restart. */
  _onAgentCrashed: (e: AgentCrashedEvent) => void
  _onAgentDisconnected: (e: AgentDisconnectedEvent) => void
  _onSessionClosed: (e: SessionClosedEvent) => void
  /**
   * Headless ACP auth (spec-acp-terminal-auth): record the URL an agent
   * tried to open so the launcher can show the BrowserAuthDialog.
   */
  _onBrowserOpenRequest: (e: BrowserOpenRequestEvent) => void
  /**
   * Agent browser automation (`browser` tool): host asks the renderer to
   * open/close a visible agent-controlled browser tab.
   */
  _onBrowserAgentTab: (e: BrowserAgentTabEvent) => void
  /**
   * `acp:browser_consent_request` — queue the once-per-session grant prompt.
   */
  _onBrowserConsentRequest: (e: BrowserConsentRequestEvent) => void
  respondBrowserConsent: (requestId: string, allowed: boolean) => void
}

export type TurnEndSetter = (
  partial: AcpState | Partial<AcpState> | ((state: AcpState) => AcpState | Partial<AcpState>),
  replace?: false
) => void

export type AcpSet = (fn: (s: AcpState) => Partial<AcpState> | AcpState) => void
export type AcpGet = () => AcpState

export type CommitMessageCollector = {
  agentId: AgentId
  chunks: string[]
  length: number
  completed: Promise<StopReason>
  complete: (reason: StopReason) => void
  reject: (error: Error) => void
}

export interface DiscoveredReopenContext {
  agentId: AgentId
  cwd: string
  projectId: string
}

/**
 * Thrown by `finalizeChatLaunch` when the launch's cancellation tombstone is
 * present (see `cancelledChatLaunches`). A distinct type so callers
 * (`retryFailedLaunch`, the launcher) can tell "the user deleted the chat
 * mid-launch" apart from a real launch failure and skip failure stamping.
 */
export class ChatLaunchCancelledError extends Error {
  constructor(placeholderId: SessionId) {
    super(
      `chat launch cancelled: the chat was deleted while the launch was in flight (${placeholderId})`
    )
    this.name = 'ChatLaunchCancelledError'
  }
}

/**
 * Body of `openHistorySession` (deduped by the store action via
 * `inFlightHistoryOpens`): load the persisted payload, remap to the current
 * live agent for the chat's config+cwd, decide the reopen strategy, register
 * the session with its local transcript, and run load/resume when the
 * capability allows.
 *
 * 'load' semantics: the locally persisted transcript stays visible while
 * `session/load` is in flight; the session is marked `replaying: 'pending'`
 * so `_onMessageChunk` accepts the agent's replayed history (the session is
 * still 'closed' until load resolves). The FIRST replayed chunk replaces the
 * local transcript (avoids duplication); an agent that replays nothing leaves
 * the local transcript in place.
 */
export type ReopenControlBaseline = Pick<AcpSession, 'modes' | 'models' | 'configOptions'>

export interface AgentIdentity {
  /** Human-friendly agent name (e.g. "Cursor"), or null when unresolved. */
  name: string | null
  /** Template id used to resolve the agent icon, when known. */
  templateId: string | null
  /** Persisted custom icon SVG (bundled or uploaded), when present. */
  icon: string | null
}

/** Aggregate warm state for a config across all of its per-project processes. */
export interface ConfigWarmState {
  /** A live process for this config is connected (in any project/cwd). */
  connected: boolean
  /** A background warm spawn for this config is in flight (any cwd). */
  warming: boolean
  /** A warm `session/new` for this config is ready (pooled, any cwd). */
  sessionReady: boolean
  /** A warm `session/new` for this config is in flight (any cwd). */
  warmingSession: boolean
}
