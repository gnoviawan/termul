/**
 * ACP agent chat store.
 *
 * Holds configured agents, active sessions, and per-session conversation state.
 * All backend access goes through `@/lib/acp-api`. Backend events are wired into
 * this store exactly once via `initAcpEventListeners()` (called at app mount).
 *
 * P1 scope: text conversations. `toolCalls`, `plans`, `commands`,
 * `pendingPermissions`, and config/mode state are tracked here so later phases
 * (P2 slash menu, P3 tool/permission UI) can render them, but P1 renders only
 * messages.
 */

import { toast } from 'sonner'
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import {
  loadAgentConfigs as loadAgentConfigsFromDisk,
  type StoredAgentConfig,
  saveAgentConfigs as saveAgentConfigsToDisk
} from '@/lib/acp-agents-persistence'
import {
  ACP_EVENTS,
  type AgentCapabilities,
  type AgentConfig,
  type AgentDisconnectedEvent,
  type AgentErrorEvent,
  type AgentId,
  type AgentSpawnedEvent,
  type AvailableCommand,
  acpApi,
  type CommandsUpdateEvent,
  type ConfigOptionsUpdateEvent,
  type ContentBlock,
  type McpServer,
  type MessageChunkEvent,
  type ModeUpdateEvent,
  type PermissionOption,
  type PermissionRequestEvent,
  type PlanEntry,
  type PlanUpdateEvent,
  type PromptCompleteEvent,
  type SessionClosedEvent,
  type SessionConfigOption,
  type SessionCreatedEvent,
  type SessionId,
  type SessionInfo,
  type SessionMode,
  type SessionModelState,
  type SessionModeState,
  type StopReason,
  type ToolCall,
  type ToolCallEvent,
  type ToolCallUpdateEvent
} from '@/lib/acp-api'
import {
  deleteSessionPayload,
  deriveTitle,
  loadSessionIndex as loadSessionIndexFromDisk,
  loadSessionPayload,
  type SessionIndexEntry,
  type SessionPayload,
  saveSessionIndex as saveSessionIndexToDisk,
  saveSessionPayload
} from '@/lib/acp-history-persistence'
import {
  loadMcpServers as loadMcpServersFromDisk,
  type StoredMcpServer,
  saveMcpServers as saveMcpServersToDisk
} from '@/lib/acp-mcp-persistence'
import { decideResume } from '@/lib/acp-resume-policy'
import { formatAcpSpawnError } from '@/lib/agents/acp-spawn-errors'
import { deleteSessionTempFiles } from '@/lib/attachment-temp-cleanup'

export type AgentStatus = 'idle' | 'spawning' | 'connected' | 'error'
export type SessionStatus = 'initializing' | 'active' | 'error' | 'closed'
export type MessageRole = 'user' | 'agent' | 'thought'

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
}

export interface AcpSession {
  id: SessionId
  agentId: AgentId
  cwd: string
  /**
   * Owning `Project.id`. Persisted onto every history entry so the index can
   * be filtered per-project + per-worktree (`(projectId, cwd)`). See ADR 0002.
   */
  projectId: string
  status: SessionStatus
  title: string | null
  /** True while a prompt turn is in flight (UI spinners, cancel). */
  activeTurn: boolean
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
}

export interface PendingPermission {
  requestId: string
  agentId: AgentId
  sessionId: SessionId
  options: PermissionOption[]
  toolCall: unknown
}

interface AcpState {
  // Agent registry
  agents: Record<AgentId, { id: AgentId; capabilities: AgentCapabilities | null }>
  agentStatus: Record<AgentId, AgentStatus>

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
  /** Last background prepare error keyed by prepare key. */
  prepareChatErrors: Record<string, string>

  // Persisted chat-history index (loaded on mount; payloads load lazily)
  sessionIndex: SessionIndexEntry[]

  // Discovered (agent-native) sessions via `session/list` — ephemeral, not persisted.
  // Keyed by agentId; each entry is the agent's SessionInfo[] for the active cwd.
  discoveredSessions: Record<AgentId, SessionInfo[]>
  /** Agents whose discovery is currently in flight (prevents duplicate requests). */
  discoveringAgents: Record<AgentId, true>

  // Global MCP server registry (persisted)
  mcpServers: StoredMcpServer[]

  // Sessions
  sessions: Record<SessionId, AcpSession>
  activeSessionId: SessionId | null

  // Per-session conversation state
  messages: Record<SessionId, ChatMessage[]>
  toolCalls: Record<SessionId, ToolCall[]> // P3 renders
  plans: Record<SessionId, PlanEntry[]> // P3 renders
  commands: Record<SessionId, AvailableCommand[]> // P2 renders
  pendingPermissions: Record<string, PendingPermission> // P3 renders, keyed by requestId

  // Actions — lifecycle
  spawnAgent: (config: Parameters<typeof acpApi.spawnAgent>[0]) => Promise<AgentId>
  killAgent: (agentId: AgentId) => Promise<void>
  createSession: (
    agentId: AgentId,
    cwd: string,
    mcpServers: McpServer[] | undefined,
    projectId: string
  ) => Promise<SessionId>
  closeSession: (sessionId: SessionId) => Promise<void>
  setActiveSession: (sessionId: SessionId | null) => void

  // Actions — configured agents (P4)
  loadAgentConfigs: () => Promise<void>
  saveAgentConfig: (config: StoredAgentConfig) => Promise<void>
  deleteAgentConfig: (id: string) => Promise<void>
  testConnection: (config: AgentConfig) => Promise<AgentCapabilities | null>
  /**
   * Best-effort background spawn so a later `startChat` reuses a warm agent for
   * this config+cwd. Idempotent (dedupes against an in-flight or connected warm
   * for the same reuse key) and silent on failure — chat still lazy-spawns if
   * warm-up fails. No-op when `cwd` is empty.
   */
  prewarmAgent: (configId: string, cwd: string) => Promise<void>
  /**
   * Best-effort background `session/new` for a config+cwd (+ MCP selection) so
   * "Start Chat" can reuse a prepared session. Fire-and-forget from the UI;
   * dedupes in-flight work for the same key.
   */
  prepareChat: (
    configId: string,
    cwd: string,
    mcpServers: McpServer[] | undefined,
    projectId: string
  ) => void
  /** Drop any prepared session for this key (e.g. dialog closed or inputs changed). */
  cancelPreparedChat: (key: string) => void
  /** Spawn (or reuse a connected) agent for a config, create a session, return its id. */
  startChat: (
    configId: string,
    cwd: string,
    mcpServers: McpServer[] | undefined,
    projectId: string
  ) => Promise<SessionId>

  // Actions — chat history (P5)
  loadSessionIndex: () => Promise<void>
  openHistorySession: (id: string) => Promise<void>
  deleteHistorySession: (id: string) => Promise<void>

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
  deleteMcpServer: (id: string) => Promise<void>

  // Actions — conversation
  sendPrompt: (sessionId: SessionId, text: string) => Promise<void>
  /** Send a prompt turn carrying structured content blocks (text + image/resource). */
  sendPromptBlocks: (sessionId: SessionId, blocks: ContentBlock[]) => Promise<void>
  cancelPrompt: (sessionId: SessionId) => Promise<void>

  // Actions — config (P2 drives the UI; method available now)
  setConfigOption: (sessionId: SessionId, configId: string, valueId: string) => Promise<void>
  setMode: (sessionId: SessionId, modeId: string) => Promise<void>
  setModel: (sessionId: SessionId, modelId: string) => Promise<void>

  // Actions — permission (P3 drives the UI; method available now)
  respondPermission: (requestId: string, optionId?: string) => Promise<void>

  // Internal event reducers (exposed for tests)
  _onAgentSpawned: (e: AgentSpawnedEvent) => void
  _onSessionCreated: (e: SessionCreatedEvent) => void
  _onMessageChunk: (e: MessageChunkEvent) => void
  _onToolCall: (e: ToolCallEvent) => void
  _onToolCallUpdate: (e: ToolCallUpdateEvent) => void
  _onPlanUpdate: (e: PlanUpdateEvent) => void
  _onCommandsUpdate: (e: CommandsUpdateEvent) => void
  _onModeUpdate: (e: ModeUpdateEvent) => void
  _onConfigOptionsUpdate: (e: ConfigOptionsUpdateEvent) => void
  _onPermissionRequest: (e: PermissionRequestEvent) => void
  _onPromptComplete: (e: PromptCompleteEvent) => void
  _onAgentError: (e: AgentErrorEvent) => void
  _onAgentDisconnected: (e: AgentDisconnectedEvent) => void
  _onSessionClosed: (e: SessionClosedEvent) => void
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

/**
 * Monotonic arrival sequence for timeline ordering. Stamped on every message
 * and tool call as it lands so the UI can interleave the two on one
 * chronological timeline without relying on `Date.now()` (which ties within a
 * millisecond when text and tool events arrive back-to-back).
 */
let seqCounter = 0
function nextSeq(): number {
  seqCounter += 1
  return seqCounter
}

/**
 * Rebase the process-wide seq counter so live events appended after a persisted
 * session is reopened sort after the restored history. Without this, the
 * counter (which starts at 0 on every app load) could let `nextSeq()` return a
 * value smaller than an existing restored `seq`, and `buildTimeline` would
 * interleave fresh chunks/tool calls ahead of older history.
 */
function rebaseSeqCounter(maxSeq: number): void {
  if (maxSeq > seqCounter) seqCounter = maxSeq
}

/** Index of the last user message in a thread, or -1 if none. */
function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/**
 * True when `messages` ends with an in-progress assistant reply to the latest
 * user message. Covers late chunks delivered after `finalizeStreaming` cleared
 * `streaming` but before the UI turn fully closed.
 */
function hasActiveAssistantTail(messages: ChatMessage[], role: MessageRole): boolean {
  if (role !== 'agent' && role !== 'thought') return false
  const last = messages[messages.length - 1]
  if (!last || last.role !== role) return false
  if (last.streaming) return true
  const userIdx = lastUserIndex(messages)
  if (userIdx === -1) return false
  return messages.length - 1 > userIdx
}

/**
 * True when a tool call landed after `message` (by seq). Marks the point where
 * a new text run must start its own bubble instead of merging back into the
 * pre-tool message.
 */
function toolIntervened(toolCalls: ToolCall[], message: ChatMessage): boolean {
  if (message.seq == null) return false
  return toolCalls.some((t) => typeof t.seq === 'number' && t.seq > message.seq!)
}

/** Whether a chunk may open a new message (not coalesced into the previous one). */
function mayStartChunkMessage(
  session: AcpSession,
  messages: ChatMessage[],
  role: MessageRole
): boolean {
  if (session.openTurnId) return true
  const last = messages[messages.length - 1]
  if ((role === 'agent' || role === 'thought') && last?.role === 'user') return true
  return false
}

/** Append text to a ContentBlock array, coalescing into a trailing text block. */
function appendBlocks(existing: ContentBlock[], incoming: ContentBlock): ContentBlock[] {
  if (incoming.type === 'text') {
    const last = existing[existing.length - 1]
    if (last && last.type === 'text') {
      const merged: ContentBlock = { ...last, text: (last.text ?? '') + (incoming.text ?? '') }
      return [...existing.slice(0, -1), merged]
    }
  }
  return [...existing, incoming]
}

/** Human-readable note for a non-`end_turn` stop reason, or null if none needed. */
function noteForStopReason(reason: StopReason): string | null {
  switch (reason) {
    case 'refusal':
      return 'The agent refused to continue.'
    case 'max_tokens':
      return 'Response stopped: token limit reached.'
    case 'max_turn_requests':
      return 'Response stopped: too many tool-call rounds.'
    case 'end_turn':
    case 'cancelled':
      return null
    default:
      return `Response stopped: ${reason}`
  }
}

/**
 * Finalize every streaming message for a session (mark non-streaming). A turn
 * can leave several messages mid-stream (e.g. a thought followed by the agent
 * reply); clearing only the trailing one strands earlier markers in their
 * `streaming` state and leaves their shimmer animating forever.
 */
function finalizeStreaming(
  messages: Record<SessionId, ChatMessage[]>,
  sessionId: SessionId
): Record<SessionId, ChatMessage[]> {
  const list = messages[sessionId] ?? []
  if (!list.some((m) => m.streaming)) return messages
  return {
    ...messages,
    [sessionId]: list.map((m) => (m.streaming ? { ...m, streaming: false } : m))
  }
}

/** Mark a reopened history session live after a successful load/resume IPC call. */
function withSessionActive(
  sessions: Record<SessionId, AcpSession>,
  sessionId: SessionId
): Record<SessionId, AcpSession> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return { ...sessions, [sessionId]: { ...session, status: 'active', lastError: null } }
}

/** Surface a failed history load/resume on the session without changing status. */
function withSessionResumeError(
  sessions: Record<SessionId, AcpSession>,
  sessionId: SessionId,
  err: unknown
): Record<SessionId, AcpSession> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return { ...sessions, [sessionId]: { ...session, lastError: `Resume failed: ${String(err)}` } }
}

/** Remove all pending permissions belonging to a session. */
function dropPermissionsForSession(
  pending: Record<string, PendingPermission>,
  sessionId: SessionId
): Record<string, PendingPermission> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].sessionId === sessionId) delete next[id]
  }
  return next
}

/** Remove all pending permissions belonging to an agent. */
function dropPermissionsForAgent(
  pending: Record<string, PendingPermission>,
  agentId: AgentId
): Record<string, PendingPermission> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].agentId === agentId) delete next[id]
  }
  return next
}

type TurnEndSetter = (
  partial: AcpState | Partial<AcpState> | ((state: AcpState) => AcpState | Partial<AcpState>),
  replace?: false
) => void

/**
 * End the current turn after the macrotask queue drains so streamed
 * `acp:message_chunk` events delivered after `acp_send_prompt` / `acp:prompt_complete`
 * are still accepted. Idempotent when the turn is already closed.
 */
function scheduleTurnEnd(set: TurnEndSetter, sessionId: SessionId, stopReason?: StopReason): void {
  setTimeout(() => {
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current?.openTurnId) return {}
      const note = stopReason !== undefined ? noteForStopReason(stopReason) : null
      return {
        messages: finalizeStreaming(s.messages, sessionId),
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            openTurnId: null,
            activeTurn: false,
            lastError: note ?? current.lastError
          }
        }
      }
    })
  }, 0)
}

/**
 * Mirror a session to disk (index entry + debounced payload) using the current
 * store snapshot. Best-effort: persistence failures are logged, never thrown
 * into the runtime path.
 */
function persistSession(
  state: {
    sessions: Record<SessionId, AcpSession>
    messages: Record<SessionId, ChatMessage[]>
    sessionIndex: SessionIndexEntry[]
    configToLiveAgent: Record<string, AgentId>
  },
  sessionId: SessionId,
  setIndex: (entries: SessionIndexEntry[]) => void
): void {
  const session = state.sessions[sessionId]
  if (!session) return
  const messages = state.messages[sessionId] ?? []
  const reuseKey = Object.keys(state.configToLiveAgent).find(
    (k) => state.configToLiveAgent[k] === session.agentId
  )
  const agentConfigId = reuseKey ? configIdFromReuseKey(reuseKey) : undefined
  const entry: SessionIndexEntry = {
    id: sessionId,
    agentId: session.agentId,
    agentConfigId,
    title: session.title ?? deriveTitle(messages, session.agentId),
    cwd: session.cwd,
    projectId: session.projectId,
    createdAt: session.createdAt,
    lastActivityAt: Date.now(),
    messageCount: messages.length,
    status: session.status
  }
  const nextIndex = [entry, ...state.sessionIndex.filter((e) => e.id !== sessionId)]
  setIndex(nextIndex)
  const payload: SessionPayload = { metadata: entry, messages }
  void saveSessionIndexToDisk(nextIndex).catch((e) =>
    console.error('[acp] failed to persist session index', e)
  )
  void saveSessionPayload(sessionId, payload).catch((e) =>
    console.error('[acp] failed to persist session payload', e)
  )
}

/**
 * In-flight pre-warm spawns, keyed by `agentReuseKey(configId, cwd)`. Held
 * outside reactive state (promises don't belong in the store) so `prewarmAgent`,
 * `startChat`, and `deleteAgentConfig` can dedupe against a warm that is still
 * spawning for the same config+cwd. The reactive `warmingConfigs` flag mirrors
 * membership for the UI.
 */
const inFlightWarms = new Map<string, Promise<AgentId | null>>()

/**
 * A live agent can be reused (instead of spawning a second process) when it is
 * connected. Provider CLIs own authentication, so an auth-blocked process is not
 * treated as reusable for new chat preparation.
 */
function isReusableStatus(status: AgentStatus | undefined): boolean {
  return status === 'connected'
}

/**
 * Identity of a live agent *process*: a configured agent + its working
 * directory. Distinct from {@link prepareChatKey} (which also folds in MCP
 * selection) because the agent process is MCP-agnostic — only the session is.
 * Keying the reuse map by this gives each project/cwd its own process, so the
 * same agent runs in parallel across projects and a crash in one is contained.
 * `configId` never contains `\0`, so {@link configIdFromReuseKey} can recover it.
 */
export function agentReuseKey(configId: string, cwd: string): string {
  return `${configId}\0${cwd.trim()}`
}

/** Recover the `configId` from an {@link agentReuseKey} (split on first NUL). */
export function configIdFromReuseKey(key: string): string {
  const nul = key.indexOf('\0')
  return nul === -1 ? key : key.slice(0, nul)
}

/** Stable key for prepare/start dedupe (MCP list order-independent). */
export function prepareChatKey(
  configId: string,
  cwd: string,
  mcpServers: McpServer[] | undefined
): string {
  const mcpKey = (mcpServers ?? [])
    .map((s) => JSON.stringify(s))
    .sort()
    .join('|')
  return `${configId}\0${cwd}\0${mcpKey}`
}

/** In-flight `session/new` for a prepare key. */
const inFlightPrepared = new Map<string, Promise<SessionId | null>>()

type EnsureLiveAgentOptions = {
  /** Mirror membership in `warmingConfigs` for the prewarm UI. */
  registerWarmUi?: boolean
  /** When true, spawn failures resolve to `null` instead of rejecting (prewarm). */
  silentSpawnFailure?: boolean
}

/**
 * Return a connected agent process for `configId + cwd`, spawning at most one
 * in-flight process per reuse key. Registers `inFlightWarms` synchronously so
 * concurrent `prewarmAgent`, `prepareChat`, and `startChat` cannot race a
 * second spawn.
 */
function ensureLiveAgent(
  get: () => AcpState,
  set: (fn: (s: AcpState) => Partial<AcpState> | AcpState) => void,
  configId: string,
  cwd: string,
  options: EnsureLiveAgentOptions = {}
): Promise<AgentId | null> {
  const trimmedCwd = cwd.trim()
  if (trimmedCwd.length === 0) return Promise.resolve(null)
  const config = get().agentConfigs.find((c) => c.id === configId)
  if (!config) return Promise.resolve(null)

  const reuseKey = agentReuseKey(configId, trimmedCwd)
  const existing = get().configToLiveAgent[reuseKey]
  if (existing && isReusableStatus(get().agentStatus[existing])) {
    return Promise.resolve(existing)
  }

  const inFlight = inFlightWarms.get(reuseKey)
  if (inFlight) return inFlight

  if (options.registerWarmUi) {
    set((s) => ({ warmingConfigs: { ...s.warmingConfigs, [reuseKey]: true } }))
  }

  const spawnPromise = (async (): Promise<AgentId | null> => {
    try {
      const agentId = await get().spawnAgent({
        name: config.name,
        command: config.command,
        args: config.args,
        env: config.env,
        allowTerminal: config.allowTerminal
      })
      if (get().agentConfigs.some((c) => c.id === configId)) {
        set((s) => ({ configToLiveAgent: { ...s.configToLiveAgent, [reuseKey]: agentId } }))
        return agentId
      }
      try {
        await get().killAgent(agentId)
      } catch {
        /* best-effort cleanup */
      }
      return null
    } catch (err) {
      if (options.silentSpawnFailure) {
        console.warn('[acp] ensureLiveAgent failed for', reuseKey, err)
        return null
      }
      throw err
    } finally {
      inFlightWarms.delete(reuseKey)
      if (options.registerWarmUi) {
        set((s) => {
          const warming = { ...s.warmingConfigs }
          delete warming[reuseKey]
          return { warmingConfigs: warming }
        })
      }
    }
  })()

  inFlightWarms.set(reuseKey, spawnPromise)
  return spawnPromise
}

function cancelPreparedChatEntry(
  key: string,
  set: (fn: (s: AcpState) => Partial<AcpState> | AcpState) => void
): void {
  inFlightPrepared.delete(key)
  set((s) => {
    if (
      !(key in s.preparedSessions) &&
      !(key in s.preparingChatKeys) &&
      !(key in s.prepareChatErrors)
    ) {
      return s
    }
    const preparedSessions = { ...s.preparedSessions }
    const preparingChatKeys = { ...s.preparingChatKeys }
    const prepareChatErrors = { ...s.prepareChatErrors }
    delete preparedSessions[key]
    delete preparingChatKeys[key]
    delete prepareChatErrors[key]
    return { preparedSessions, preparingChatKeys, prepareChatErrors }
  })
}

/**
 * Shared orchestration for a user-initiated prompt turn: stage the optimistic
 * user message, mark the turn active, persist, then dispatch to the agent and
 * schedule turn-end. On failure, finalize any streaming markers and record the
 * error. `sendPrompt` and `sendPromptBlocks` differ only in the blocks they
 * stage and which IPC they invoke — captured by `userBlocks` and `dispatch`.
 */
async function runPromptTurn(
  set: TurnEndSetter,
  get: () => AcpState,
  sessionId: SessionId,
  userBlocks: ContentBlock[],
  dispatch: (session: AcpSession) => Promise<StopReason>
): Promise<void> {
  const session = get().sessions[sessionId]
  if (!session) throw new Error(`unknown session ${sessionId}`)
  if (session.status === 'closed') throw new Error('session is closed')
  if (session.openTurnId) throw new Error('a prompt turn is already in progress')
  if (userBlocks.length === 0) throw new Error('prompt content must not be empty')
  const openTurnId = newId('turn')
  // optimistic user message + mark turn active
  const userMessage: ChatMessage = {
    id: newId('msg'),
    role: 'user',
    blocks: userBlocks,
    streaming: false,
    timestamp: Date.now(),
    seq: nextSeq()
  }
  set((s) => ({
    messages: { ...s.messages, [sessionId]: [...(s.messages[sessionId] ?? []), userMessage] },
    sessions: {
      ...s.sessions,
      [sessionId]: { ...s.sessions[sessionId], activeTurn: true, openTurnId, lastError: null }
    }
  }))
  persistSession(get(), sessionId, (entries) => set({ sessionIndex: entries }))
  try {
    // Command reply vs streamed chunks have no ordering guarantee; defer turn
    // end to a macrotask so chunk listeners run first. Idempotent with
    // `_onPromptComplete` (which also calls `scheduleTurnEnd`).
    const stopReason = await dispatch(session)
    scheduleTurnEnd(set, sessionId, stopReason)
  } catch (err) {
    set((s) => ({
      messages: finalizeStreaming(s.messages, sessionId),
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          activeTurn: false,
          openTurnId: null,
          lastError: String(err)
        }
      }
    }))
    throw err
  }
}

export const useAcpStore = create<AcpState>((set, get) => ({
  agents: {},
  agentStatus: {},
  agentConfigs: [],
  configToLiveAgent: {},
  warmingConfigs: {},
  /** Prepared `session/new` results keyed by {@link prepareChatKey}. */
  preparedSessions: {},
  preparingChatKeys: {},
  prepareChatErrors: {},
  sessionIndex: [],
  discoveredSessions: {},
  discoveringAgents: {},
  mcpServers: [],
  sessions: {},
  activeSessionId: null,
  messages: {},
  toolCalls: {},
  plans: {},
  commands: {},
  pendingPermissions: {},

  spawnAgent: async (config) => {
    const tempKey = config.name
    set((s) => ({ agentStatus: { ...s.agentStatus, [tempKey]: 'spawning' } }))
    try {
      const agentId = await acpApi.spawnAgent(config)
      set((s) => {
        // Drop the transient name-keyed `spawning` marker now that we have the
        // real agent id; leaving it would strand a stale status forever.
        const agentStatus = { ...s.agentStatus }
        delete agentStatus[tempKey]
        agentStatus[agentId] = 'connected'
        return {
          agents: { ...s.agents, [agentId]: { id: agentId, capabilities: null } },
          agentStatus
        }
      })
      return agentId
    } catch (err) {
      set((s) => ({ agentStatus: { ...s.agentStatus, [tempKey]: 'error' } }))
      throw err
    }
  },

  killAgent: async (agentId) => {
    await acpApi.killAgent(agentId)
    set((s) => {
      const agents = { ...s.agents }
      const agentStatus = { ...s.agentStatus }
      delete agents[agentId]
      delete agentStatus[agentId]
      // Drop any config->live mapping pointing at this agent so it can't be
      // reused after the process is gone.
      const configToLiveAgent = { ...s.configToLiveAgent }
      for (const cid of Object.keys(configToLiveAgent)) {
        if (configToLiveAgent[cid] === agentId) delete configToLiveAgent[cid]
      }
      // mark this agent's sessions closed
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === agentId) {
          sessions[id] = { ...sessions[id], status: 'closed', activeTurn: false, openTurnId: null }
        }
      }
      return {
        agents,
        agentStatus,
        configToLiveAgent,
        sessions,
        pendingPermissions: dropPermissionsForAgent(s.pendingPermissions, agentId)
      }
    })
  },

  createSession: async (agentId, cwd, mcpServers, projectId) => {
    const outcome = await acpApi.newSession(agentId, cwd, mcpServers)
    const sessionId = outcome.sessionId
    set((s) => {
      // Merge with any record an event may have created during the await window,
      // so we don't discard event-set lastError/activeTurn/modes.
      const existing = s.sessions[sessionId]
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            id: sessionId,
            agentId,
            cwd,
            projectId,
            status: existing?.status === 'closed' ? 'closed' : 'active',
            title: existing?.title ?? null,
            activeTurn: existing?.activeTurn ?? false,
            openTurnId: existing?.openTurnId ?? null,
            modes: outcome.modes ?? existing?.modes ?? null,
            models: outcome.models ?? existing?.models ?? null,
            configOptions: outcome.configOptions ?? existing?.configOptions ?? [],
            lastError: existing?.lastError ?? null,
            createdAt: existing?.createdAt ?? Date.now()
          }
        },
        messages: { ...s.messages, [sessionId]: s.messages[sessionId] ?? [] },
        activeSessionId: s.activeSessionId ?? sessionId
      }
    })
    // mirror to disk (index + payload)
    const st = get()
    persistSession(st, sessionId, (entries) => set({ sessionIndex: entries }))
    return sessionId
  },

  closeSession: async (sessionId) => {
    const session = get().sessions[sessionId]
    if (session && session.status !== 'closed') {
      try {
        await acpApi.closeSession(session.agentId, sessionId)
      } catch {
        // close may fail if the agent lacks the capability; mark closed locally regardless
      }
    }
    // Reclaim app-owned temp files (pasted screenshots) staged for this session
    // now that no further turns can read them.
    void deleteSessionTempFiles(sessionId)
    set((s) => {
      const sessions = { ...s.sessions }
      if (sessions[sessionId]) {
        sessions[sessionId] = {
          ...sessions[sessionId],
          status: 'closed',
          activeTurn: false,
          openTurnId: null
        }
      }
      return {
        sessions,
        pendingPermissions: dropPermissionsForSession(s.pendingPermissions, sessionId)
      }
    })
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  loadAgentConfigs: async () => {
    try {
      const configs = await loadAgentConfigsFromDisk()
      set({ agentConfigs: configs })
    } catch (err) {
      // A real storage/backend error is surfaced by the persistence layer; at the
      // store level we log and leave the list empty rather than crashing app
      // mount. (A missing key already returns [] without throwing.)
      console.error('[acp] failed to load agent configs', err)
    }
  },

  saveAgentConfig: async (config) => {
    const list = get().agentConfigs
    const idx = list.findIndex((c) => c.id === config.id)
    const next = idx === -1 ? [...list, config] : list.map((c) => (c.id === config.id ? config : c))
    set({ agentConfigs: next })
    try {
      await saveAgentConfigsToDisk(next)
    } catch (err) {
      // roll back the in-memory change on persistence failure
      set({ agentConfigs: list })
      throw err
    }
  },

  deleteAgentConfig: async (id) => {
    const list = get().agentConfigs
    const next = list.filter((c) => c.id !== id)
    set({ agentConfigs: next })
    try {
      await saveAgentConfigsToDisk(next)
    } catch (err) {
      set({ agentConfigs: list })
      throw err
    }
    // Tear down every per-project warmed process for this config so none can be
    // reused stale. The reuse map and warm map are keyed by config+cwd, so a
    // single config may own several live processes (one per project/cwd).
    // Await each in-flight warm first: its spawn may not have registered the
    // agent id yet, and without this the just-spawned process would leak.
    const reuseKeys = new Set<string>([
      ...Object.keys(get().configToLiveAgent),
      ...inFlightWarms.keys()
    ])
    const targets = [...reuseKeys].filter((k) => configIdFromReuseKey(k) === id)
    const warmAgents: AgentId[] = []
    for (const key of targets) {
      const pending = inFlightWarms.get(key)
      const warm = pending ? await pending : get().configToLiveAgent[key]
      if (warm) warmAgents.push(warm)
    }
    if (warmAgents.length > 0) {
      set((s) => {
        const map = { ...s.configToLiveAgent }
        for (const key of targets) delete map[key]
        return { configToLiveAgent: map }
      })
      for (const warm of warmAgents) {
        try {
          await get().killAgent(warm)
        } catch {
          /* best-effort cleanup */
        }
      }
    }
    // Drop prepared sessions for this config so a later re-enable can't consume
    // stale prepare keys (prepareChatKey also starts with configId\0…).
    const prepareKeys = new Set<string>([
      ...Object.keys(get().preparedSessions),
      ...Object.keys(get().preparingChatKeys),
      ...Object.keys(get().prepareChatErrors),
      ...inFlightPrepared.keys()
    ])
    for (const key of prepareKeys) {
      if (configIdFromReuseKey(key) !== id) continue
      get().cancelPreparedChat(key)
    }
  },

  prewarmAgent: async (configId, cwd) => {
    await ensureLiveAgent(get, set, configId, cwd, {
      registerWarmUi: true,
      silentSpawnFailure: true
    })
  },

  cancelPreparedChat: (key) => {
    // A prepared session was created via `createSession` (live backend session +
    // persisted history). When the user abandons it (dialog closed / inputs
    // changed) we must tear those down, not just drop the lookup entry.
    const sessionId = get().preparedSessions[key]
    cancelPreparedChatEntry(key, set)
    if (!sessionId) return
    // If the user already navigated to this session, don't reap it.
    if (get().activeSessionId === sessionId) return
    void get()
      .closeSession(sessionId)
      .catch(() => {
        /* best-effort: backend may already be gone */
      })
      .finally(() => {
        void get().deleteHistorySession(sessionId)
      })
  },

  prepareChat: (configId, cwd, mcpServers, projectId) => {
    const trimmedCwd = cwd.trim()
    if (!configId || trimmedCwd.length === 0) return
    const key = prepareChatKey(configId, trimmedCwd, mcpServers)
    if (get().preparedSessions[key] || inFlightPrepared.has(key)) return
    set((s) => {
      const prepareChatErrors = { ...s.prepareChatErrors }
      delete prepareChatErrors[key]
      return {
        preparingChatKeys: { ...s.preparingChatKeys, [key]: true },
        prepareChatErrors
      }
    })

    const task = (async (): Promise<SessionId | null> => {
      try {
        const agentId = await ensureLiveAgent(get, set, configId, trimmedCwd)
        if (!agentId) return null
        const sessionId = await get().createSession(agentId, trimmedCwd, mcpServers, projectId)
        if (prepareChatKey(configId, trimmedCwd, mcpServers) !== key) {
          return null
        }
        if (!inFlightPrepared.has(key)) {
          return null
        }
        set((s) => ({
          preparedSessions: { ...s.preparedSessions, [key]: sessionId }
        }))
        return sessionId
      } catch (err) {
        console.warn('[acp] prepareChat failed', configId, err)
        if (inFlightPrepared.has(key)) {
          const config = get().agentConfigs.find((c) => c.id === configId)
          const message = formatAcpSpawnError(err, config)
          set((s) => ({
            prepareChatErrors: { ...s.prepareChatErrors, [key]: message }
          }))
          toast.error(message)
        }
        return null
      } finally {
        inFlightPrepared.delete(key)
        set((s) => {
          const preparingChatKeys = { ...s.preparingChatKeys }
          delete preparingChatKeys[key]
          return { preparingChatKeys }
        })
      }
    })()
    inFlightPrepared.set(key, task)
  },

  testConnection: async (config) => {
    let agentId: AgentId | null = null
    try {
      agentId = await acpApi.spawnAgent(config)
      // Capabilities arrive asynchronously via the `acp:agent_spawned` event
      // (reduced into the store). Wait briefly for them to appear rather than
      // reading the store synchronously (which would usually race and return
      // null). A successful spawn resolving already implies `initialize`
      // succeeded, so a short timeout returning null caps is still a pass.
      const id = agentId
      const caps = await new Promise<AgentCapabilities | null>((resolve) => {
        const existing = get().agents[id]?.capabilities ?? null
        if (existing) {
          resolve(existing)
          return
        }
        const timeout = setTimeout(() => {
          unsubscribe()
          resolve(get().agents[id]?.capabilities ?? null)
        }, 3000)
        const unsubscribe = useAcpStore.subscribe((state) => {
          const c = state.agents[id]?.capabilities
          if (c) {
            clearTimeout(timeout)
            unsubscribe()
            resolve(c)
          }
        })
      })
      return caps
    } finally {
      // Always clean up the test process.
      if (agentId) {
        try {
          await acpApi.killAgent(agentId)
        } catch {
          /* best-effort cleanup */
        }
        const id = agentId
        set((s) => {
          const agents = { ...s.agents }
          const agentStatus = { ...s.agentStatus }
          delete agents[id]
          delete agentStatus[id]
          return { agents, agentStatus }
        })
      }
    }
  },

  startChat: async (configId, cwd, mcpServers, projectId) => {
    const trimmedCwd = cwd.trim()
    const config = get().agentConfigs.find((c) => c.id === configId)
    if (!config) throw new Error(`unknown agent config ${configId}`)
    const key = prepareChatKey(configId, trimmedCwd, mcpServers)
    const prepared = get().preparedSessions[key]
    if (prepared) {
      cancelPreparedChatEntry(key, set)
      return prepared
    }
    const inFlight = inFlightPrepared.get(key)
    if (inFlight) {
      const sessionId = await inFlight
      if (sessionId) {
        cancelPreparedChatEntry(key, set)
        return sessionId
      }
    }
    const agentId = await ensureLiveAgent(get, set, configId, trimmedCwd)
    if (!agentId) throw new Error(`failed to spawn agent for config ${configId}`)
    return get().createSession(agentId, trimmedCwd, mcpServers, projectId)
  },

  loadSessionIndex: async () => {
    const entries = await loadSessionIndexFromDisk()
    set({ sessionIndex: entries })
  },

  openHistorySession: async (id) => {
    const cached = get().sessions[id]
    // Only skip reload for a genuinely live session (active/initializing/error).
    // A cached `closed` entry (e.g. tab still open after delete) must still open
    // from persisted history via load/resume/local below.
    if (cached && cached.status !== 'closed') return

    const payload = await loadSessionPayload(id)
    if (!payload) throw new Error(`no persisted history for ${id}`)
    const meta = payload.metadata

    const connected = get().agentStatus[meta.agentId] === 'connected'
    const capabilities = get().agents[meta.agentId]?.capabilities ?? null
    const strategy = decideResume({ connected, capabilities })

    // Rebase the process-wide seq counter so live events appended after the
    // restored transcript sort after it (nextSeq() returns > max restored seq).
    let maxRestoredSeq = 0
    for (const m of payload.messages) {
      if (typeof m.seq === 'number' && m.seq > maxRestoredSeq) maxRestoredSeq = m.seq
    }
    rebaseSeqCounter(maxRestoredSeq)

    // Show the persisted transcript locally and register the session record so the
    // pane has content regardless of strategy.
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: {
          id,
          agentId: meta.agentId,
          cwd: meta.cwd,
          projectId: meta.projectId,
          status: 'closed',
          title: meta.title,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: meta.createdAt
        }
      },
      messages: { ...s.messages, [id]: payload.messages }
    }))

    if (strategy === 'load') {
      // Agent replays history via session/update; clear local copy to avoid dupes.
      set((s) => ({ messages: { ...s.messages, [id]: [] } }))
      try {
        await acpApi.loadSession(meta.agentId, id, meta.cwd)
        set((s) => ({ sessions: withSessionActive(s.sessions, id) }))
      } catch (err) {
        // Load failed — restore the local transcript so the user still sees history.
        set((s) => ({
          messages: { ...s.messages, [id]: payload.messages },
          sessions: withSessionResumeError(s.sessions, id, err)
        }))
        throw err
      }
    } else if (strategy === 'resume') {
      try {
        await acpApi.resumeSession(meta.agentId, id, meta.cwd)
        set((s) => ({ sessions: withSessionActive(s.sessions, id) }))
      } catch (err) {
        set((s) => ({ sessions: withSessionResumeError(s.sessions, id, err) }))
        throw err
      }
    }
    // 'local' → nothing more; the transcript is already shown.
  },

  deleteHistorySession: async (id) => {
    const next = get().sessionIndex.filter((e) => e.id !== id)
    set((s) => {
      // If the chat is open in a pane, mark its live session closed so the pane
      // reflects the deletion instead of showing stale content.
      const sessions = { ...s.sessions }
      if (sessions[id]) {
        sessions[id] = { ...sessions[id], status: 'closed', activeTurn: false, openTurnId: null }
      }
      return { sessionIndex: next, sessions }
    })
    // Reclaim any app-owned temp files staged for this session.
    void deleteSessionTempFiles(id)
    try {
      await saveSessionIndexToDisk(next)
      await deleteSessionPayload(id)
    } catch (e) {
      console.error('[acp] failed to delete session history', e)
    }
  },

  // --- Session discovery (gh-407) -------------------------------------------

  discoverSessions: async (agentId, cwd) => {
    // Gate on sessionCapabilities.list — never call session/list without it.
    const agent = get().agents[agentId]
    if (!agent?.capabilities) return
    if (!agent.capabilities.sessionCapabilities?.list) return

    // Prevent duplicate concurrent discovery for the same agent.
    if (get().discoveringAgents[agentId]) return
    set((s) => ({ discoveringAgents: { ...s.discoveringAgents, [agentId]: true } }))

    try {
      const all: SessionInfo[] = []
      let cursor: string | undefined
      // Safety cap: 10 pages max.
      for (let i = 0; i < 10; i++) {
        const res = await acpApi.listSessions(agentId, cwd || undefined, cursor)
        if (Array.isArray(res.sessions)) {
          all.push(...res.sessions)
        }
        if (!res.nextCursor) break
        cursor = res.nextCursor
      }
      set((s) => ({ discoveredSessions: { ...s.discoveredSessions, [agentId]: all } }))
    } catch (e) {
      // Best-effort: log warning, don't toast (discovery is opportunistic).
      console.warn('[acp] session/list failed for agent', agentId, e)
      // Clear any stale discovered entries for this agent.
      set((s) => {
        const next = { ...s.discoveredSessions }
        delete next[agentId]
        return { discoveredSessions: next }
      })
    } finally {
      set((s) => {
        const next = { ...s.discoveringAgents }
        delete next[agentId]
        return { discoveringAgents: next }
      })
    }
  },

  openDiscoveredSession: async (agentId, sessionId, cwd, projectId) => {
    const connected = get().agentStatus[agentId] === 'connected'
    const capabilities = get().agents[agentId]?.capabilities ?? null
    const strategy = decideResume({ connected, capabilities })

    if (strategy === 'local') {
      throw new Error(
        'agent does not support loading or resuming sessions (no loadSession or sessionCapabilities.resume)'
      )
    }

    // Create a minimal session record so streaming events (session/update)
    // during replay have a session to attach to, mirroring openHistorySession.
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: {
          id: sessionId,
          agentId,
          cwd,
          projectId,
          status: 'closed',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: Date.now()
        }
      },
      messages: { ...s.messages, [sessionId]: [] }
    }))

    if (strategy === 'load') {
      // Agent replays history via session/update; clear local copy to avoid dupes.
      try {
        await acpApi.loadSession(agentId, sessionId, cwd)
        set((s) => ({ sessions: withSessionActive(s.sessions, sessionId) }))
      } catch (err) {
        // Restore empty messages so the pane doesn't show stale content.
        set((s) => ({ sessions: withSessionResumeError(s.sessions, sessionId, err) }))
        throw err
      }
    } else if (strategy === 'resume') {
      try {
        await acpApi.resumeSession(agentId, sessionId, cwd)
        set((s) => ({ sessions: withSessionActive(s.sessions, sessionId) }))
      } catch (err) {
        set((s) => ({ sessions: withSessionResumeError(s.sessions, sessionId, err) }))
        throw err
      }
    }
  },

  loadMcpServers: async () => {
    const list = await loadMcpServersFromDisk()
    set({ mcpServers: list })
  },

  saveMcpServer: async (server) => {
    const list = get().mcpServers
    const idx = list.findIndex((s) => s.id === server.id)
    const next = idx === -1 ? [...list, server] : list.map((s) => (s.id === server.id ? server : s))
    set({ mcpServers: next })
    try {
      await saveMcpServersToDisk(next)
    } catch (err) {
      set({ mcpServers: list })
      throw err
    }
  },

  deleteMcpServer: async (id) => {
    const list = get().mcpServers
    const next = list.filter((s) => s.id !== id)
    set({ mcpServers: next })
    try {
      await saveMcpServersToDisk(next)
    } catch (err) {
      set({ mcpServers: list })
      throw err
    }
  },

  sendPrompt: (sessionId, text) =>
    runPromptTurn(set, get, sessionId, [{ type: 'text', text }], (session) =>
      acpApi.sendPrompt(session.agentId, sessionId, text)
    ),

  sendPromptBlocks: (sessionId, blocks) =>
    runPromptTurn(set, get, sessionId, blocks, (session) =>
      acpApi.sendPromptBlocks(session.agentId, sessionId, blocks)
    ),

  cancelPrompt: async (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session?.activeTurn) return
    await acpApi.cancelPrompt(session.agentId, sessionId)
    // turn cleared by _onPromptComplete (cancelled) or by sendPrompt's resolution
  },

  setConfigOption: async (sessionId, configId, valueId) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    const updated = await acpApi.setConfigOption(session.agentId, sessionId, configId, valueId)
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId], configOptions: updated } }
    }))
  },

  setMode: async (sessionId, modeId) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    await acpApi.setMode(session.agentId, sessionId, modeId)
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current?.modes) return {}
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            modes: { ...current.modes, currentModeId: modeId }
          }
        }
      }
    })
  },

  setModel: async (sessionId, modelId) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    await acpApi.setModel(session.agentId, sessionId, modelId)
    set((s) => {
      const current = s.sessions[sessionId]
      if (!current?.models) return {}
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: {
            ...current,
            models: { ...current.models, currentModelId: modelId }
          }
        }
      }
    })
  },

  respondPermission: async (requestId, optionId) => {
    const pending = get().pendingPermissions[requestId]
    if (!pending) return
    // Optimistically remove so a rapid double-click can't fire a second backend
    // call for the same request (which would error as 'unknown request').
    set((s) => {
      const pendingPermissions = { ...s.pendingPermissions }
      delete pendingPermissions[requestId]
      return { pendingPermissions }
    })
    try {
      await acpApi.respondPermission(pending.agentId, requestId, optionId)
    } catch (err) {
      // Restore the entry so the user can retry.
      set((s) => ({ pendingPermissions: { ...s.pendingPermissions, [requestId]: pending } }))
      throw err
    }
  },

  // --- Event reducers ------------------------------------------------------

  _onAgentSpawned: (e) =>
    set((s) => ({
      agents: { ...s.agents, [e.agentId]: { id: e.agentId, capabilities: e.capabilities } },
      agentStatus: {
        ...s.agentStatus,
        [e.agentId]: 'connected'
      }
    })),

  _onSessionCreated: (e) =>
    set((s) => {
      if (s.sessions[e.sessionId]) {
        // already created via createSession(); enrich with capability data
        return {
          sessions: {
            ...s.sessions,
            [e.sessionId]: {
              ...s.sessions[e.sessionId],
              modes: e.modes ?? s.sessions[e.sessionId].modes,
              models: e.models ?? s.sessions[e.sessionId].models ?? null,
              configOptions: e.configOptions ?? s.sessions[e.sessionId].configOptions
            }
          }
        }
      }
      return {
        sessions: {
          ...s.sessions,
          [e.sessionId]: {
            id: e.sessionId,
            agentId: e.agentId,
            cwd: '',
            projectId: '',
            status: 'active',
            title: null,
            activeTurn: false,
            openTurnId: null,
            modes: e.modes ?? null,
            models: e.models ?? null,
            configOptions: e.configOptions ?? [],
            lastError: null,
            createdAt: Date.now()
          }
        },
        messages: { ...s.messages, [e.sessionId]: s.messages[e.sessionId] ?? [] }
      }
    }),

  _onMessageChunk: (e) =>
    set((s) => {
      const session = s.sessions[e.sessionId]
      // Drop chunks for unknown or already-closed sessions (no orphan state).
      if (!session || session.status === 'closed') return {}
      const list = s.messages[e.sessionId] ?? []
      const last = list[list.length - 1]
      const role = e.role as MessageRole
      // Attach to the trailing assistant/user message for this turn (including
      // chunks that arrive after streaming was finalized but IPC lagged) —
      // UNLESS a tool call landed after that message. Coalescing across a tool
      // boundary would fold a post-tool text run back into the pre-tool bubble,
      // collapsing the real `text → tool → text` order into one position.
      const tools = s.toolCalls[e.sessionId] ?? []
      if (
        last &&
        last.role === role &&
        (last.streaming || hasActiveAssistantTail(list, role)) &&
        !toolIntervened(tools, last)
      ) {
        const updated: ChatMessage = {
          ...last,
          blocks: appendBlocks(last.blocks, e.content),
          streaming: true
        }
        return { messages: { ...s.messages, [e.sessionId]: [...list.slice(0, -1), updated] } }
      }
      if (!mayStartChunkMessage(session, list, role)) return {}
      // Ignore an empty leading text chunk (avoids a flashing empty bubble).
      if (e.content.type === 'text' && !(e.content.text ?? '').length) return {}
      const message: ChatMessage = {
        id: newId('msg'),
        role,
        blocks: [e.content],
        streaming: true,
        timestamp: Date.now(),
        seq: nextSeq()
      }
      return { messages: { ...s.messages, [e.sessionId]: [...list, message] } }
    }),

  _onToolCall: (e) =>
    set((s) => {
      // Stamp arrival time + monotonic seq (unless already present) so the UI
      // can interleave tool calls with messages on one chronological timeline.
      const stamped: ToolCall = {
        ...e.toolCall,
        timestamp: typeof e.toolCall.timestamp === 'number' ? e.toolCall.timestamp : Date.now(),
        seq: typeof e.toolCall.seq === 'number' ? e.toolCall.seq : nextSeq()
      }
      return {
        toolCalls: {
          ...s.toolCalls,
          [e.sessionId]: [...(s.toolCalls[e.sessionId] ?? []), stamped]
        }
      }
    }),

  _onToolCallUpdate: (e) =>
    set((s) => {
      const list = s.toolCalls[e.sessionId] ?? []
      const idx = list.findIndex((t) => t.toolCallId === e.update.toolCallId)
      if (idx === -1) return {}
      const merged = { ...list[idx], ...e.update }
      const next = [...list]
      next[idx] = merged
      return { toolCalls: { ...s.toolCalls, [e.sessionId]: next } }
    }),

  _onPlanUpdate: (e) =>
    set((s) => ({ plans: { ...s.plans, [e.sessionId]: e.plan.entries ?? [] } })),

  _onCommandsUpdate: (e) =>
    set((s) => ({ commands: { ...s.commands, [e.sessionId]: e.availableCommands ?? [] } })),

  _onModeUpdate: (e) =>
    set((s) => {
      const session = s.sessions[e.sessionId]
      if (!session) return {}
      const availableModes: SessionMode[] =
        e.availableModes && e.availableModes.length > 0
          ? e.availableModes
          : (session.modes?.availableModes ?? [])
      return {
        sessions: {
          ...s.sessions,
          [e.sessionId]: {
            ...session,
            modes: { currentModeId: e.currentModeId, availableModes }
          }
        }
      }
    }),

  _onConfigOptionsUpdate: (e) =>
    set((s) => {
      const session = s.sessions[e.sessionId]
      if (!session) return {}
      return {
        sessions: { ...s.sessions, [e.sessionId]: { ...session, configOptions: e.configOptions } }
      }
    }),

  _onPermissionRequest: (e) =>
    set((s) => {
      // Keep an existing pending request for this id; never silently drop it.
      if (s.pendingPermissions[e.requestId]) return {}
      return {
        pendingPermissions: {
          ...s.pendingPermissions,
          [e.requestId]: {
            requestId: e.requestId,
            agentId: e.agentId,
            sessionId: e.sessionId,
            options: e.options,
            toolCall: e.toolCall
          }
        }
      }
    }),

  _onPromptComplete: (e) => {
    set((s) => {
      const messages = finalizeStreaming(s.messages, e.sessionId)
      const session = s.sessions[e.sessionId]
      // A finished turn abandons any unanswered permission for this session;
      // the backend resolves it 'cancelled', so clear the stale store entry too.
      const pendingPermissions = dropPermissionsForSession(s.pendingPermissions, e.sessionId)
      if (!session) return { messages, pendingPermissions }
      const note = noteForStopReason(e.stopReason)
      return {
        messages,
        pendingPermissions,
        sessions: {
          ...s.sessions,
          [e.sessionId]: {
            ...session,
            lastError: note ?? session.lastError
          }
        }
      }
    })
    scheduleTurnEnd(set, e.sessionId, e.stopReason)
  },

  _onAgentError: (e) =>
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      if (e.sessionId && s.sessions[e.sessionId]) {
        return {
          agentStatus,
          sessions: {
            ...s.sessions,
            [e.sessionId]: {
              ...s.sessions[e.sessionId],
              lastError: e.message,
              activeTurn: false,
              openTurnId: null
            }
          }
        }
      }
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === e.agentId && sessions[id].status !== 'closed') {
          sessions[id] = {
            ...sessions[id],
            lastError: e.message,
            activeTurn: false,
            openTurnId: null
          }
        }
      }
      return { agentStatus, sessions }
    }),

  _onAgentDisconnected: (e) => {
    const affected: SessionId[] = []
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === e.agentId && sessions[id].status !== 'closed') {
          sessions[id] = { ...sessions[id], status: 'closed', activeTurn: false, openTurnId: null }
          affected.push(id)
        }
      }
      const discoveredSessions = { ...s.discoveredSessions }
      delete discoveredSessions[e.agentId]
      return {
        agentStatus,
        sessions,
        pendingPermissions: dropPermissionsForAgent(s.pendingPermissions, e.agentId),
        discoveredSessions
      }
    })
    // Persist the closed status for each session the disconnect affected, so the
    // history index reflects it across restarts (mirrors _onSessionClosed).
    for (const id of affected) {
      persistSession(get(), id, (entries) => set({ sessionIndex: entries }))
    }
  },

  _onSessionClosed: (e) => {
    // Reclaim app-owned temp files staged for this session (e.g. agent
    // disconnected) so they do not linger in the OS temp dir.
    void deleteSessionTempFiles(e.sessionId)
    set((s) => {
      const session = s.sessions[e.sessionId]
      const pendingPermissions = dropPermissionsForSession(s.pendingPermissions, e.sessionId)
      if (!session) return { pendingPermissions }
      return {
        pendingPermissions,
        sessions: {
          ...s.sessions,
          [e.sessionId]: { ...session, status: 'closed', activeTurn: false, openTurnId: null }
        }
      }
    })
    if (get().sessions[e.sessionId]) {
      persistSession(get(), e.sessionId, (entries) => set({ sessionIndex: entries }))
    }
  }
}))

// --- Event listener wiring (called once at app mount) ----------------------

let listenersInitialized = false
let teardown: Array<() => void> = []

/**
 * Subscribe the store to all ACP backend events. Idempotent: a second call is a
 * no-op until the returned teardown runs. Returns a teardown that detaches all
 * listeners.
 */
export function initAcpEventListeners(): () => void {
  if (listenersInitialized) {
    return () => {
      /* already initialized elsewhere; the owning caller tears down */
    }
  }
  listenersInitialized = true
  teardown = [
    acpApi.onEvent<AgentSpawnedEvent>(ACP_EVENTS.agentSpawned, (e) =>
      useAcpStore.getState()._onAgentSpawned(e)
    ),
    acpApi.onEvent<SessionCreatedEvent>(ACP_EVENTS.sessionCreated, (e) =>
      useAcpStore.getState()._onSessionCreated(e)
    ),
    acpApi.onEvent<MessageChunkEvent>(ACP_EVENTS.messageChunk, (e) =>
      useAcpStore.getState()._onMessageChunk(e)
    ),
    acpApi.onEvent<ToolCallEvent>(ACP_EVENTS.toolCall, (e) =>
      useAcpStore.getState()._onToolCall(e)
    ),
    acpApi.onEvent<ToolCallUpdateEvent>(ACP_EVENTS.toolCallUpdate, (e) =>
      useAcpStore.getState()._onToolCallUpdate(e)
    ),
    acpApi.onEvent<PlanUpdateEvent>(ACP_EVENTS.planUpdate, (e) =>
      useAcpStore.getState()._onPlanUpdate(e)
    ),
    acpApi.onEvent<CommandsUpdateEvent>(ACP_EVENTS.commandsUpdate, (e) =>
      useAcpStore.getState()._onCommandsUpdate(e)
    ),
    acpApi.onEvent<ModeUpdateEvent>(ACP_EVENTS.modeUpdate, (e) =>
      useAcpStore.getState()._onModeUpdate(e)
    ),
    acpApi.onEvent<ConfigOptionsUpdateEvent>(ACP_EVENTS.configOptionsUpdate, (e) =>
      useAcpStore.getState()._onConfigOptionsUpdate(e)
    ),
    acpApi.onEvent<PermissionRequestEvent>(ACP_EVENTS.permissionRequest, (e) =>
      useAcpStore.getState()._onPermissionRequest(e)
    ),
    acpApi.onEvent<PromptCompleteEvent>(ACP_EVENTS.promptComplete, (e) =>
      useAcpStore.getState()._onPromptComplete(e)
    ),
    acpApi.onEvent<AgentErrorEvent>(ACP_EVENTS.agentError, (e) => {
      useAcpStore.getState()._onAgentError(e)
      toast.error(e.message || 'Agent error')
    }),
    acpApi.onEvent<AgentDisconnectedEvent>(ACP_EVENTS.agentDisconnected, (e) =>
      useAcpStore.getState()._onAgentDisconnected(e)
    ),
    acpApi.onEvent<SessionClosedEvent>(ACP_EVENTS.sessionClosed, (e) =>
      useAcpStore.getState()._onSessionClosed(e)
    )
  ]
  return () => {
    teardown.forEach((fn) => {
      fn()
    })
    teardown = []
    listenersInitialized = false
  }
}

// --- Selectors -------------------------------------------------------------

export const useAcpSession = (sessionId: SessionId | null): AcpSession | null =>
  useAcpStore((s) => (sessionId ? (s.sessions[sessionId] ?? null) : null))

export const useAcpMessages = (sessionId: SessionId | null): ChatMessage[] =>
  useAcpStore((s) => (sessionId ? (s.messages[sessionId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES))

const EMPTY_MESSAGES: ChatMessage[] = []

export interface AgentIdentity {
  /** Human-friendly agent name (e.g. "Cursor"), or null when unresolved. */
  name: string | null
  /** Template id used to resolve the agent icon, when known. */
  templateId: string | null
}

/**
 * Resolve the configured agent's display name + template (for icon) behind a
 * live session, via the configToLiveAgent mapping. Falls back to nulls when the
 * session was opened from history without a matching live config.
 */
export function selectAgentIdentity(state: AcpState, agentId: AgentId | null): AgentIdentity {
  if (!agentId) return { name: null, templateId: null }
  const reuseKey = Object.keys(state.configToLiveAgent).find(
    (k) => state.configToLiveAgent[k] === agentId
  )
  const configId = reuseKey ? configIdFromReuseKey(reuseKey) : undefined
  const config = configId ? state.agentConfigs.find((c) => c.id === configId) : undefined
  return { name: config?.name ?? null, templateId: config?.templateId ?? null }
}

export const useAgentIdentity = (agentId: AgentId | null): AgentIdentity =>
  useAcpStore(useShallow((s) => selectAgentIdentity(s, agentId)))

/** Project IDs with at least one open agent-chat session in an active turn. */
export function collectProjectsWithActiveAgentChat(
  sessions: Record<SessionId, AcpSession>
): string[] {
  const ids = new Set<string>()
  for (const session of Object.values(sessions)) {
    if (session.status !== 'closed' && session.activeTurn && session.projectId) {
      ids.add(session.projectId)
    }
  }
  return Array.from(ids).sort()
}

export function useProjectsWithActiveAgentChat(): string[] {
  return useAcpStore(useShallow((state) => collectProjectsWithActiveAgentChat(state.sessions)))
}

/** Aggregate warm state for a config across all of its per-project processes. */
export interface ConfigWarmState {
  /** A live process for this config is connected (in any project/cwd). */
  connected: boolean
  /** A background warm spawn for this config is in flight (any cwd). */
  warming: boolean
}

/**
 * Reduce the per-cwd reuse + warming maps to a single warm state for a config.
 * The reuse map is keyed by `agentReuseKey(configId, cwd)`, so a config can own
 * several live processes; the Settings badge wants one rolled-up status.
 */
export function selectConfigWarmState(state: AcpState, configId: string): ConfigWarmState {
  let connected = false
  for (const [key, agentId] of Object.entries(state.configToLiveAgent)) {
    if (configIdFromReuseKey(key) !== configId) continue
    if (state.agentStatus[agentId] === 'connected') connected = true
  }
  const warming = Object.keys(state.warmingConfigs).some(
    (key) => configIdFromReuseKey(key) === configId
  )
  return { connected, warming }
}

export const useConfigWarmState = (configId: string): ConfigWarmState =>
  useAcpStore(useShallow((s) => selectConfigWarmState(s, configId)))
