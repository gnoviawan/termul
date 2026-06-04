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
  type AuthRequiredEvent,
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
  type SessionMode,
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

export type AgentStatus = 'idle' | 'spawning' | 'connected' | 'error' | 'needs-auth'
export type SessionStatus = 'initializing' | 'active' | 'error' | 'closed'
export type MessageRole = 'user' | 'agent' | 'thought'

export interface ChatMessage {
  id: string
  role: MessageRole
  blocks: ContentBlock[]
  streaming: boolean
  timestamp: number
}

export interface AcpSession {
  id: SessionId
  agentId: AgentId
  cwd: string
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
  /** Pending ACP authentication requirements, keyed by live agent id. */
  pendingAuth: Record<AgentId, AuthRequiredEvent>

  // User-configured agents (persisted, distinct from the live `agents` map)
  agentConfigs: StoredAgentConfig[]
  /** Maps a configured agent id to its live spawned AgentId (for reuse). */
  configToLiveAgent: Record<string, AgentId>

  // Persisted chat-history index (loaded on mount; payloads load lazily)
  sessionIndex: SessionIndexEntry[]

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
  createSession: (agentId: AgentId, cwd: string, mcpServers?: McpServer[]) => Promise<SessionId>
  closeSession: (sessionId: SessionId) => Promise<void>
  setActiveSession: (sessionId: SessionId | null) => void

  // Actions — configured agents (P4)
  loadAgentConfigs: () => Promise<void>
  saveAgentConfig: (config: StoredAgentConfig) => Promise<void>
  deleteAgentConfig: (id: string) => Promise<void>
  testConnection: (config: AgentConfig) => Promise<AgentCapabilities | null>
  /** Spawn (or reuse a connected) agent for a config, create a session, return its id. */
  startChat: (configId: string, cwd: string, mcpServers?: McpServer[]) => Promise<SessionId>

  // Actions — chat history (P5)
  loadSessionIndex: () => Promise<void>
  openHistorySession: (id: string) => Promise<void>
  deleteHistorySession: (id: string) => Promise<void>

  // Actions — MCP server registry (P6)
  loadMcpServers: () => Promise<void>
  saveMcpServer: (server: StoredMcpServer) => Promise<void>
  deleteMcpServer: (id: string) => Promise<void>

  // Actions — conversation
  sendPrompt: (sessionId: SessionId, text: string) => Promise<void>
  cancelPrompt: (sessionId: SessionId) => Promise<void>

  // Actions — config (P2 drives the UI; method available now)
  setConfigOption: (sessionId: SessionId, configId: string, valueId: string) => Promise<void>
  setMode: (sessionId: SessionId, modeId: string) => Promise<void>

  // Actions — permission (P3 drives the UI; method available now)
  respondPermission: (requestId: string, optionId?: string) => Promise<void>

  // Actions — authentication
  authenticate: (agentId: AgentId, methodId: string) => Promise<void>

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
  _onAuthRequired: (e: AuthRequiredEvent) => void
  _onAgentDisconnected: (e: AgentDisconnectedEvent) => void
  _onSessionClosed: (e: SessionClosedEvent) => void
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
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
    default:
      // 'end_turn' and 'cancelled' are expected completions — no error note.
      return null
  }
}

/** Finalize the trailing streaming message for a session (mark non-streaming). */
function finalizeStreaming(
  messages: Record<SessionId, ChatMessage[]>,
  sessionId: SessionId
): Record<SessionId, ChatMessage[]> {
  const list = messages[sessionId] ?? []
  const last = list[list.length - 1]
  if (last && last.streaming) {
    return { ...messages, [sessionId]: [...list.slice(0, -1), { ...last, streaming: false }] }
  }
  return messages
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
  const agentConfigId = Object.keys(state.configToLiveAgent).find(
    (cid) => state.configToLiveAgent[cid] === session.agentId
  )
  const entry: SessionIndexEntry = {
    id: sessionId,
    agentId: session.agentId,
    agentConfigId,
    title: session.title ?? deriveTitle(messages, session.agentId),
    cwd: session.cwd,
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

export const useAcpStore = create<AcpState>((set, get) => ({
  agents: {},
  agentStatus: {},
  agentConfigs: [],
  configToLiveAgent: {},
  sessionIndex: [],
  mcpServers: [],
  sessions: {},
  activeSessionId: null,
  messages: {},
  toolCalls: {},
  plans: {},
  commands: {},
  pendingPermissions: {},
  pendingAuth: {},

  spawnAgent: async (config) => {
    const tempKey = config.name
    set((s) => ({ agentStatus: { ...s.agentStatus, [tempKey]: 'spawning' } }))
    try {
      const agentId = await acpApi.spawnAgent(config)
      set((s) => ({
        agents: { ...s.agents, [agentId]: { id: agentId, capabilities: null } },
        // Don't clobber a `needs-auth` status the auth_required event may have
        // already set (the events race with this resolve).
        agentStatus: {
          ...s.agentStatus,
          [agentId]: s.pendingAuth[agentId] ? 'needs-auth' : 'connected'
        }
      }))
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
      const pendingAuth = { ...s.pendingAuth }
      delete agents[agentId]
      delete agentStatus[agentId]
      delete pendingAuth[agentId]
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
        pendingAuth,
        sessions,
        pendingPermissions: dropPermissionsForAgent(s.pendingPermissions, agentId)
      }
    })
  },

  createSession: async (agentId, cwd, mcpServers) => {
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
            status: existing?.status === 'closed' ? 'closed' : 'active',
            title: existing?.title ?? null,
            activeTurn: existing?.activeTurn ?? false,
            openTurnId: existing?.openTurnId ?? null,
            modes: outcome.modes ?? existing?.modes ?? null,
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

  startChat: async (configId, cwd, mcpServers) => {
    const config = get().agentConfigs.find((c) => c.id === configId)
    if (!config) throw new Error(`unknown agent config ${configId}`)
    // Reuse a live agent for this config when it is still connected; otherwise spawn.
    const existing = get().configToLiveAgent[configId]
    const reuse = existing && get().agentStatus[existing] === 'connected' ? existing : null
    let agentId: AgentId
    if (reuse) {
      agentId = reuse
    } else {
      agentId = await get().spawnAgent({
        name: config.name,
        command: config.command,
        args: config.args,
        env: config.env,
        allowTerminal: config.allowTerminal
      })
      set((s) => ({ configToLiveAgent: { ...s.configToLiveAgent, [configId]: agentId } }))
    }
    // If the agent requires authentication, `newSession` will be rejected by the
    // agent. Fail fast with an actionable message instead of throwing an opaque
    // backend error; the agent stays connected so the user can authenticate and
    // retry starting the chat.
    if (get().pendingAuth[agentId]) {
      throw new Error('This agent requires authentication before a chat can start.')
    }
    return get().createSession(agentId, cwd, mcpServers)
  },

  loadSessionIndex: async () => {
    const entries = await loadSessionIndexFromDisk()
    set({ sessionIndex: entries })
  },

  openHistorySession: async (id) => {
    const payload = await loadSessionPayload(id)
    if (!payload) throw new Error(`no persisted history for ${id}`)
    const meta = payload.metadata
    const live = get().sessions[id]
    const connected = !!live && get().agentStatus[live.agentId] === 'connected'
    const capabilities = live ? (get().agents[live.agentId]?.capabilities ?? null) : null
    const strategy = decideResume({ connected, capabilities })

    // Always show the persisted transcript locally first (and register the session
    // record if it isn't live), so the pane has content regardless of strategy.
    set((s) => ({
      sessions: {
        ...s.sessions,
        [id]: s.sessions[id] ?? {
          id,
          agentId: meta.agentId,
          cwd: meta.cwd,
          status: 'closed',
          title: meta.title,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: meta.createdAt
        }
      },
      messages: { ...s.messages, [id]: payload.messages }
    }))

    if (strategy === 'load' && live) {
      // Agent replays history via session/update; clear local copy to avoid dupes.
      set((s) => ({ messages: { ...s.messages, [id]: [] } }))
      try {
        await acpApi.loadSession(live.agentId, id, meta.cwd)
      } catch (err) {
        // Load failed — restore the local transcript so the user still sees history.
        set((s) => ({
          messages: { ...s.messages, [id]: payload.messages },
          sessions: s.sessions[id]
            ? {
                ...s.sessions,
                [id]: { ...s.sessions[id], lastError: `Resume failed: ${String(err)}` }
              }
            : s.sessions
        }))
        throw err
      }
    } else if (strategy === 'resume' && live) {
      await acpApi.resumeSession(live.agentId, id, meta.cwd)
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
    try {
      await saveSessionIndexToDisk(next)
      await deleteSessionPayload(id)
    } catch (e) {
      console.error('[acp] failed to delete session history', e)
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

  sendPrompt: async (sessionId, text) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    if (session.status === 'closed') throw new Error('session is closed')
    if (session.openTurnId) throw new Error('a prompt turn is already in progress')
    const openTurnId = newId('turn')
    // optimistic user message + mark turn active
    const userMessage: ChatMessage = {
      id: newId('msg'),
      role: 'user',
      blocks: [{ type: 'text', text }],
      streaming: false,
      timestamp: Date.now()
    }
    set((s) => ({
      messages: { ...s.messages, [sessionId]: [...(s.messages[sessionId] ?? []), userMessage] },
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...s.sessions[sessionId],
          activeTurn: true,
          openTurnId,
          lastError: null
        }
      }
    }))
    try {
      const stopReason = await acpApi.sendPrompt(session.agentId, sessionId, text)
      // Command reply vs streamed chunks have no ordering guarantee; defer turn
      // end to a macrotask so chunk listeners run first. Idempotent with
      // `_onPromptComplete` (which also calls `scheduleTurnEnd`).
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
  },

  cancelPrompt: async (sessionId) => {
    const session = get().sessions[sessionId]
    if (!session || !session.activeTurn) return
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

  authenticate: async (agentId, methodId) => {
    const pending = get().pendingAuth[agentId]
    // Optimistically clear so a rapid double-click (or a second method click)
    // can't fire a concurrent `authenticate` for the same agent.
    set((s) => {
      const pendingAuth = { ...s.pendingAuth }
      delete pendingAuth[agentId]
      return {
        pendingAuth,
        agentStatus: { ...s.agentStatus, [agentId]: 'spawning' as AgentStatus }
      }
    })
    try {
      await acpApi.authenticate(agentId, methodId)
      set((s) => ({
        agentStatus: { ...s.agentStatus, [agentId]: 'connected' as AgentStatus }
      }))
    } catch (err) {
      // Restore the requirement so the user can retry.
      set((s) => ({
        pendingAuth: pending ? { ...s.pendingAuth, [agentId]: pending } : s.pendingAuth,
        agentStatus: { ...s.agentStatus, [agentId]: 'needs-auth' as AgentStatus }
      }))
      throw err
    }
  },

  // --- Event reducers ------------------------------------------------------

  _onAgentSpawned: (e) =>
    set((s) => ({
      agents: { ...s.agents, [e.agentId]: { id: e.agentId, capabilities: e.capabilities } },
      // Preserve `needs-auth` if an auth_required event already arrived for this
      // agent (the two events race across threads).
      agentStatus: {
        ...s.agentStatus,
        [e.agentId]: s.pendingAuth[e.agentId] ? 'needs-auth' : 'connected'
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
            status: 'active',
            title: null,
            activeTurn: false,
            openTurnId: null,
            modes: e.modes ?? null,
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
      // chunks that arrive after streaming was finalized but IPC lagged).
      if (last && last.role === role && (last.streaming || hasActiveAssistantTail(list, role))) {
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
        timestamp: Date.now()
      }
      return { messages: { ...s.messages, [e.sessionId]: [...list, message] } }
    }),

  _onToolCall: (e) =>
    set((s) => {
      // Stamp arrival time (unless already present) so the UI can interleave
      // tool calls with messages on a single chronological timeline.
      const stamped =
        typeof e.toolCall.timestamp === 'number'
          ? e.toolCall
          : { ...e.toolCall, timestamp: Date.now() }
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
      return { agentStatus }
    }),

  _onAuthRequired: (e) =>
    set((s) => ({
      pendingAuth: { ...s.pendingAuth, [e.agentId]: e },
      agentStatus: { ...s.agentStatus, [e.agentId]: 'needs-auth' as AgentStatus }
    })),

  _onAgentDisconnected: (e) => {
    const affected: SessionId[] = []
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      const pendingAuth = { ...s.pendingAuth }
      delete pendingAuth[e.agentId]
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === e.agentId && sessions[id].status !== 'closed') {
          sessions[id] = { ...sessions[id], status: 'closed', activeTurn: false, openTurnId: null }
          affected.push(id)
        }
      }
      return {
        agentStatus,
        pendingAuth,
        sessions,
        pendingPermissions: dropPermissionsForAgent(s.pendingPermissions, e.agentId)
      }
    })
    // Persist the closed status for each session the disconnect affected, so the
    // history index reflects it across restarts (mirrors _onSessionClosed).
    for (const id of affected) {
      persistSession(get(), id, (entries) => set({ sessionIndex: entries }))
    }
  },

  _onSessionClosed: (e) => {
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
    acpApi.onEvent<AuthRequiredEvent>(ACP_EVENTS.authRequired, (e) => {
      useAcpStore.getState()._onAuthRequired(e)
      toast.warning(
        e.message
          ? `Authentication required: ${e.message}`
          : 'This agent requires authentication to continue.'
      )
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
  const configId = Object.keys(state.configToLiveAgent).find(
    (cid) => state.configToLiveAgent[cid] === agentId
  )
  const config = configId ? state.agentConfigs.find((c) => c.id === configId) : undefined
  return { name: config?.name ?? null, templateId: config?.templateId ?? null }
}

export const useAgentIdentity = (agentId: AgentId | null): AgentIdentity =>
  useAcpStore(useShallow((s) => selectAgentIdentity(s, agentId)))
