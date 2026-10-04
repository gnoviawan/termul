/**
 * ACP agent chat store.
 *
 * Holds configured agents, active sessions, and per-session conversation state.
 * All backend access goes through `@/lib/acp-api`. Backend events are wired into
 * this store exactly once via `initAcpEventListeners()` (called at app mount).
 *
 * P1 scope: text conversations. `toolCalls`, `plans`, `commands`,
 * `pendingPermissions`, and config/mode state are tracked here; tool, plan,
 * permission, and slash-command UI render them when present.
 *
 * ## Architecture D6 reconciliation (Story 1.5)
 *
 * Architecture asked for "`acp-store`: single-session per tab" **without** a
 * store refactor. This store remains intentionally **global multi-session**
 * (`sessions: Record<SessionId, …>` + `activeSessionId`). D6's "one focused
 * session per browser tab" is honored by the external tab↔session mapping in
 * `@/lib/web-tab-session` (sessionStorage per tab), not by reshaping Zustand
 * to a single-session store.
 *
 * `activeSessionId` is an in-process UI convenience (especially desktop /
 * prepared-chat reaping) and is **not** a cross-tab isolation boundary.
 *
 * ## Layout (spec-04 PR B)
 *
 * Composition root: composes the domain slices in ./slices via
 * `createAgentSlice` etc., and keeps the transport wiring, event-listener
 * bootstrap, and selector hooks that need the composed `useAcpStore`.
 * `./shared-state` holds module singletons shared by more than one slice;
 * `./types` the `AcpState` contract; `./helpers` the pure helpers.
 */

import type {
  ProjectSwitchCompletedEvent,
  ProjectSwitchFailedEvent
} from '@shared/types/web-projects.types'
import { toast } from 'sonner'
import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { stripHandoffPreamble } from '@/components/chat/handoff-summary'
import {
  ACP_EVENTS,
  type AgentCrashedEvent,
  type AgentDisconnectedEvent,
  type AgentErrorEvent,
  type AgentId,
  type AgentSpawnedEvent,
  type AgentSwitchEvent,
  type AskUserQuestionEvent,
  acpApi,
  type BrowserAgentTabEvent,
  type BrowserConsentRequestEvent,
  type BrowserOpenRequestEvent,
  type CommandsUpdateEvent,
  type ConfigOptionsUpdateEvent,
  type ContentBlock,
  type MessageChunkEvent,
  type ModeUpdateEvent,
  type PermissionRequestEvent,
  type PlanUpdateEvent,
  type PromptCompleteEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionId,
  type SessionInfoUpdateEvent,
  type SessionUsage,
  type ToolCall,
  type ToolCallEvent,
  type ToolCallUpdate,
  type ToolCallUpdateEvent,
  type UsageUpdateEvent,
  type UserPromptEvent
} from '@/lib/acp-api'
import { AcpConnectionCoordinator, type AcpRecovery } from '@/lib/acp-connection'
import { getAcpTransport, isTransientAcpTransportError } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { wireBlocksToDisplay } from '@/lib/skills-wire-reverse'
import { setTabFocusedSessionId } from '@/lib/web-tab-session'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { QueuedPrompt } from '../prompt-queue-orchestration'
import {
  collectProjectsWithActiveAgentChat,
  dropHiddenToolCalls,
  dropRecordKey,
  normalizeUserMessages,
  partitionTranscriptTurns,
  selectAgentIdentity,
  selectConfigWarmState,
  trimLiveToolCalls
} from './helpers'
import {
  historySeqWatermarks,
  isCurrentRecoveryGeneration,
  rebaseSeqCounter,
  sessionReopenGenerations
} from './shared-state'
import { createAgentSlice } from './slices/agent'
import { createConfigSlice } from './slices/config'
import { createLaunchSlice } from './slices/launch'
import { createMcpSlice } from './slices/mcp'
import { createMiscSlice } from './slices/misc'
import { createPromptSlice } from './slices/prompt'
import { createSessionSlice } from './slices/session'
import { createSwitchSlice } from './slices/switch'
import { appendBlocks, createTranscriptSlice } from './slices/transcript'
import type {
  AcpSession,
  AcpState,
  AgentIdentity,
  ChatMessage,
  ConfigWarmState,
  MessageRole
} from './types'

export {
  agentReuseKey,
  configIdFromReuseKey
} from '../acp-reuse-keys'
export type { QueuedPrompt } from '../prompt-queue-orchestration'
export * from './helpers'
// Test + cross-module helpers living beside the slices (spec-04 PR B).
export {
  _acceptedServerPromptTurnIdsForTesting,
  _addEphemeralSessionIdForTesting,
  _handoffOnlyTurnIdsForTesting,
  _resetAcceptedServerPromptTurnIdsForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightPreparedForTesting,
  _resetInFlightPromotionsForTesting,
  _resetLiveSwitchSourcesForTesting,
  isEphemeralAcpSession,
  persistComposerOptions
} from './shared-state'
export { _resetAcpAuthForTesting } from './slices/agent'
export {
  _resetInFlightHistoryOpensForTesting,
  _resetSessionIndexLoadGenerationForTesting
} from './slices/session'
export {
  _flushCoalescedForTesting,
  _isCoalescePendingForTesting,
  _resetBackfillForTesting,
  _resetCoalesceForTesting,
  _resetLoadingOlderForTesting
} from './slices/transcript'
export * from './types'

// --- Store ------------------------------------------------------------------

export const useAcpStore = create<AcpState>()((...a) => ({
  ...createAgentSlice(...a),
  ...createConfigSlice(...a),
  ...createSessionSlice(...a),
  ...createLaunchSlice(...a),
  ...createTranscriptSlice(...a),
  ...createPromptSlice(...a),
  ...createSwitchSlice(...a),
  ...createMcpSlice(...a),
  ...createMiscSlice(...a)
}))

// --- Event listener wiring (called once at app mount) ----------------------

let listenersInitialized = false

let teardown: Array<() => void> = []

/**
 * Subscribe the store to all ACP backend events. Idempotent: a second call is a
 * no-op until the returned teardown runs. Returns a teardown that detaches all
 * listeners.
 */
async function installTransportRecovery(
  recovery: AcpRecovery,
  reopenGeneration?: number
): Promise<void> {
  // Round-2 review: the WS transport captures the session's reopen generation
  // before the recovery round-trip; a close, delete, or reopen in that window
  // invalidates it. A late recovery must not resurrect a torn-down or
  // replaced session. `undefined` (no provider wired — desktop IPC or direct
  // test drives) keeps the unguarded path.
  const recoveryIsCurrent = (): boolean =>
    reopenGeneration === undefined ||
    isCurrentRecoveryGeneration(recovery.sessionId, reopenGeneration)
  if ('degraded' in recovery) {
    if (!recoveryIsCurrent()) return
    useAcpStore.setState((state) => {
      const session = state.sessions[recovery.sessionId]
      return {
        degradedRecoverySessions: {
          ...state.degradedRecoverySessions,
          [recovery.sessionId]: true
        },
        sessions: session
          ? {
              ...state.sessions,
              [recovery.sessionId]: {
                ...session,
                lastError:
                  'Connection recovered live-only; events emitted while disconnected may be missing.'
              }
            }
          : state.sessions
      }
    })
    void logFrontendError({
      level: 'warn',
      source: 'acp.recovery',
      message: `Live-only stale recovery for session ${recovery.sessionId} is degraded`
    })
    return
  }

  // Fold the raw snapshot events into bubbles with the same dialect the
  // server's `get_session_payload` materializer uses (`snapshot:<role>:
  // <firstSeq>`, `turn:<turnId>`): consecutive same-role chunks coalesce into
  // the trailing bubble (`appendBlocks` semantics); a role change, tool_call,
  // or prompt_complete closes the run. One message per raw chunk would render
  // the spliced/duplicated blocks from the QA reconnect repro, and restored
  // bubbles must never stream (stuck cursor). Divergence from the host fold:
  // a `role: "user"` chunk (the agent re-streaming the accepted prompt) opens
  // a USER bubble here, not an agent bubble — the recovery install replaces
  // (never merges with) a payload install, and its seq watermark dedupes live
  // events, so the differing id dialect never crosses paths with the
  // materializer's.
  const messages: ChatMessage[] = []
  // Tool cards recovered from the snapshot's tool_call/tool_call_update
  // records — installed alongside the bubbles so reconnect recovery preserves
  // cards instead of blanking the session's tool-call list.
  const recoveredToolCalls: ToolCall[] = []
  let openRole: 'agent' | 'thought' | 'user' | null = null
  for (const event of recovery.events) {
    const payload = event.payload as Record<string, unknown>
    if (event.type === 'user_prompt') {
      openRole = null
      // Server materializer dialect: `turn:<turnId>`, falling back to
      // `user:seq-<seq>` when the record carries no (non-empty) turn id — the
      // ids double as backfill/dedup anchors against payload installs.
      const rawTurnId = payload.turnId
      const turnId = typeof rawTurnId === 'string' && rawTurnId.length > 0 ? rawTurnId : null
      const rawTurnBlocks = Array.isArray(payload.content)
        ? (payload.content as ContentBlock[])
        : []
      // spec-agent-switch-separator-redesign: a pre-fix handoff record stored
      // the wire framing (summary + `---` + draft); strip the preamble so the
      // replayed bubble shows only the draft. A summary-only record's first
      // block returns null — drop THE BLOCK; the row vanishes only when no
      // attachment blocks follow.
      const firstText = rawTurnBlocks[0]?.type === 'text' ? rawTurnBlocks[0].text : undefined
      const stripped = typeof firstText === 'string' ? stripHandoffPreamble(firstText) : undefined
      const keptBlocks = stripped === null ? rawTurnBlocks.slice(1) : rawTurnBlocks
      const blocks = wireBlocksToDisplay(
        typeof stripped === 'string' && stripped !== firstText
          ? [{ type: 'text', text: stripped }, ...keptBlocks.slice(1)]
          : keptBlocks
      )
      if (blocks.length === 0 && stripped === null) {
        // Summary-only handoff: a boundary row, not a bubble — the turn's
        // reply stays visible (a switch turn is real, not a hidden greeting).
        messages.push({
          id: turnId ? `turn:${turnId}` : `user:seq-${event.seq}`,
          role: 'user',
          blocks: [],
          streaming: false,
          timestamp: Date.now(),
          seq: event.seq,
          handoffBoundary: true
        })
        continue
      }
      const message: ChatMessage = {
        id: turnId ? `turn:${turnId}` : `user:seq-${event.seq}`,
        role: 'user',
        blocks,
        streaming: false,
        timestamp: Date.now(),
        seq: event.seq
      }
      messages.push(message)
    } else if (event.type === 'message_chunk') {
      const role = (
        payload.role === 'thought' ? 'thought' : payload.role === 'user' ? 'user' : 'agent'
      ) as MessageRole
      const content = payload.content as ContentBlock | null | undefined
      if (!content) continue
      const last = messages[messages.length - 1]
      if (openRole === role && last && last.role === role) {
        // Accumulate RAW (wire) text: a user prompt's framing may split across
        // several re-streamed chunks, and the reconstruction only parses the
        // fully-joined text — the single post-fold pass below normalizes each
        // completed user bubble once.
        messages[messages.length - 1] = {
          ...last,
          blocks: appendBlocks(last.blocks, content)
        }
        continue
      }
      // An empty text chunk never opens a bubble (mirrors the materializer).
      if (content.type === 'text' && !(content.text ?? '').length) continue
      openRole = role
      const message: ChatMessage = {
        id: `snapshot:${role}:${event.seq}`,
        role,
        blocks: [content],
        streaming: false,
        timestamp: Date.now(),
        seq: event.seq
      }
      messages.push(message)
    } else if (event.type === 'tool_call') {
      // Split boundary: the following chunk run opens a fresh bubble.
      openRole = null
      const toolCall = payload.toolCall as ToolCall | undefined
      if (!toolCall || typeof toolCall.toolCallId !== 'string') continue
      const stamped: ToolCall = {
        ...toolCall,
        timestamp: typeof toolCall.timestamp === 'number' ? toolCall.timestamp : Date.now(),
        // The envelope seq is the server record seq: timeline placement and
        // hidden-turn attribution match the recovered bubbles.
        seq: typeof toolCall.seq === 'number' ? toolCall.seq : event.seq
      }
      // Upsert by toolCallId (mirrors `_onToolCall`): a re-emitted call keeps
      // its original timeline placement while the latest fields win.
      const idx = recoveredToolCalls.findIndex((t) => t.toolCallId === stamped.toolCallId)
      if (idx === -1) {
        recoveredToolCalls.push(stamped)
      } else {
        recoveredToolCalls[idx] = {
          ...recoveredToolCalls[idx],
          ...stamped,
          timestamp: recoveredToolCalls[idx].timestamp,
          seq: recoveredToolCalls[idx].seq
        }
      }
    } else if (event.type === 'tool_call_update') {
      // Not a run-split boundary. Fold the update into the recovered card
      // (mirrors `_onToolCallUpdate`'s merge-by-id; unknown ids are dropped).
      const update = payload.update as ToolCallUpdate | undefined
      if (!update || typeof update.toolCallId !== 'string') continue
      const idx = recoveredToolCalls.findIndex((t) => t.toolCallId === update.toolCallId)
      if (idx === -1) continue
      recoveredToolCalls[idx] = { ...recoveredToolCalls[idx], ...update }
    } else if (event.type === 'prompt_complete') {
      // Split boundary: the following chunk run opens a fresh bubble.
      openRole = null
    }
  }
  // Single wire→display pass over the folded user bubbles (chip rendering on
  // resume): the fold above accumulated RAW wire text so a user prompt split
  // across re-streamed chunks reconstructs from its fully-joined text.
  const normalizedMessages = normalizeUserMessages(messages)
  // The snapshot is the authoritative pre-reconnect transcript: hidden /
  // pre-first-user-prompt turns never render, and the watermark seq-dedupes
  // live events the snapshot already covers. Rebase the local seq counter so
  // live events appended afterwards sort after the snapshot (its message seqs
  // are server record seqs, potentially far above the local counter).
  const { visible, hidden } = partitionTranscriptTurns(normalizedMessages)
  const installedMessages =
    visible.length === normalizedMessages.length ? normalizedMessages : visible
  // Reject the late snapshot BEFORE installing the watermark/transcript: the
  // session may have been torn down or replaced while the snapshot was in
  // flight (captured generation no longer matches).
  if (!recoveryIsCurrent()) return
  historySeqWatermarks.set(recovery.sessionId, recovery.watermark)
  rebaseSeqCounter(recovery.watermark)
  useAcpStore.setState((current) => {
    // Re-check at commit time, alongside the acceptsSessionTranscriptEvents
    // gating used by the live-event reducers, so a generation flip racing
    // this install can never resurrect the old session incarnation.
    if (!recoveryIsCurrent()) return {}
    const session = current.sessions[recovery.sessionId]
    const replacing = normalizedMessages.length > 0
    return {
      messages: replacing
        ? { ...current.messages, [recovery.sessionId]: installedMessages }
        : current.messages,
      toolCalls: replacing
        ? {
            ...current.toolCalls,
            [recovery.sessionId]: trimLiveToolCalls(
              dropHiddenToolCalls(recoveredToolCalls, installedMessages, hidden)
            )
          }
        : current.toolCalls,
      degradedRecoverySessions: dropRecordKey(current.degradedRecoverySessions, recovery.sessionId),
      sessions: session
        ? {
            ...current.sessions,
            [recovery.sessionId]: { ...session, lastError: null }
          }
        : current.sessions
    }
  })
}

/** Test-only: drive the transport recovery path without wiring listeners. */
export const _installTransportRecoveryForTesting = installTransportRecovery

export function initAcpEventListeners(): () => void {
  if (listenersInitialized) {
    return () => {
      /* already initialized elsewhere; the owning caller tears down */
    }
  }
  listenersInitialized = true
  // Story 5.3 (AC3): register the WS reconnect listener so the store's
  // `transportReconnecting` flag flips when the WS transport drops/reconnects.
  // The flag drives the non-blocking `AgentConnectionLamp` overlay in
  // `AgentChatPanel`. On Tauri desktop, the transport is IPC-based (no
  // `setReconnectListener` method), so this is a no-op there — the flag stays
  // `false`. The listener is idempotent: re-registration overwrites the
  // previous callback.
  const transport = getAcpTransport()
  let historyRetryTimer: ReturnType<typeof setTimeout> | null = null
  let historyRetryAttempt = 0
  let historyTornDown = false
  const refetchHistoryAfterReconnect = (): void => {
    const run = (): void => {
      if (historyTornDown) return
      void useAcpStore
        .getState()
        .loadSessionIndex()
        .then(() => undefined)
        .catch((error) => {
          if (historyTornDown) return
          if (!isTransientAcpTransportError(error) || historyRetryAttempt >= 3) {
            void logFrontendError({
              level: 'warn',
              source: 'acp-store.reconnectHistoryRefresh',
              message: `ACP history refresh after reconnect failed: ${String(error)}`
            })
            return
          }
          const delay = Math.min(500 * 2 ** historyRetryAttempt, 2_000)
          historyRetryAttempt += 1
          historyRetryTimer = setTimeout(() => {
            historyRetryTimer = null
            run()
          }, delay)
        })
    }
    if (historyRetryTimer) return
    run()
  }
  const connection = new AcpConnectionCoordinator(transport, {
    installRecovery: installTransportRecovery,
    // The transport captures this before the snapshot round-trip so a late
    // recovery for a torn-down/replaced session is rejected at install.
    recoveryGeneration: (sessionId) => sessionReopenGenerations.get(sessionId) ?? 0,
    pendingPermissionSessions: () => [
      ...new Set(
        Object.values(useAcpStore.getState().pendingPermissions).map(
          (permission) => permission.sessionId
        )
      )
    ],
    setReconnecting: (reconnecting) => {
      useAcpStore.setState({ transportReconnecting: reconnecting })
      if (!reconnecting) {
        if (historyRetryTimer) {
          clearTimeout(historyRetryTimer)
          historyRetryTimer = null
        }
        historyRetryAttempt = 0
        refetchHistoryAfterReconnect()
      }
    }
  })
  connection.attach()
  const applyCompletedProjectSwitch = (event: ProjectSwitchCompletedEvent): void => {
    const state = useAcpStore.getState()
    const previous = state.sessions[event.previousSessionId]
    if (!previous) return
    // Queued switch-back restore (parity with switchProject's immediate-reopen
    // branch): if the server reopened an existing session (detected via the
    // server history index), fetch its transcript via `openHistorySession` +
    // focus the workspace tab (`addAgentChatTab`) instead of minting a blank
    // session. The transcript load is fire-and-forget (the event handler is
    // void) — the restore preload shows immediately. Else the blank path below.
    if (state.sessionIndex.some((e) => e.id === event.sessionId)) {
      const opening = state.openHistorySession(event.sessionId)
      useWorkspaceStore.getState().addAgentChatTab(event.sessionId)
      useAcpStore.setState({
        queuedProjectSwitchId: null,
        activeSessionId: event.sessionId
      })
      setTabFocusedSessionId(event.sessionId)
      useProjectStore.getState().selectProject(event.projectId)
      void opening
      return
    }
    useAcpStore.setState((s) => {
      const existing = s.sessions[event.sessionId]
      return {
        queuedProjectSwitchId: null,
        failedProjectSwitchId: null,
        activeSessionId: event.sessionId,
        sessions: {
          ...s.sessions,
          [event.sessionId]: {
            id: event.sessionId,
            agentId: previous.agentId,
            cwd: event.cwd,
            projectId: event.projectId,
            status: 'active',
            title: existing?.title ?? previous.title,
            activeTurn: false,
            mcpServerCount: event.mcpServerCount,
            openTurnId: null,
            modes: existing?.modes ?? previous.modes,
            models: existing?.models ?? previous.models ?? null,
            configOptions: existing?.configOptions ?? previous.configOptions,
            lastError: existing?.lastError ?? null,
            createdAt: existing?.createdAt ?? Date.now(),
            replaying: null
          }
        },
        messages: { ...s.messages, [event.sessionId]: s.messages[event.sessionId] ?? [] }
      }
    })
    setTabFocusedSessionId(event.sessionId)
    useProjectStore.getState().selectProject(event.projectId)
  }
  const applyFailedProjectSwitch = (event: ProjectSwitchFailedEvent): void => {
    const state = useAcpStore.getState()
    if (state.queuedProjectSwitchId !== event.projectId) return
    useAcpStore.setState({
      queuedProjectSwitchId: null,
      failedProjectSwitchId: event.projectId
    })
    toast.error(event.message || 'Project switch failed')
  }
  teardown = [
    transport.onEvent<ProjectSwitchCompletedEvent>(
      'project_switch_completed',
      applyCompletedProjectSwitch
    ),
    transport.onEvent<ProjectSwitchFailedEvent>('project_switch_failed', applyFailedProjectSwitch),
    acpApi.onEvent<AgentSpawnedEvent>(ACP_EVENTS.agentSpawned, (e) =>
      useAcpStore.getState()._onAgentSpawned(e)
    ),
    acpApi.onEvent<SessionCreatedEvent>(ACP_EVENTS.sessionCreated, (e) =>
      useAcpStore.getState()._onSessionCreated(e)
    ),
    acpApi.onEvent<UserPromptEvent>(ACP_EVENTS.userPrompt, (e, eventSeq) =>
      useAcpStore.getState()._onUserPrompt(e, eventSeq)
    ),
    acpApi.onEvent<MessageChunkEvent>(ACP_EVENTS.messageChunk, (e, eventSeq) =>
      useAcpStore.getState()._onMessageChunk(e, eventSeq)
    ),
    acpApi.onEvent<ToolCallEvent>(ACP_EVENTS.toolCall, (e, eventSeq) =>
      useAcpStore.getState()._onToolCall(e, eventSeq)
    ),
    acpApi.onEvent<ToolCallUpdateEvent>(ACP_EVENTS.toolCallUpdate, (e, eventSeq) =>
      useAcpStore.getState()._onToolCallUpdate(e, eventSeq)
    ),
    acpApi.onEvent<AgentSwitchEvent>(ACP_EVENTS.agentSwitch, (e, eventSeq) =>
      useAcpStore.getState()._onAgentSwitch(e, eventSeq)
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
    acpApi.onEvent<SessionInfoUpdateEvent>(ACP_EVENTS.sessionInfoUpdate, (e) =>
      useAcpStore.getState()._onSessionInfoUpdate(e)
    ),
    acpApi.onEvent<UsageUpdateEvent>(ACP_EVENTS.usageUpdate, (e) =>
      useAcpStore.getState()._onUsageUpdate(e)
    ),
    acpApi.onEvent<PermissionRequestEvent>(ACP_EVENTS.permissionRequest, (e, eventSeq) =>
      useAcpStore.getState()._onPermissionRequest(e, eventSeq)
    ),
    acpApi.onEvent<AskUserQuestionEvent>(ACP_EVENTS.questionRequest, (e, eventSeq) =>
      useAcpStore.getState()._onQuestionRequest(e, eventSeq)
    ),
    acpApi.onEvent<PromptCompleteEvent>(ACP_EVENTS.promptComplete, (e, eventSeq) =>
      useAcpStore.getState()._onPromptComplete(e, eventSeq)
    ),
    acpApi.onEvent<AgentCrashedEvent>(ACP_EVENTS.agentCrashed, (e) => {
      useAcpStore.getState()._onAgentCrashed(e)
      toast.error(e.message || 'Agent crashed')
    }),
    acpApi.onEvent<AgentErrorEvent>(ACP_EVENTS.agentError, (e) => {
      useAcpStore.getState()._onAgentError(e)
      toast.error(e.message || 'Agent error')
    }),
    acpApi.onEvent<AgentDisconnectedEvent>(ACP_EVENTS.agentDisconnected, (e) =>
      useAcpStore.getState()._onAgentDisconnected(e)
    ),
    acpApi.onEvent<SessionClosedEvent>(ACP_EVENTS.sessionClosed, (e) =>
      useAcpStore.getState()._onSessionClosed(e)
    ),
    acpApi.onEvent<BrowserOpenRequestEvent>(ACP_EVENTS.browserOpenRequest, (e) =>
      useAcpStore.getState()._onBrowserOpenRequest(e)
    ),
    acpApi.onEvent<BrowserAgentTabEvent>(ACP_EVENTS.browserAgentTab, (e) =>
      useAcpStore.getState()._onBrowserAgentTab(e)
    ),
    acpApi.onEvent<BrowserConsentRequestEvent>(ACP_EVENTS.browserConsentRequest, (e) =>
      useAcpStore.getState()._onBrowserConsentRequest(e)
    )
  ]
  return () => {
    historyTornDown = true
    if (historyRetryTimer) {
      clearTimeout(historyRetryTimer)
      historyRetryTimer = null
    }
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

const EMPTY_PROMPT_QUEUE: QueuedPrompt[] = []

export const usePromptQueue = (sessionId: SessionId | null): QueuedPrompt[] =>
  useAcpStore((s) =>
    sessionId ? (s.promptQueues[sessionId] ?? EMPTY_PROMPT_QUEUE) : EMPTY_PROMPT_QUEUE
  )

export const useSessionUsage = (sessionId: SessionId | null): SessionUsage | null =>
  useAcpStore((s) => (sessionId ? (s.sessionUsage[sessionId] ?? null) : null))

export const useSessionIndexTitle = (sessionId: SessionId | null): string | null =>
  useAcpStore((s) =>
    sessionId ? (s.sessionIndex.find((e) => e.id === sessionId)?.title ?? null) : null
  )

const EMPTY_MESSAGES: ChatMessage[] = []

export const useAgentIdentity = (agentId: AgentId | null): AgentIdentity =>
  useAcpStore(useShallow((s) => selectAgentIdentity(s, agentId)))

/**
 * Resolve an agent's template id by `agentConfigId` (from a history entry) when
 * the agent isn't live. Falls back to `useAgentIdentity` for live sessions.
 */
export function useAgentTemplateId(agentId: AgentId | null, agentConfigId?: string): string | null {
  return useAcpStore(
    useShallow((s) => {
      if (agentConfigId) {
        const config = s.agentConfigs.find((c) => c.id === agentConfigId)
        if (config?.templateId) return config.templateId
      }
      return selectAgentIdentity(s, agentId).templateId
    })
  )
}

/**
 * Resolve an agent's persisted custom icon (bundled or uploaded) by
 * `agentConfigId` (from a history entry) when the agent isn't live. Falls
 * back to `useAgentIdentity` for live sessions. Returns null when no custom
 * icon is set (the caller should fall back to the bundled catalog).
 */
export function useAgentIcon(agentId: AgentId | null, agentConfigId?: string): string | null {
  return useAcpStore(
    useShallow((s) => {
      if (agentConfigId) {
        const config = s.agentConfigs.find((c) => c.id === agentConfigId)
        if (config?.icon) return config.icon
        // Config found but no icon — short-circuit to null so we don't
        // redundantly scan configToLiveAgent + agentConfigs again via
        // selectAgentIdentity when the result would be the same null.
        if (config) return null
      }
      return selectAgentIdentity(s, agentId).icon
    })
  )
}

export function useProjectsWithActiveAgentChat(): string[] {
  return useAcpStore(useShallow((state) => collectProjectsWithActiveAgentChat(state.sessions)))
}

export const useConfigWarmState = (configId: string): ConfigWarmState =>
  useAcpStore(useShallow((s) => selectConfigWarmState(s, configId)))
