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
import { create } from 'zustand'
import { toast } from 'sonner'
import {
  acpApi,
  ACP_EVENTS,
  type AgentId,
  type SessionId,
  type AgentCapabilities,
  type ContentBlock,
  type SessionMode,
  type SessionModeState,
  type SessionConfigOption,
  type ToolCall,
  type PlanEntry,
  type AvailableCommand,
  type PermissionOption,
  type StopReason,
  type AgentSpawnedEvent,
  type SessionCreatedEvent,
  type MessageChunkEvent,
  type ToolCallEvent,
  type ToolCallUpdateEvent,
  type PlanUpdateEvent,
  type CommandsUpdateEvent,
  type ModeUpdateEvent,
  type ConfigOptionsUpdateEvent,
  type PermissionRequestEvent,
  type PromptCompleteEvent,
  type AgentErrorEvent,
  type AgentDisconnectedEvent,
  type SessionClosedEvent,
  type McpServer
} from '@/lib/acp-api'

export type AgentStatus = 'idle' | 'spawning' | 'connected' | 'error'
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
  status: SessionStatus
  title: string | null
  activeTurn: boolean
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

  // Actions — conversation
  sendPrompt: (sessionId: SessionId, text: string) => Promise<void>
  cancelPrompt: (sessionId: SessionId) => Promise<void>

  // Actions — config (P2 drives the UI; method available now)
  setConfigOption: (sessionId: SessionId, configId: string, valueId: string) => Promise<void>
  setMode: (sessionId: SessionId, modeId: string) => Promise<void>

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

export const useAcpStore = create<AcpState>((set, get) => ({
  agents: {},
  agentStatus: {},
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
      set((s) => ({
        agents: { ...s.agents, [agentId]: { id: agentId, capabilities: null } },
        agentStatus: { ...s.agentStatus, [agentId]: 'connected' }
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
      delete agents[agentId]
      delete agentStatus[agentId]
      // mark this agent's sessions closed
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === agentId) {
          sessions[id] = { ...sessions[id], status: 'closed', activeTurn: false }
        }
      }
      return {
        agents,
        agentStatus,
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
            status: existing?.status === 'closed' ? 'closed' : 'active',
            title: existing?.title ?? null,
            activeTurn: existing?.activeTurn ?? false,
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
        sessions[sessionId] = { ...sessions[sessionId], status: 'closed', activeTurn: false }
      }
      return {
        sessions,
        pendingPermissions: dropPermissionsForSession(s.pendingPermissions, sessionId)
      }
    })
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  sendPrompt: async (sessionId, text) => {
    const session = get().sessions[sessionId]
    if (!session) throw new Error(`unknown session ${sessionId}`)
    if (session.status === 'closed') throw new Error('session is closed')
    if (session.activeTurn) throw new Error('a prompt turn is already in progress')
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
      sessions: { ...s.sessions, [sessionId]: { ...s.sessions[sessionId], activeTurn: true, lastError: null } }
    }))
    try {
      const stopReason = await acpApi.sendPrompt(session.agentId, sessionId, text)
      // The resolved StopReason is authoritative completion. Finalize here even
      // if no prompt_complete event arrives, so the turn can never get stuck.
      // Idempotent with _onPromptComplete.
      set((s) => {
        const current = s.sessions[sessionId]
        if (!current) return {}
        const note = noteForStopReason(stopReason)
        return {
          messages: finalizeStreaming(s.messages, sessionId),
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...current,
              activeTurn: false,
              lastError: note ?? current.lastError
            }
          }
        }
      })
    } catch (err) {
      set((s) => ({
        messages: finalizeStreaming(s.messages, sessionId),
        sessions: {
          ...s.sessions,
          [sessionId]: { ...s.sessions[sessionId], activeTurn: false, lastError: String(err) }
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

  // --- Event reducers ------------------------------------------------------

  _onAgentSpawned: (e) =>
    set((s) => ({
      agents: { ...s.agents, [e.agentId]: { id: e.agentId, capabilities: e.capabilities } },
      agentStatus: { ...s.agentStatus, [e.agentId]: 'connected' }
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
            status: 'active',
            title: null,
            activeTurn: false,
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
      // Attach to the trailing streaming message of the same role.
      if (last && last.role === e.role && last.streaming) {
        const updated: ChatMessage = { ...last, blocks: appendBlocks(last.blocks, e.content) }
        return { messages: { ...s.messages, [e.sessionId]: [...list.slice(0, -1), updated] } }
      }
      // Don't resurrect a finalized turn: only start a NEW streaming message when
      // a turn is actually active (guards against late chunks after completion).
      if (!session.activeTurn) return {}
      // Ignore an empty leading text chunk (avoids a flashing empty bubble).
      if (e.content.type === 'text' && !(e.content.text ?? '').length) return {}
      const message: ChatMessage = {
        id: newId('msg'),
        role: e.role,
        blocks: [e.content],
        streaming: true,
        timestamp: Date.now()
      }
      return { messages: { ...s.messages, [e.sessionId]: [...list, message] } }
    }),

  _onToolCall: (e) =>
    set((s) => ({
      toolCalls: { ...s.toolCalls, [e.sessionId]: [...(s.toolCalls[e.sessionId] ?? []), e.toolCall] }
    })),

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

  _onPromptComplete: (e) =>
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
            activeTurn: false,
            lastError: note ?? session.lastError
          }
        }
      }
    }),

  _onAgentError: (e) =>
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      if (e.sessionId && s.sessions[e.sessionId]) {
        return {
          agentStatus,
          sessions: {
            ...s.sessions,
            [e.sessionId]: { ...s.sessions[e.sessionId], lastError: e.message, activeTurn: false }
          }
        }
      }
      return { agentStatus }
    }),

  _onAgentDisconnected: (e) =>
    set((s) => {
      const agentStatus = { ...s.agentStatus, [e.agentId]: 'error' as AgentStatus }
      const sessions = { ...s.sessions }
      for (const id of Object.keys(sessions)) {
        if (sessions[id].agentId === e.agentId && sessions[id].status !== 'closed') {
          sessions[id] = { ...sessions[id], status: 'closed', activeTurn: false }
        }
      }
      return {
        agentStatus,
        sessions,
        pendingPermissions: dropPermissionsForAgent(s.pendingPermissions, e.agentId)
      }
    }),

  _onSessionClosed: (e) =>
    set((s) => {
      const session = s.sessions[e.sessionId]
      const pendingPermissions = dropPermissionsForSession(s.pendingPermissions, e.sessionId)
      if (!session) return { pendingPermissions }
      return {
        pendingPermissions,
        sessions: { ...s.sessions, [e.sessionId]: { ...session, status: 'closed', activeTurn: false } }
      }
    })
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
  const s = useAcpStore.getState()
  teardown = [
    acpApi.onEvent<AgentSpawnedEvent>(ACP_EVENTS.agentSpawned, s._onAgentSpawned),
    acpApi.onEvent<SessionCreatedEvent>(ACP_EVENTS.sessionCreated, s._onSessionCreated),
    acpApi.onEvent<MessageChunkEvent>(ACP_EVENTS.messageChunk, s._onMessageChunk),
    acpApi.onEvent<ToolCallEvent>(ACP_EVENTS.toolCall, s._onToolCall),
    acpApi.onEvent<ToolCallUpdateEvent>(ACP_EVENTS.toolCallUpdate, s._onToolCallUpdate),
    acpApi.onEvent<PlanUpdateEvent>(ACP_EVENTS.planUpdate, s._onPlanUpdate),
    acpApi.onEvent<CommandsUpdateEvent>(ACP_EVENTS.commandsUpdate, s._onCommandsUpdate),
    acpApi.onEvent<ModeUpdateEvent>(ACP_EVENTS.modeUpdate, s._onModeUpdate),
    acpApi.onEvent<ConfigOptionsUpdateEvent>(ACP_EVENTS.configOptionsUpdate, s._onConfigOptionsUpdate),
    acpApi.onEvent<PermissionRequestEvent>(ACP_EVENTS.permissionRequest, s._onPermissionRequest),
    acpApi.onEvent<PromptCompleteEvent>(ACP_EVENTS.promptComplete, s._onPromptComplete),
    acpApi.onEvent<AgentErrorEvent>(ACP_EVENTS.agentError, (e) => {
      s._onAgentError(e)
      toast.error(e.message || 'Agent error')
    }),
    acpApi.onEvent<AgentDisconnectedEvent>(ACP_EVENTS.agentDisconnected, s._onAgentDisconnected),
    acpApi.onEvent<SessionClosedEvent>(ACP_EVENTS.sessionClosed, s._onSessionClosed)
  ]
  return () => {
    teardown.forEach((fn) => fn())
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
