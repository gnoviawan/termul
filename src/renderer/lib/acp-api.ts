/**
 * ACP (Agent Client Protocol) renderer facade.
 *
 * This is the ONLY module in the renderer that talks to the P0 ACP backend
 * (Tauri commands `acp_*` / events `acp:*`, or the web WS relay). Components
 * and the acp-store go through here.
 *
 * Transport selection (Story 1.6): `getAcpTransport()` picks Tauri IPC when
 * `isTauriContext()` is true, otherwise the multiplexed WS client. Public
 * method names and TypeScript signatures are unchanged.
 *
 * IMPORTANT: ACP commands surface failures by throwing (Tauri `Result` Err
 * string, or `AcpTransportError` from WS `{ok:false,err}`). Callers (the store)
 * normalize it (toast, etc.).
 */

import { getAcpTransport } from '@/lib/acp-transport'
import type { AcpRuntimeAvailability } from '@/lib/agents/supported-acp-agents'

// --- Identifiers -----------------------------------------------------------

// AgentId/SessionId are bare strings on the wire (newtype tuple structs).
export type AgentId = string
export type SessionId = string

// --- ACP schema mirrors (only the fields the UI needs) ---------------------

/**
 * Tagged content block. Only `text` is fully handled in P1; other block types
 * (image/audio/resource/resource_link/…) carry their protocol fields in the
 * index signature and render as a placeholder.
 */
export interface ContentBlock {
  type: string
  text?: string
  [k: string]: unknown
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | string

export interface SessionMode {
  id: string
  name: string
  description?: string | null
}

export interface SessionModeState {
  currentModeId: string
  availableModes: SessionMode[]
}

export interface SessionModel {
  modelId: string
  name: string
  description?: string | null
}

export interface SessionModelState {
  currentModelId: string
  availableModels: SessionModel[]
}

export interface SessionConfigOptionValue {
  value: string
  name: string
  description?: string | null
}

export interface SessionConfigOption {
  id: string
  name: string
  description?: string | null
  category?: string | null
  type: string
  currentValue: string
  options: SessionConfigOptionValue[]
}

/** Option snapshot returned by ACP session/load and session/resume. */
export interface SessionReopenOutcome {
  modes?: SessionModeState
  models?: SessionModelState
  configOptions?: SessionConfigOption[]
}

export interface AgentCapabilities {
  loadSession?: boolean
  sessionCapabilities?: { resume?: unknown; close?: unknown; list?: unknown } | null
  mcpCapabilities?: { http?: boolean; sse?: boolean; acp?: boolean } | null
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean } | null
  [k: string]: unknown
}

/** A tool call (P3 renders these). ACP schema, camelCase on the wire. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'
  | string

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | string

export interface DiffContent {
  path: string
  oldText?: string | null
  newText: string
}

/** Tagged tool-call content item. */
export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId?: string }
  | { type: string; [k: string]: unknown }

export interface ToolCall {
  toolCallId: string
  title?: string
  kind?: ToolKind
  status?: ToolCallStatus
  content?: ToolCallContent[]
  rawInput?: unknown
  rawOutput?: unknown
  /** Client-side arrival time (stamped in the store for timeline ordering). */
  timestamp?: number
  /** Monotonic arrival sequence (stamped in the store) for timeline ordering. */
  seq?: number
  [k: string]: unknown
}

export interface ToolCallUpdate {
  toolCallId: string
  title?: string
  kind?: ToolKind
  status?: ToolCallStatus
  content?: ToolCallContent[]
  rawInput?: unknown
  rawOutput?: unknown
  [k: string]: unknown
}

export type PlanEntryPriority = 'high' | 'medium' | 'low' | string
export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed' | string

export interface PlanEntry {
  content: string
  priority?: PlanEntryPriority
  status?: PlanEntryStatus
  [k: string]: unknown
}

export interface Plan {
  entries: PlanEntry[]
  [k: string]: unknown
}

export interface AvailableCommand {
  name: string
  description?: string | null
  input?: { hint?: string | null } | null
  [k: string]: unknown
}

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always'
  | string

export interface PermissionOption {
  optionId: string
  name: string
  kind?: PermissionOptionKind
  [k: string]: unknown
}

/** MCP server config passed through to `session/new`. */
export interface McpEnvVar {
  name: string
  value: string
}
export interface McpHeader {
  name: string
  value: string
}
export interface McpStdioServer {
  type?: 'stdio'
  name: string
  command: string
  args?: string[]
  env?: McpEnvVar[]
}
export interface McpHttpServer {
  type: 'http'
  name: string
  url: string
  headers?: McpHeader[]
}
export interface McpSseServer {
  type: 'sse'
  name: string
  url: string
  headers?: McpHeader[]
}
export type McpServerConfig = McpStdioServer | McpHttpServer | McpSseServer

// --- MCP client probe (on-demand `initialize` + `tools/list`) -------------

/** Per-server probe status (Termul's own client connection, not the agent's). */
export type ProbeStatus = 'connected' | 'disconnected'

/** A tool exposed by a probed MCP server (`tools/list` output, UI subset). */
export interface McpToolInfo {
  name: string
  description?: string
}

/** Probe result. On `disconnected`, `error` is a short, value-free message. */
export interface ProbeResult {
  status: ProbeStatus
  tools: McpToolInfo[]
  error?: string
}
/** Wire type forwarded verbatim to the backend `acp_new_session` command. */
export type McpServer = McpServerConfig

export interface AgentConfig {
  /** Stable configured-agent identity used for standalone durable history matching. */
  configId?: string
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  /** Whether this agent may use the ACP terminal capability (default false). */
  allowTerminal?: boolean
}

export interface NewSessionOutcome {
  sessionId: SessionId
  modes?: SessionModeState | null
  models?: SessionModelState | null
  configOptions?: SessionConfigOption[] | null
}

/** A session discovered via `session/list` (agent-native session). */
export interface SessionInfo {
  sessionId: SessionId
  cwd: string
  title?: string | null
  updatedAt?: string | null
  [k: string]: unknown
}

export interface ListSessionsResponse {
  sessions: SessionInfo[]
  nextCursor?: string | null
  [k: string]: unknown
}

// --- Event payloads --------------------------------------------------------

export type ChunkRole = 'user' | 'agent' | 'thought'

/**
 * An authentication method advertised by an agent at `initialize`, propagated
 * verbatim from the backend as an opaque descriptor. `id` is the method id
 * passed to `authenticate`; `name` is the human-readable label used for the
 * Sign-in action; `description` is the protocol's optional guidance surface.
 */
export interface AuthMethod {
  id: string
  name: string
  description?: string | null
}

export interface AgentSpawnedEvent {
  agentId: AgentId
  capabilities: AgentCapabilities
  /**
   * Every authentication method the agent advertised at `initialize`. Empty
   * (or absent, treated as empty) means the agent requires no authentication.
   */
  authMethods?: AuthMethod[]
}

/**
 * Authoritative spawn result returned by `acp_spawn_agent` (Tauri) and
 * `spawn_agent` (WS) — the single contract for both transports (CAP-4: the
 * spawn response — not the async `acp:agent_spawned` event — is the source of
 * truth). The renderer populates `capabilities` + `authMethods` synchronously
 * from this response, eliminating the former 250ms no-auth fallback.
 */
export interface SpawnAgentResult {
  agentId: AgentId
  capabilities: AgentCapabilities
  /** Always present (as `[]` for a no-auth agent) so the renderer sees a stable field. */
  authMethods: AuthMethod[]
  stableNamespace?: string
}
export interface SessionCreatedEvent {
  agentId: AgentId
  sessionId: SessionId
  modes?: SessionModeState | null
  models?: SessionModelState | null
  configOptions?: SessionConfigOption[] | null
}
export interface UserPromptEvent {
  agentId: AgentId
  sessionId: SessionId
  turnId?: string
  content: ContentBlock[]
}

export interface MessageChunkEvent {
  agentId: AgentId
  sessionId: SessionId
  role: ChunkRole
  content: ContentBlock
}
export interface ToolCallEvent {
  agentId: AgentId
  sessionId: SessionId
  toolCall: ToolCall
}
export interface ToolCallUpdateEvent {
  agentId: AgentId
  sessionId: SessionId
  update: ToolCallUpdate
}
export interface PlanUpdateEvent {
  agentId: AgentId
  sessionId: SessionId
  plan: Plan
}
export interface CommandsUpdateEvent {
  agentId: AgentId
  sessionId: SessionId
  availableCommands: AvailableCommand[]
}
export interface ModeUpdateEvent {
  agentId: AgentId
  sessionId: SessionId
  currentModeId: string
  availableModes?: SessionMode[]
}
export interface ConfigOptionsUpdateEvent {
  agentId: AgentId
  sessionId: SessionId
  configOptions: SessionConfigOption[]
}
export interface PermissionRequestEvent {
  agentId: AgentId
  sessionId: SessionId
  requestId: string
  toolCall: ToolCallUpdate
  options: PermissionOption[]
}

/** One selectable option of an `AskUserQuestionEvent` (issue #411). */
export interface QuestionOption {
  /** Opaque id the agent consumes (stable, single-use). */
  value: string
  /** Human-readable option text. */
  label: string
  /** Optional context shown under the label. */
  description?: string
  /** `single` (default) or `multi`. */
  cardinality?: string
}

/**
 * `acp:question_request` payload (issue #411) — a structured question from an
 * agent. `questionId` is a stable correlation id generated server-side; the
 * user's answer routes back through it exactly once via `answerQuestion`.
 */
export interface AskUserQuestionEvent {
  agentId: AgentId
  sessionId: SessionId
  questionId: string
  question: string
  options: QuestionOption[]
}
export interface PromptCompleteEvent {
  agentId: AgentId
  sessionId: SessionId
  stopReason: StopReason
  /** Story 1.8 T3.2 (FR11): client turn-id echoed back so `seenTurnIds` dedup
   * fires (no duplicate completion on reconnect replay). Absent for desktop /
   * older clients (dedup is a no-op). */
  turnId?: string
}
export interface AgentErrorEvent {
  agentId: AgentId
  sessionId?: SessionId | null
  message: string
}
/** Story 1.9 FR26: the agent subprocess crashed mid-turn (a typed event
 * distinct from `agent_error` (non-fatal) + `agent_disconnected` (always)).
 * `acp-store` sets `status: 'error'` + the UI shows a manual-restart action. */
export interface AgentCrashedEvent {
  agentId: AgentId
  sessionId?: SessionId | null
  message: string
}
export interface AgentDisconnectedEvent {
  agentId: AgentId
}
export interface SessionClosedEvent {
  agentId: AgentId
  sessionId: SessionId
}
export interface SessionInfoUpdateEvent {
  agentId: AgentId
  sessionId: SessionId
  /** Agent-provided title; `null` when explicitly cleared, `undefined` when absent. */
  title?: string | null
}

export interface UsageCost {
  amount: number
  currency: string
}

export interface UsageUpdateEvent {
  agentId: AgentId
  sessionId: SessionId
  used: number
  size: number
  cost?: UsageCost | null
}

/** Agent-reported context window state for a session. */
export interface SessionUsage {
  used: number
  size: number
  /** First `used` snapshot for this session — static agent bootstrap prefix. */
  baselineUsed: number
  cost?: UsageCost
  updatedAt: number
  source: 'reported'
}

export const ACP_EVENTS = {
  agentSpawned: 'acp:agent_spawned',
  sessionCreated: 'acp:session_created',
  userPrompt: 'acp:user_prompt',
  messageChunk: 'acp:message_chunk',
  toolCall: 'acp:tool_call',
  toolCallUpdate: 'acp:tool_call_update',
  planUpdate: 'acp:plan_update',
  commandsUpdate: 'acp:commands_update',
  modeUpdate: 'acp:mode_update',
  configOptionsUpdate: 'acp:config_options_update',
  permissionRequest: 'acp:permission_request',
  questionRequest: 'acp:question_request',
  promptComplete: 'acp:prompt_complete',
  agentError: 'acp:agent_error',
  agentCrashed: 'acp:agent_crashed',
  agentDisconnected: 'acp:agent_disconnected',
  sessionClosed: 'acp:session_closed',
  sessionInfoUpdate: 'acp:session_info_update',
  usageUpdate: 'acp:usage_update'
} as const

// --- Command wrappers ------------------------------------------------------

export interface InstallAcpRegistryBinaryRequest {
  agentId: string
  archiveUrl: string
  cmd: string
  args?: string[]
}

export interface InstallAcpRegistryBinaryOutcome {
  command: string
  args: string[]
}

export async function acpInstallRegistryBinary(
  request: InstallAcpRegistryBinaryRequest
): Promise<InstallAcpRegistryBinaryOutcome> {
  return getAcpTransport().installRegistryBinary(request)
}

/**
 * CAP-6 / Story 9: host-owned verified-atomic install. The request is
 * `{ agentId }` only; the host resolves everything (archive URL, cmd, args,
 * sha256) from the trusted catalog. The outcome `{ command, args }` flows
 * through `installedBinaryConfig` → `saveAgentConfig` unchanged. Mirrors the
 * `acp_install_agent` Tauri command + `POST /acp/install` + WS
 * `install_acp_agent` byte-for-byte.
 */
export async function acpInstallAcpAgent(
  agentId: string
): Promise<InstallAcpRegistryBinaryOutcome> {
  return getAcpTransport().installAcpAgent(agentId)
}

export async function acpProbeRuntime(): Promise<AcpRuntimeAvailability> {
  return getAcpTransport().probeRuntime()
}

/**
 * On-demand MCP client probe. Opens a fresh rmcp client connection to the
 * configured server, calls `initialize` + `tools/list`, then closes. Returns
 * the connected/disconnected status + tool list. Stateless — the renderer
 * supplies the full `McpServerConfig` (no registry-store coupling). Never
 * logs env/header values, tokens, or credentials. Desktop↔web parity: the
 * probe runs on the termul-server host via `POST /mcp-servers/probe` on web.
 *
 * Delegates to the canonical `acp-mcp-probe.ts` facade so the transport-facade
 * (`acpApi`) and the standalone facade share ONE contract: never throws on a
 * probe failure — returns a disconnected `ProbeResult` instead.
 */
export async function probeMcpServer(server: McpServerConfig): Promise<ProbeResult> {
  // Lazy import avoids a static cycle (acp-api ↔ acp-mcp-probe) at module load;
  // the canonical facade owns the `isTauriContext()` branching + normalization.
  const { probeMcpServer: canonicalProbe } = await import('@/lib/acp-mcp-probe')
  return canonicalProbe(server)
}

/** Thin wrapper: probe + return just the tool list (auto-probe on expand). */
export async function listMcpTools(server: McpServerConfig): Promise<McpToolInfo[]> {
  const { listMcpTools: canonicalList } = await import('@/lib/acp-mcp-probe')
  return canonicalList(server)
}

export interface AcpRegistrySnapshot {
  agents: unknown
  source: string
  fetchedAt?: string | null
}

export async function acpFetchRegistrySnapshot(forceRefresh = false): Promise<AcpRegistrySnapshot> {
  return getAcpTransport().fetchRegistrySnapshot(forceRefresh)
}

export async function acpSpawnAgent(config: AgentConfig): Promise<SpawnAgentResult> {
  return getAcpTransport().spawnAgent(config)
}

export async function acpKillAgent(agentId: AgentId): Promise<void> {
  await getAcpTransport().killAgent(agentId)
}

export async function acpListAgents(): Promise<AgentId[]> {
  return getAcpTransport().listAgents()
}

export async function acpNewSession(
  agentId: AgentId,
  cwd: string,
  mcpServers?: McpServer[],
  options?: {
    ephemeral?: boolean
    projectId?: string
    /** Worktree path + branch (CAP-3) — persisted for the indicator + fallback. */
    worktreePath?: string
    worktreeBranch?: string
  }
): Promise<NewSessionOutcome> {
  return getAcpTransport().newSession(agentId, cwd, mcpServers, options)
}

export async function acpLoadSession(
  agentId: AgentId,
  sessionId: SessionId,
  cwd: string
): Promise<SessionReopenOutcome> {
  return getAcpTransport().loadSession(agentId, sessionId, cwd)
}

export async function acpResumeSession(
  agentId: AgentId,
  sessionId: SessionId,
  cwd: string
): Promise<SessionReopenOutcome> {
  return getAcpTransport().resumeSession(agentId, sessionId, cwd)
}

export async function acpCloseSession(agentId: AgentId, sessionId: SessionId): Promise<void> {
  await getAcpTransport().closeSession(agentId, sessionId)
}

export async function acpDisposeEphemeralSession(
  agentId: AgentId,
  sessionId: SessionId
): Promise<void> {
  await getAcpTransport().disposeEphemeralSession(agentId, sessionId)
}

export async function acpListSessions(
  agentId: AgentId,
  cwd?: string,
  cursor?: string
): Promise<ListSessionsResponse> {
  return getAcpTransport().listSessions(agentId, cwd, cursor)
}

export async function acpSendPrompt(
  agentId: AgentId,
  sessionId: SessionId,
  text: string,
  turnId?: string
): Promise<StopReason> {
  return getAcpTransport().sendPrompt(agentId, sessionId, text, turnId)
}

export async function acpSendPromptBlocks(
  agentId: AgentId,
  sessionId: SessionId,
  content: ContentBlock[],
  turnId?: string
): Promise<StopReason> {
  return getAcpTransport().sendPromptBlocks(agentId, sessionId, content, turnId)
}

export async function acpCancelPrompt(agentId: AgentId, sessionId: SessionId): Promise<void> {
  await getAcpTransport().cancelPrompt(agentId, sessionId)
}

export async function acpSetConfigOption(
  agentId: AgentId,
  sessionId: SessionId,
  configId: string,
  valueId: string
): Promise<SessionConfigOption[]> {
  return getAcpTransport().setConfigOption(agentId, sessionId, configId, valueId)
}

export async function acpSetMode(
  agentId: AgentId,
  sessionId: SessionId,
  modeId: string
): Promise<void> {
  await getAcpTransport().setMode(agentId, sessionId, modeId)
}

export async function acpSetModel(
  agentId: AgentId,
  sessionId: SessionId,
  modelId: string
): Promise<void> {
  await getAcpTransport().setModel(agentId, sessionId, modelId)
}

export async function acpRespondPermission(
  agentId: AgentId,
  requestId: string,
  optionId?: string
): Promise<void> {
  await getAcpTransport().respondPermission(agentId, requestId, optionId)
}

/**
 * Answer a structured question (issue #411). `values == null`/empty cancels;
 * otherwise submits the selected option values exactly once.
 */
export async function acpAnswerQuestion(
  agentId: AgentId,
  questionId: string,
  values?: string[]
): Promise<void> {
  await getAcpTransport().answerQuestion(agentId, questionId, values)
}

export async function acpAuthenticate(agentId: AgentId, methodId: string): Promise<void> {
  await getAcpTransport().authenticate(agentId, methodId)
}

// Push the ACP turn (hard-cap) timeout override to the backend, in seconds,
// or `null` to clear (fall back to the env var / default). Desktop-only: the
// WS transport no-ops on the standalone server.
export async function acpSetTurnTimeout(secs: number | null): Promise<void> {
  await getAcpTransport().setTurnTimeout(secs)
}

// Push the ACP turn idle-timeout override to the backend, in seconds, or
// `null` to clear (fall back to the env var / default). Desktop-only: the WS
// transport no-ops on the standalone server.
export async function acpSetTurnIdleTimeout(secs: number | null): Promise<void> {
  await getAcpTransport().setTurnIdleTimeout(secs)
}

// Push the ACP session/new timeout override to the backend, in seconds, or
// `null` to clear (fall back to the env var / default). Desktop-only: the WS
// transport no-ops on the standalone server.
export async function acpSetSessionNewTimeout(secs: number | null): Promise<void> {
  await getAcpTransport().setSessionNewTimeout(secs)
}

// Push the ACP session reopen (load/resume) timeout override to the backend,
// in seconds, or `null` to clear (fall back to the env var / default).
// Desktop-only: the WS transport no-ops on the standalone server.
export async function acpSetSessionReopenTimeout(secs: number | null): Promise<void> {
  await getAcpTransport().setSessionReopenTimeout(secs)
}

// Push the ACP first-prompt warmup timeout override to the backend, in
// seconds, or `null` to clear (fall back to the env var / default); 0 disables
// the warmup entirely. Desktop-only: the WS transport no-ops on the standalone
// server.
export async function acpSetFirstPromptWarmupTimeout(secs: number | null): Promise<void> {
  await getAcpTransport().setFirstPromptWarmupTimeout(secs)
}

// --- Event subscription ----------------------------------------------------

/**
 * Subscribe to a backend event. Transport-agnostic: Tauri `listen` on desktop,
 * WS event fan-in on web (Story 1.6).
 */
export function onAcpEvent<T>(eventName: string, callback: (payload: T) => void): () => void {
  return getAcpTransport().onEvent(eventName, callback)
}

export const acpApi = {
  spawnAgent: acpSpawnAgent,
  killAgent: acpKillAgent,
  listAgents: acpListAgents,
  newSession: acpNewSession,
  loadSession: acpLoadSession,
  resumeSession: acpResumeSession,
  closeSession: acpCloseSession,
  disposeEphemeralSession: acpDisposeEphemeralSession,
  listSessions: acpListSessions,
  sendPrompt: acpSendPrompt,
  sendPromptBlocks: acpSendPromptBlocks,
  cancelPrompt: acpCancelPrompt,
  setConfigOption: acpSetConfigOption,
  setMode: acpSetMode,
  setModel: acpSetModel,
  respondPermission: acpRespondPermission,
  answerQuestion: acpAnswerQuestion,
  authenticate: acpAuthenticate,
  setTurnTimeout: acpSetTurnTimeout,
  setTurnIdleTimeout: acpSetTurnIdleTimeout,
  setSessionNewTimeout: acpSetSessionNewTimeout,
  setSessionReopenTimeout: acpSetSessionReopenTimeout,
  setFirstPromptWarmupTimeout: acpSetFirstPromptWarmupTimeout,
  installRegistryBinary: acpInstallRegistryBinary,
  installAcpAgent: acpInstallAcpAgent,
  probeRuntime: acpProbeRuntime,
  probeMcpServer,
  listMcpTools,
  fetchRegistrySnapshot: acpFetchRegistrySnapshot,
  onEvent: onAcpEvent
}
