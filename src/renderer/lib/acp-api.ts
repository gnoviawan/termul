/**
 * ACP (Agent Client Protocol) renderer facade.
 *
 * This is the ONLY module in the renderer that talks to the P0 ACP backend
 * (Tauri commands `acp_*` and events `acp:*`). Components and the acp-store go
 * through here.
 *
 * IMPORTANT: the ACP Tauri commands return a raw `Result<T, String>` — on the
 * JS side `invoke()` RESOLVES with `T` or REJECTS (throws) with the error
 * string. This is unlike the browser/terminal APIs which return an
 * `IpcResult<T>` envelope. The wrappers below surface the thrown error as-is;
 * callers (the store) normalize it (toast, etc.).
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

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

export interface AgentCapabilities {
  loadSession?: boolean
  sessionCapabilities?: { resume?: unknown; close?: unknown } | null
  mcpCapabilities?: { http?: boolean; sse?: boolean } | null
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
/** Wire type forwarded verbatim to the backend `acp_new_session` command. */
export type McpServer = McpServerConfig

export interface AgentConfig {
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
  configOptions?: SessionConfigOption[] | null
}

export interface ListSessionsResponse {
  [k: string]: unknown
}

// --- Event payloads --------------------------------------------------------

export type ChunkRole = 'user' | 'agent' | 'thought'

export interface AgentSpawnedEvent {
  agentId: AgentId
  capabilities: AgentCapabilities
}
export interface SessionCreatedEvent {
  agentId: AgentId
  sessionId: SessionId
  modes?: SessionModeState | null
  configOptions?: SessionConfigOption[] | null
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
export interface PromptCompleteEvent {
  agentId: AgentId
  sessionId: SessionId
  stopReason: StopReason
}
export interface AgentErrorEvent {
  agentId: AgentId
  sessionId?: SessionId | null
  message: string
}
export interface AgentDisconnectedEvent {
  agentId: AgentId
}
export interface AuthMethodInfo {
  id: string
  name: string
  description?: string
}
export interface AuthRequiredEvent {
  agentId: AgentId
  methods: AuthMethodInfo[]
  message?: string
}
export interface SessionClosedEvent {
  agentId: AgentId
  sessionId: SessionId
}

export const ACP_EVENTS = {
  agentSpawned: 'acp:agent_spawned',
  sessionCreated: 'acp:session_created',
  messageChunk: 'acp:message_chunk',
  toolCall: 'acp:tool_call',
  toolCallUpdate: 'acp:tool_call_update',
  planUpdate: 'acp:plan_update',
  commandsUpdate: 'acp:commands_update',
  modeUpdate: 'acp:mode_update',
  configOptionsUpdate: 'acp:config_options_update',
  permissionRequest: 'acp:permission_request',
  promptComplete: 'acp:prompt_complete',
  agentError: 'acp:agent_error',
  agentDisconnected: 'acp:agent_disconnected',
  authRequired: 'acp:auth_required',
  sessionClosed: 'acp:session_closed'
} as const

// --- Command wrappers ------------------------------------------------------

export async function acpSpawnAgent(config: AgentConfig): Promise<AgentId> {
  return invoke<AgentId>('acp_spawn_agent', { config })
}

export async function acpKillAgent(agentId: AgentId): Promise<void> {
  await invoke('acp_kill_agent', { agentId })
}

export async function acpListAgents(): Promise<AgentId[]> {
  return invoke<AgentId[]>('acp_list_agents')
}

export async function acpNewSession(
  agentId: AgentId,
  cwd: string,
  mcpServers?: McpServer[]
): Promise<NewSessionOutcome> {
  return invoke<NewSessionOutcome>('acp_new_session', { agentId, cwd, mcpServers })
}

export async function acpLoadSession(
  agentId: AgentId,
  sessionId: SessionId,
  cwd: string
): Promise<void> {
  await invoke('acp_load_session', { agentId, sessionId, cwd })
}

export async function acpResumeSession(
  agentId: AgentId,
  sessionId: SessionId,
  cwd: string
): Promise<void> {
  await invoke('acp_resume_session', { agentId, sessionId, cwd })
}

export async function acpCloseSession(agentId: AgentId, sessionId: SessionId): Promise<void> {
  await invoke('acp_close_session', { agentId, sessionId })
}

export async function acpListSessions(agentId: AgentId): Promise<ListSessionsResponse> {
  return invoke<ListSessionsResponse>('acp_list_sessions', { agentId })
}

export async function acpSendPrompt(
  agentId: AgentId,
  sessionId: SessionId,
  text: string
): Promise<StopReason> {
  return invoke<StopReason>('acp_send_prompt', { agentId, sessionId, text })
}

export async function acpSendPromptBlocks(
  agentId: AgentId,
  sessionId: SessionId,
  content: ContentBlock[]
): Promise<StopReason> {
  return invoke<StopReason>('acp_send_prompt', { agentId, sessionId, content })
}

export async function acpCancelPrompt(agentId: AgentId, sessionId: SessionId): Promise<void> {
  await invoke('acp_cancel_prompt', { agentId, sessionId })
}

export async function acpSetConfigOption(
  agentId: AgentId,
  sessionId: SessionId,
  configId: string,
  valueId: string
): Promise<SessionConfigOption[]> {
  return invoke<SessionConfigOption[]>('acp_set_config_option', {
    agentId,
    sessionId,
    configId,
    valueId
  })
}

export async function acpSetMode(
  agentId: AgentId,
  sessionId: SessionId,
  modeId: string
): Promise<void> {
  await invoke('acp_set_mode', { agentId, sessionId, modeId })
}

export async function acpRespondPermission(
  agentId: AgentId,
  requestId: string,
  optionId?: string
): Promise<void> {
  await invoke('acp_respond_permission', { agentId, requestId, optionId })
}

export async function acpAuthenticate(agentId: AgentId, methodId: string): Promise<void> {
  await invoke('acp_authenticate', { agentId, methodId })
}

// --- Event subscription ----------------------------------------------------

/**
 * Subscribe to a backend event with an early-unlisten guard (mirrors
 * `browser-api.ts`). The returned function detaches the listener; if it is
 * called before `listen()` resolves, the listener is torn down as soon as it
 * resolves.
 */
export function onAcpEvent<T>(eventName: string, callback: (payload: T) => void): () => void {
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
}

export const acpApi = {
  spawnAgent: acpSpawnAgent,
  killAgent: acpKillAgent,
  listAgents: acpListAgents,
  newSession: acpNewSession,
  loadSession: acpLoadSession,
  resumeSession: acpResumeSession,
  closeSession: acpCloseSession,
  listSessions: acpListSessions,
  sendPrompt: acpSendPrompt,
  sendPromptBlocks: acpSendPromptBlocks,
  cancelPrompt: acpCancelPrompt,
  setConfigOption: acpSetConfigOption,
  setMode: acpSetMode,
  respondPermission: acpRespondPermission,
  authenticate: acpAuthenticate,
  onEvent: onAcpEvent
}
