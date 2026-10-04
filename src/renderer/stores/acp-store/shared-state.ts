/**
 * Module-level state shared by >1 acp-store slice (spec-04 PR B).
 * Pure move from acp-store.ts — singletons and helpers that cross slice
 * boundaries live here so no slice imports another slice's internals.
 * Package-internal: index.ts re-exports only the public names.
 */

import { type PersistedComposerOptions, PersistenceKeys } from '@shared/types/persistence.types'
import type { AgentId, SessionId, ToolCall } from '@/lib/acp-api'
import {
  deriveTitle,
  maxPayloadSeq,
  type SessionIndexEntry,
  type SessionPayload
} from '@/lib/acp-history-persistence'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { agentReuseKey, configIdFromReuseKey, detachedReuseKey } from '../acp-reuse-keys'
import { isReusableStatus } from './helpers'
import type { AcpSession, AcpState, ChatMessage, CommitMessageCollector } from './types'

/**
 * Monotonic arrival sequence for timeline ordering. Stamped on every message
 * and tool call as it lands so the UI can interleave the two on one
 * chronological timeline without relying on `Date.now()` (which ties within a
 * millisecond when text and tool events arrive back-to-back).
 */
export let seqCounter = 0

export function nextSeq(): number {
  seqCounter += 1
  return seqCounter
}

/**
 * Monotonic counter for "Untitled Chat N" placeholder titles. Rebased from the
 * persisted index on load (see `rebaseUntitledCounter`) so a restart continues
 * from the highest persisted suffix instead of restarting at 1 and colliding
 * with existing placeholders. Only freshly created sessions without a message
 * consume a number.
 */
export let untitledChatCounter = 0

export function nextUntitledTitle(): string {
  untitledChatCounter += 1
  return `Untitled Chat ${untitledChatCounter}`
}

/** Matches an `Untitled Chat N` placeholder and captures its numeric suffix. */
export const UNTITLED_CHAT_RE = /^Untitled Chat (\d+)$/

/**
 * Lift `untitledChatCounter` to at least the highest `Untitled Chat N` suffix
 * found across the persisted index, so placeholders assigned after a restart
 * never collide with ones already on disk.
 */
export function rebaseUntitledCounter(entries: SessionIndexEntry[]): void {
  let maxSuffix = untitledChatCounter
  for (const entry of entries) {
    const match = UNTITLED_CHAT_RE.exec(entry.title)
    if (match) {
      const n = Number.parseInt(match[1], 10)
      if (Number.isFinite(n) && n > maxSuffix) maxSuffix = n
    }
  }
  untitledChatCounter = maxSuffix
}

/**
 * Rebase the process-wide seq counter so live events appended after a persisted
 * session is reopened sort after the restored history. Without this, the
 * counter (which starts at 0 on every app load) could let `nextSeq()` return a
 * value smaller than an existing restored `seq`, and `buildTimeline` would
 * interleave fresh chunks/tool calls ahead of older history.
 */
export function rebaseSeqCounter(maxSeq: number): void {
  if (maxSeq > seqCounter) seqCounter = maxSeq
}

/**
 * CAP-3 replay contract (web/server-history mode): the highest server event
 * seq covered by the authoritative fetched transcript (`get_session_payload`
 * install or `recover_session_snapshot`) per session. Live events carrying an
 * envelope seq at or below the watermark already render via the payload and
 * are dropped on arrival — the transport's per-session cursor only dedupes
 * within one socket connection and cannot see the payload as a source.
 * Desktop (Tauri IPC) events carry no envelope seq, so the map is never
 * consulted there.
 */
export const historySeqWatermarks = new Map<SessionId, number>()

/**
 * True when a live event's envelope seq is already covered by the installed
 * payload — the payload is the authoritative pre-reconnect transcript, so the
 * event is a replay and must not render twice.
 */
export function isHistoryCoveredEvent(sessionId: SessionId, eventSeq?: number): boolean {
  if (typeof eventSeq !== 'number' || !Number.isFinite(eventSeq) || eventSeq <= 0) return false
  return eventSeq <= (historySeqWatermarks.get(sessionId) ?? 0)
}

/** Record the authoritative history watermark for an installed payload. */
export function noteHistoryWatermark(sessionId: SessionId, payload: SessionPayload): void {
  // `metadata.lastSeq` is the persisted-log cursor and can legitimately exceed
  // every transcript seq (non-transcript records consume seqs) — but a
  // stale-low value must never under-cover the payload's own messages.
  const watermark = Math.max(payload.metadata.lastSeq ?? 0, maxPayloadSeq(payload))
  if (watermark > 0) historySeqWatermarks.set(sessionId, watermark)
  // Keep the local seq counter above the server watermark (the recovery path
  // rebases the same way) so post-install live messages never receive local
  // stamps below the envelope seqs they arrived with.
  rebaseSeqCounter(watermark)
}

/** Test-only: clear per-session history watermarks between tests. */
export function _resetHistorySeqWatermarksForTesting(): void {
  historySeqWatermarks.clear()
}

/**
 * Update the local session-index projection for a session using the current
 * store snapshot (CAP-2: the host event/session layer now authors durable
 * history — the renderer no longer writes payloads). The index entry keeps the
 * desktop sidebar responsive between host refetches; best-effort, never throws.
 */
export function persistSession(
  state: {
    sessions: Record<SessionId, AcpSession>
    messages: Record<SessionId, ChatMessage[]>
    toolCalls: Record<SessionId, ToolCall[]>
    sessionIndex: SessionIndexEntry[]
    configToLiveAgent: Record<string, AgentId>
  },
  sessionId: SessionId,
  setIndex: (entries: SessionIndexEntry[]) => void
): void {
  const session = state.sessions[sessionId]
  if (!session) return
  // Never mirror a mid-replay transcript: while `session/load` is replaying,
  // `messages` holds a partial reconstruction, and projecting it (e.g. via a
  // title update streamed as part of the replay) would truncate the local view
  // until the next host refetch.
  if (session.replaying) return
  // After WebView transcript eviction the map key is absent; skip projection.
  if (!(sessionId in state.messages)) return
  const liveMessages = (state.messages[sessionId] ?? []).map((m) =>
    m.streaming ? { ...m, streaming: false } : m
  )
  const reuseKey = Object.keys(state.configToLiveAgent).find(
    (k) => state.configToLiveAgent[k] === session.agentId
  )
  const agentConfigId = reuseKey ? configIdFromReuseKey(reuseKey) : undefined
  const existingEntry = state.sessionIndex.find((e) => e.id === sessionId)
  // Keep a placeholder stable once assigned: reuse the existing index title
  // (including a prior `Untitled Chat N`) instead of regenerating one on every
  // persist. `rebaseUntitledCounter` keeps fresh numbers from colliding.
  const fallbackTitle = existingEntry?.title ?? nextUntitledTitle()
  const entry: SessionIndexEntry = {
    id: sessionId,
    agentId: session.agentId,
    agentConfigId,
    title: session.title ?? deriveTitle(liveMessages, fallbackTitle),
    cwd: session.cwd,
    projectId: session.projectId,
    createdAt: session.createdAt,
    lastActivityAt: Date.now(),
    messageCount: liveMessages.length,
    lastSeq: liveMessages.reduce(
      (max, m) => Math.max(max, typeof m.seq === 'number' ? m.seq : 0),
      0
    ),
    status: session.status,
    // Preserve the origin flag so a discovered (external) session re-projected
    // here can't lose `discovered: true` and leak into the Termul-only sidebar.
    // Prefer the live-session marker (set by openDiscoveredSession) over the
    // existing index entry, so the disconnect/close path stays correct even when
    // no sessionIndex entry exists yet.
    discovered: session.discovered ?? existingEntry?.discovered ?? false,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    // Story 3 (spec-in-chat-agent-switch): ordered-agent cache. The switch
    // orchestration writes the list at switch completion (see
    // `appendOrderedAgents`); every other persist carries the existing
    // entry's list forward verbatim so a normal persist never drops (or
    // duplicates) the cache. Absent on unswitched chats — `agentConfigId`
    // above stays the session's own historical attribution.
    agents: existingEntry?.agents
  }
  const nextIndex = [entry, ...state.sessionIndex.filter((e) => e.id !== sessionId)]
  setIndex(nextIndex)
}

/**
 * In-flight pre-warm spawns, keyed by `agentReuseKey(configId, cwd)`. Held
 * outside reactive state (promises don't belong in the store) so `prewarmAgent`,
 * `startChat`, and `deleteAgentConfig` can dedupe against a warm that is still
 * spawning for the same config+cwd. The reactive `warmingConfigs` flag mirrors
 * membership for the UI.
 */
export const inFlightWarms = new Map<string, Promise<AgentId | null>>()

/** In-flight `session/new` for a prepare key. */
export const inFlightPrepared = new Map<string, Promise<SessionId | null>>()

/** Test-only: clear module-level prepare dedupe maps between tests. */
export function _resetInFlightPreparedForTesting(): void {
  inFlightPrepared.clear()
}

/**
 * Persist composer selections (model/mode/config) per agent-config-id via
 * `persistenceApi` (debounced). Called from the store setters so running-chatbox
 * selection changes are captured regardless of which surface triggered them.
 * Merges the patch into the existing record (not a full overwrite) so a
 * single-field change (e.g. config) doesn't wipe the persisted model. Skips
 * ephemeral/warm-pool sessions so agent defaults don't overwrite the user's
 * real last selection. Best-effort — a persistence failure logs a warn and
 * does not throw (the selection still applied to the live session).
 *
 * ## Concurrency: per-key serialization
 *
 * Each call does read-merge-write. Without serialization, two concurrent
 * calls (e.g. setModel + setMode firing in the same tick) can both read the
 * same prior record, then the second write overwrites the first's field. The
 * `composerOptionQueues` map chains promises per key so each patch reads the
 * latest in-flight record immediately before writing.
 */
export const composerOptionQueues = new Map<string, Promise<void>>()

export function persistComposerOptions(
  configId: string,
  patch: PersistedComposerOptions,
  sessionId?: SessionId
): void {
  if (sessionId && ephemeralSessionIds.has(sessionId)) return
  const key = PersistenceKeys.lastComposerOptions(configId)
  const prev = composerOptionQueues.get(key) ?? Promise.resolve()
  const next = prev.then(async () => {
    const result = await persistenceApi.read<PersistedComposerOptions>(key)
    const existing = result.success ? (result.data ?? {}) : {}
    const merged: PersistedComposerOptions = { ...existing, ...patch }
    // Deep-merge configValues so a single config change doesn't wipe
    // sibling config values persisted from a prior selection.
    if (existing.configValues && patch.configValues) {
      merged.configValues = { ...existing.configValues, ...patch.configValues }
    }
    // Drop undefined values so the record stays compact and absent fields
    // mean "use agent default" (not "explicitly unset to undefined").
    for (const k of Object.keys(merged) as (keyof PersistedComposerOptions)[]) {
      if (merged[k] === undefined) delete merged[k]
    }
    await persistenceApi.writeDebounced(key, merged)
  })
  composerOptionQueues.set(key, next)
  next.catch((err) => {
    void logFrontendError({
      level: 'warn',
      source: 'acp-store.persistComposerOptions',
      message: `persist failed for ${configId}: ${err instanceof Error ? err.message : String(err)}`
    })
  })
  // Clean up the queue entry once settled to avoid unbounded growth.
  next.finally(() => {
    if (composerOptionQueues.get(key) === next) composerOptionQueues.delete(key)
  })
}

/**
 * Session ids created via `createSession({ ephemeral: true })` (warm-pool seeds)
 * that have NOT yet been promoted to a real chat by `startChat`. Tracked so the
 * disconnect/close handlers can DROP an un-promoted pooled session (never
 * persisted) instead of persisting an orphan "Untitled Chat" to the history
 * index. Removed on promotion (`promotePreparedSession`) and on drop
 * (disconnect/close/liveness-check).
 */
export const ephemeralSessionIds = new Set<string>()

/** True for a warm-pool or other backend-ephemeral session that is not a saved chat. */
export function isEphemeralAcpSession(sessionId: string): boolean {
  return ephemeralSessionIds.has(sessionId)
}

/**
 * In-flight backend `promote_session` calls keyed by session id (story 8).
 * Fired by `promotePreparedSession` when a warm-pool session is claimed;
 * awaited by `runPromptTurn` before dispatching the first prompt so the
 * `user_prompt` lands on a durable (no longer ephemeral) session. Held
 * outside reactive state (promises don't belong in the store). Entries
 * resolve, never reject (a failed promote is warn-logged at fire time).
 */
export const inFlightPromotions = new Map<SessionId, Promise<void>>()

/** Slow-handoff warning threshold for the warm-pool promotion wait. The first
 * prompt waits for the in-flight promotion to SETTLE — dispatching earlier
 * would run the turn while the session is still backend-ephemeral, so a late
 * successful promote would mint durable history missing the first prompt (the
 * prompt path skips `persist_accepted_prompt`, the completion path skips
 * `flush_session`). The wait is bounded by the transport, not this timer (the
 * WS request rejects on socket close and has its own request timeout; the
 * Tauri command errors on a dead agent thread), so crossing this threshold
 * only logs — it never releases the wait. */
export const PROMOTE_SLOW_WARNING_MS = 30_000

export const COMMIT_MESSAGE_TIMEOUT_MS = 60_000

export const COMMIT_MESSAGE_CLEANUP_TIMEOUT_MS = 2_000

export const MAX_COMMIT_MESSAGE_DIFF_CHARS = 120_000

export const MAX_COMMIT_MESSAGE_RESPONSE_CHARS = 20_000

// Inline terminal AI assist (#259) — same one-shot shape as the commit
// generator, but the response is user-facing prose/markdown (larger cap) and
// an agent may legitimately take longer to write an explanation.
export const TERMINAL_ASSIST_TIMEOUT_MS = 90_000

export const TERMINAL_ASSIST_CLEANUP_TIMEOUT_MS = 2_000

export const MAX_TERMINAL_ASSIST_SELECTION_CHARS = 20_000

export const MAX_TERMINAL_ASSIST_RESPONSE_CHARS = 40_000

export const commitMessageCollectors = new Map<SessionId, CommitMessageCollector>()

// Terminal AI assist collectors (#259) — same collector shape, separate map
// so both one-shot flows can be correlated independently by session id.
export const terminalAssistCollectors = new Map<SessionId, CommitMessageCollector>()

export function rejectCommitMessageCollector(sessionId: SessionId, reason: string): void {
  commitMessageCollectors.get(sessionId)?.reject(new Error(reason))
}

export function rejectTerminalAssistCollector(sessionId: SessionId, reason: string): void {
  terminalAssistCollectors.get(sessionId)?.reject(new Error(reason))
}

/** Test-only: clear the ephemeral-session tracking set between tests. */
export function _resetEphemeralSessionIdsForTesting(): void {
  ephemeralSessionIds.clear()
  commitMessageCollectors.clear()
}

/** Test-only: mark a session as ephemeral (warm-pool seed) for persistence-skip tests. */
export function _addEphemeralSessionIdForTesting(sessionId: SessionId): void {
  ephemeralSessionIds.add(sessionId)
}

/** Test-only: clear the in-flight warm-pool promotion map between tests. */
export function _resetInFlightPromotionsForTesting(): void {
  inFlightPromotions.clear()
}

/**
 * Monotonic per-session reopen incarnation. Async load/resume completions may
 * only update the session incarnation that started them.
 */
export const sessionReopenGenerations = new Map<SessionId, number>()

/**
 * Story 3: turn ids of dispatched summary-only handoff prompts (no pending
 * draft). The server's `user_prompt` echo carries the summary wire text; it
 * must NOT render as a user bubble (the summary never renders as a user
 * message — spec CAP-3/CAP-4). `runPromptTurn`'s dispatch closure registers
 * the client-minted turn id; `_onUserPrompt` skips echoes citing it.
 */
export const handoffOnlyTurnIds = new Set<string>()

/**
 * Issue #846: turn ids whose `user_prompt` echo from the server already
 * landed — proof the prompt was ACCEPTED (persist_user_prompt runs before the
 * agent dispatch), so a later transport drop leaves the outcome UNKNOWN, not
 * failed. `runPromptTurn`'s catch consults this before deciding whether the
 * Retry affordance may safely re-send. Entries are cleared once the dispatch
 * settles (either outcome) so the set stays small.
 */
export const acceptedServerPromptTurnIds = new Set<string>()

/** Test-only: read the accepted-turn set (write-only to production code). */
export function _acceptedServerPromptTurnIdsForTesting(): ReadonlySet<string> {
  return acceptedServerPromptTurnIds
}

/** Test-only: clear the accepted-turn set between tests. */
export function _resetAcceptedServerPromptTurnIdsForTesting(): void {
  acceptedServerPromptTurnIds.clear()
}

/**
 * Cancellation tombstones for chat launches whose placeholder was deleted from
 * history while `finalizeChatLaunch`'s `startChat` was still in flight: the
 * user revoked the launch, so the late-arriving session must be torn down
 * (closeSession + deleteHistorySession) instead of merging the deleted chat's
 * transcript into it and sending its prompt. Recorded by `deleteHistorySession`
 * (guarded on the placeholder's launching flag so a post-merge delete cannot
 * leave a stale tombstone) and consumed exactly once by `finalizeChatLaunch`.
 */
export const cancelledChatLaunches = new Set<SessionId>()

export function beginSessionReopen(sessionId: SessionId): number {
  const generation = (sessionReopenGenerations.get(sessionId) ?? 0) + 1
  sessionReopenGenerations.set(sessionId, generation)
  return generation
}

export function invalidateSessionReopen(sessionId: SessionId): void {
  sessionReopenGenerations.set(sessionId, (sessionReopenGenerations.get(sessionId) ?? 0) + 1)
}

export function isCurrentSessionReopen(sessionId: SessionId, generation: number): boolean {
  return sessionReopenGenerations.get(sessionId) === generation
}

/**
 * Generation check for transport recovery. The provider normalizes a
 * never-reopened session to 0, so compare with the same normalization —
 * `isCurrentSessionReopen` would reject generation 0 for untracked ids.
 */
export function isCurrentRecoveryGeneration(sessionId: SessionId, generation: number): boolean {
  return (sessionReopenGenerations.get(sessionId) ?? 0) === generation
}

/**
 * Test-only: the turn ids registered by summary-only handoff dispatches (no
 * direct read access exists — the Set is write-only to production code).
 */
export function _handoffOnlyTurnIdsForTesting(): ReadonlySet<string> {
  return handoffOnlyTurnIds
}

export type EnsureLiveAgentOptions = {
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
export function ensureLiveAgent(
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
  const currentAgentId = get().configToLiveAgent[reuseKey]
  if (
    currentAgentId &&
    Object.values(get().sessions).some(
      (session) =>
        session.agentId === currentAgentId &&
        session.status !== 'closed' &&
        !ephemeralSessionIds.has(session.id)
    )
  ) {
    // One Agent process per Agent chat. Keep this process for its live chat
    // and reserve the canonical key for the next chat.
    set((s) => {
      if (s.configToLiveAgent[reuseKey] !== currentAgentId) return {}
      const configToLiveAgent = { ...s.configToLiveAgent }
      delete configToLiveAgent[reuseKey]
      configToLiveAgent[detachedReuseKey(reuseKey, currentAgentId)] = currentAgentId
      return { configToLiveAgent }
    })
    void logFrontendError({
      level: 'info',
      source: 'acp-store.ensureLiveAgent',
      message: `Detached agent ${currentAgentId} so the next Agent chat gets its own process`
    })
  }
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
        configId,
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
        void logFrontendError({
          level: 'warn',
          source: 'acp-store.ensureLiveAgent',
          message: `Silent spawn failure for config ${configId} (${reuseKey}): ${err instanceof Error ? err.message : String(err)}`
        })
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

/**
 * Live switch target → source session link (spec-agent-switch-live-merged-transcript).
 * `spliceLiveSwitchTranscript` records the pair so an in-session wholesale
 * reinstall on the TARGET (crash retry, direct history open, resume install)
 * can re-splice the pre-switch band afterwards — the durable marker lives on
 * the SOURCE session's log, never the target's, so the reinstall alone would
 * otherwise collapse the merged view for the rest of the app session.
 * Entries clear in `dropSessionTranscriptState` (either endpoint dropped).
 */
export const liveSwitchSources = new Map<SessionId, SessionId>()

/** Test-only: clear live-switch source links between tests. */
export function _resetLiveSwitchSourcesForTesting(): void {
  liveSwitchSources.clear()
}
