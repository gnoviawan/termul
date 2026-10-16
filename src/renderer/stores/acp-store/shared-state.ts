/**
 * Module-level state shared by >1 acp-store slice (spec-04 PR B).
 * Pure move from acp-store.ts — singletons and helpers that cross slice
 * boundaries live here so no slice imports another slice's internals.
 * Package-internal: index.ts re-exports only the public names.
 */

import { type PersistedComposerOptions, PersistenceKeys } from '@shared/types/persistence.types'
import type { WsAgentSummary } from '@shared/types/web-protocol.types'
import { sessionModelSnapshot } from '@/components/chat/chat-input-bar-config'
import type { AgentId, SessionId, ToolCall } from '@/lib/acp-api'
import {
  deriveTitle,
  maxPayloadSeq,
  type SessionIndexEntry,
  type SessionPayload
} from '@/lib/acp-history-persistence'
import { getAcpTransport } from '@/lib/acp-transport'
import { isDefiniteSpawnRejection } from '@/lib/agents/acp-spawn-errors'
import { persistenceApi } from '@/lib/api'
import { __resetCommandEngineForTesting } from '@/lib/command-engine'
import { __clearCommandJournalForTesting } from '@/lib/command-journal'
import { projectForCwd, resolveAgentSpawnEnv } from '@/lib/env-parser'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import {
  agentReuseKey,
  configIdFromReuseKey,
  detachedReuseKey,
  isDetachedReuseKey,
  parseReuseKey
} from '../acp-reuse-keys'
import { ephemeralSessionIds } from './ephemeral-ids'
import { isReusableStatus, SWITCH_SPLICE_ID_PREFIX, type SwitchMarkerFacts } from './helpers'
import type { AcpSession, AcpState, ChatMessage, CommitMessageCollector } from './types'

export { ephemeralSessionIds }

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

/**
 * Per session, the subscribe cursor `attachLiveTurn` lowered to just before the
 * open turn's prompt. The payload only summarizes that turn's tool calls, while
 * the relay replays the turn in full: a covered tool_call/tool_call_update
 * above the floor restores its card. Prompts and chunks stay covered.
 */
const liveTurnReplayFloors = new Map<SessionId, number>()

export function noteLiveTurnReplayFloor(sessionId: SessionId, floor: number): void {
  liveTurnReplayFloors.set(sessionId, floor)
}

export function forgetLiveTurnReplayFloor(sessionId: SessionId): void {
  liveTurnReplayFloors.delete(sessionId)
}

/** The server seq of a covered tool event the attach replay re-delivers, else null. */
export function liveTurnReplaySeq(sessionId: SessionId, eventSeq?: number): number | null {
  const floor = liveTurnReplayFloors.get(sessionId)
  if (floor === undefined || typeof eventSeq !== 'number' || eventSeq <= floor) return null
  return isHistoryCoveredEvent(sessionId, eventSeq) ? eventSeq : null
}

/** A covered tool event, unless the attach replay re-delivers it in full. */
export function isHistoryCoveredToolEvent(sessionId: SessionId, eventSeq?: number): boolean {
  return (
    isHistoryCoveredEvent(sessionId, eventSeq) && liveTurnReplaySeq(sessionId, eventSeq) === null
  )
}

/** Record the authoritative history watermark for an installed payload. */
export function noteHistoryWatermark(sessionId: SessionId, payload: SessionPayload): void {
  // `metadata.lastSeq` is the persisted-log cursor and can legitimately exceed
  // every transcript seq (non-transcript records consume seqs) — but a
  // stale-low value must never under-cover the payload's own messages.
  const watermark = Math.max(payload.metadata.lastSeq ?? 0, maxPayloadSeq(payload))
  if (watermark > 0) historySeqWatermarks.set(sessionId, watermark)
  liveTurnReplayFloors.delete(sessionId)
  // Keep the local seq counter above the server watermark (the recovery path
  // rebases the same way) so post-install live messages never receive local
  // stamps below the envelope seqs they arrived with.
  rebaseSeqCounter(watermark)
}

/** Test-only: clear per-session history watermarks between tests. */
export function _resetHistorySeqWatermarksForTesting(): void {
  historySeqWatermarks.clear()
  liveTurnReplayFloors.clear()
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
  const ownMessages = liveMessages.filter((m) => !m.id.startsWith(SWITCH_SPLICE_ID_PREFIX))
  const reuseKey = Object.keys(state.configToLiveAgent).find(
    (k) => state.configToLiveAgent[k] === session.agentId
  )
  const agentConfigId = reuseKey ? configIdFromReuseKey(reuseKey) : undefined
  const existingEntry = state.sessionIndex.find((e) => e.id === sessionId)
  // Keep a placeholder stable once assigned: reuse the existing index title
  // (including a prior `Untitled Chat N`) instead of regenerating one on every
  // persist. `rebaseUntitledCounter` keeps fresh numbers from colliding.
  const fallbackTitle = existingEntry?.title ?? nextUntitledTitle()
  // Prefer the model the composer shows. Omit the keys when neither the live
  // session nor the previous row has one, so a spread merge cannot wipe a
  // host snapshot with `undefined`.
  const recordedModel = sessionModelSnapshot(session)
  const modelId = recordedModel?.modelId ?? existingEntry?.modelId
  const modelName = recordedModel?.modelName ?? existingEntry?.modelName
  const entry: SessionIndexEntry = {
    id: sessionId,
    agentId: session.agentId,
    agentConfigId,
    title: session.title ?? deriveTitle(liveMessages, fallbackTitle),
    cwd: session.cwd,
    projectId: session.projectId,
    createdAt: session.createdAt,
    lastActivityAt: Date.now(),
    messageCount: ownMessages.length,
    lastSeq: ownMessages.reduce(
      (max, m) => Math.max(max, typeof m.seq === 'number' ? m.seq : 0),
      0
    ),
    status: session.status,
    // The host session index omits `turnActive`. Copy it from the live record
    // so launch recovery can prefer the chat whose turn is still running.
    turnActive: session.activeTurn === true || session.openTurnId != null ? true : undefined,
    // Preserve the origin flag so a discovered (external) session re-projected
    // here can't lose `discovered: true` and leak into the Termul-only sidebar.
    // Prefer the live-session marker (set by openDiscoveredSession) over the
    // existing index entry, so the disconnect/close path stays correct even when
    // no sessionIndex entry exists yet.
    discovered: session.discovered ?? existingEntry?.discovered ?? false,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    ...(modelId !== undefined ? { modelId } : {}),
    ...(modelName !== undefined ? { modelName } : {}),
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
 * In-flight pre-warm spawns, keyed by `agentReuseKey(configId, cwd, projectId)`. Held
 * outside reactive state (promises don't belong in the store) so `prewarmAgent`,
 * `startChat`, and `deleteAgentConfig` can dedupe against a warm that is still
 * spawning for the same config+cwd. The reactive `warmingConfigs` flag mirrors
 * membership for the UI.
 */
export const inFlightWarms = new Map<string, Promise<AgentId | null>>()

/** The same spawns, un-swallowed: what a joining caller judges by its own options. */
const inFlightWarmOutcomes = new Map<string, Promise<AgentId | null>>()

/**
 * Definite host spawn rejections (`agent_unavailable` / `invalid_agent_config`,
 * AD-5) by reuse key, with the launch signature they were issued for. Silent
 * (automatic) spawns skip a key whose config is unchanged — the same request
 * cannot succeed — while a user-initiated spawn always tries again and a
 * success or config edit clears the record. In-memory only; the signature
 * never leaves the renderer.
 */
const definiteSpawnRejections = new Map<string, string>()

/**
 * The launch signature each agent this renderer spawned was started with, by
 * agent id. A warm agent whose signature no longer matches the current launch
 * (an edited project env, for example) is not reused, so the next chat runs
 * with the env the project has now. In-memory only.
 */
const liveAgentSignatures = new Map<AgentId, string>()

/**
 * The effective launch of a config in a working directory: the agent config
 * plus the env the project owning `cwd` adds underneath it.
 */
function spawnSignature(config: AgentConfigLaunchFields, env: Record<string, string>): string {
  return JSON.stringify([config.name, config.command, config.args, env, config.allowTerminal])
}

/** Test-only: forget recorded definite spawn rejections between tests. */
export function _resetDefiniteSpawnRejectionsForTesting(): void {
  definiteSpawnRejections.clear()
  liveAgentSignatures.clear()
}

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
 * Wire `turnId` of the turn THIS client dispatched and has not yet closed, per
 * session. A terminator citing a different turn id is a stale one (a replay of
 * an earlier turn) and must not end the current turn.
 */
export const activeWirePromptTurns = new Map<SessionId, string>()

/**
 * Wire `turnId` of the latest turn THIS client dispatched whose `user_prompt`
 * echo has landed, per session. The host sequences that echo on acceptance, so
 * a dispatch whose reply is lost after its echo arrived is already known to be
 * accepted and needs no pending-reconcile. Cleared alongside every
 * `activeWirePromptTurns` delete so it stays bounded.
 */
export const echoedWirePromptTurns = new Map<SessionId, string>()

const ENDED_PROMPT_TURN_LIMIT = 256
const endedPromptTurnIds = new Set<string>()

/**
 * Idempotence guard for `prompt_complete`: returns true the first time a turn
 * id is seen, false for every duplicate (live + replay, error + agent_error).
 * Bounded so a long-lived tab does not grow without limit.
 */
export function claimPromptTurnEnd(turnId: string): boolean {
  if (endedPromptTurnIds.has(turnId)) return false
  endedPromptTurnIds.add(turnId)
  if (endedPromptTurnIds.size > ENDED_PROMPT_TURN_LIMIT) {
    const oldest = endedPromptTurnIds.values().next().value
    if (oldest !== undefined) endedPromptTurnIds.delete(oldest)
  }
  return true
}

/** Test-only: reset command engine + journal + definite-rejection + turn-end tracking between tests. */
export function _resetPromptReconcileForTesting(): void {
  __resetCommandEngineForTesting()
  __clearCommandJournalForTesting()
  definiteSpawnRejections.clear()
  activeWirePromptTurns.clear()
  echoedWirePromptTurns.clear()
  endedPromptTurnIds.clear()
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

/**
 * Web reload reuse (issue #837): ask the HOST which live agent owns `sessionId`
 * (`list_agents` reply now carries each agent's `ownsSession` set) and adopt
 * that process instead of spawning a duplicate. On a page reload this store
 * knows nothing about the original agent (its `configToLiveAgent` map died
 * with the tab), so `ensureLiveAgent` would spawn a fresh process and resume
 * the session on it while the original still streams.
 *
 * Adoption seeds the store's agent presence (`agents` + `agentStatus`) from
 * the summary's capabilities and registers the reuse key
 * (`agentReuseKey(configId, cwd, projectId)`) → host agent id, so every later
 * `ensureLiveAgent`/`prepareChat` for that config, cwd, and Project reuses the
 * host process.
 *
 * Desktop skips the lookup by default (`isTauriContext()`): the desktop store
 * already owns its agents in memory. A reload while a turn is still running
 * passes `{ allowDesktop: true }` so both transports adopt the owner instead
 * of spawning a second process onto the same session. `adopted` is `null`
 * when no live agent owns the session (fresh chat, owner already stopped),
 * the listing fails, or `options.isCurrent` reports a stale caller
 * generation — the caller falls back to the spawn path. The two null
 * cases are distinguished by `listingTrusted`: a skipped or failed listing
 * is `false` (the caller may still honor an in-store owner record), while a
 * listing that ran and found no owner is `true` — authoritative proof that
 * no host agent owns the session.
 */
export async function adoptHostOwnedAgent(
  set: (fn: (s: AcpState) => Partial<AcpState> | AcpState) => void,
  sessionId: SessionId,
  configId: string,
  cwd: string,
  options?: { allowDesktop?: boolean; isCurrent?: () => boolean; projectId?: string | null }
): Promise<{ adopted: AgentId | null; listingTrusted: boolean }> {
  const trimmedCwd = cwd.trim()
  if ((!options?.allowDesktop && isTauriContext()) || trimmedCwd.length === 0) {
    return { adopted: null, listingTrusted: false }
  }
  const transport = getAcpTransport()
  if (typeof transport.listAgentDetails !== 'function') {
    return { adopted: null, listingTrusted: false }
  }
  let summaries: WsAgentSummary[]
  try {
    summaries = (await transport.listAgentDetails()) ?? []
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'acp-store.adoptHostOwnedAgent',
      message: `Host agent listing failed while reopening session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
    })
    return { adopted: null, listingTrusted: false }
  }
  const owners = summaries.filter((entry) => entry.ownsSession?.includes(sessionId))
  if (owners.length === 0) return { adopted: null, listingTrusted: true }
  // Prefer an owner whose configId matches the session's agent config (the
  // common case); otherwise the first owner — session ownership is
  // authoritative regardless.
  const match = owners.find((entry) => entry.configId === configId) ?? owners[0]
  // The listing awaited above gives a stale-generation caller an async gap:
  // a newer reopen may already own this session's recovery. Registering the
  // reuse key anyway would route the next ensureLiveAgent at an owner a dead
  // generation picked — gate the write itself, not just the caller's attach.
  if (options?.isCurrent && !options.isCurrent()) {
    return { adopted: null, listingTrusted: true }
  }
  void logFrontendError({
    level: 'info',
    source: 'acp-store.adoptHostOwnedAgent',
    message: `Reusing host agent ${match.id} that owns session ${sessionId} instead of spawning a duplicate`
  })
  const projectId = resolveSpawnProject(trimmedCwd, options?.projectId)?.id ?? ''
  const reuseKey = agentReuseKey(configId, trimmedCwd, projectId || undefined)
  set((s) => ({
    agents: {
      ...s.agents,
      [match.id]: s.agents[match.id] ?? {
        id: match.id,
        capabilities: match.capabilities ?? null
      }
    },
    agentStatus: { ...s.agentStatus, [match.id]: 'connected' },
    // A mismatched-config owner still opens its session here, but it must
    // NOT be registered under the requested config+cwd reuse key — a later
    // startChat for that config would silently reuse a different agent's
    // process (CodeRabbit: mismatched owner registration).
    configToLiveAgent:
      match.configId === configId
        ? { ...s.configToLiveAgent, [reuseKey]: match.id }
        : s.configToLiveAgent
  }))
  return { adopted: match.id, listingTrusted: true }
}

export type EnsureLiveAgentOptions = {
  /** Mirror membership in `warmingConfigs` for the prewarm UI. */
  registerWarmUi?: boolean
  /**
   * When true, spawn failures resolve to `null` instead of rejecting (prewarm),
   * and a spawn the host already rejected definitively for the same config is
   * not re-issued.
   */
  silentSpawnFailure?: boolean
  /**
   * User-facing callers (history reopen) that stay silent about transient spawn
   * failures but must show a definite rejection: it rejects even when
   * `silentSpawnFailure` is set, and a recorded rejection does not block the
   * attempt (the user's action is a new intent).
   */
  surfaceDefiniteRejection?: boolean
  /**
   * Project of the spawn; it selects the Claude Account of a managed Claude
   * agent. Without it, the Project whose folder holds `cwd` is used.
   */
  projectId?: string
}

/**
 * The Project a spawn in `cwd` belongs to: `projectId` when given, else the
 * Project whose worktree or root is `cwd`, else the one whose root holds it
 * (longest match). The reuse key, the Claude Account and the project env of a
 * spawn all come from this one resolution.
 */
export function resolveSpawnProject(
  cwd: string,
  projectId?: string | null
): Pick<Project, 'id' | 'envVars'> | null {
  const { projects } = useProjectStore.getState()
  const explicit = projectId?.trim()
  if (explicit) return projects.find((p) => p.id === explicit) ?? { id: explicit }
  return projectForCwd(projects, cwd) ?? null
}

type AgentConfigLaunchFields = Pick<
  AcpState['agentConfigs'][number],
  'name' | 'command' | 'args' | 'env' | 'allowTerminal'
>

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

  const project = resolveSpawnProject(trimmedCwd, options.projectId)
  const projectId = project?.id ?? ''
  const reuseKey = agentReuseKey(configId, trimmedCwd, projectId || undefined)
  // The project contributes its env underneath the agent config, exactly as a
  // terminal tab in that project gets it (`spawnTerminalInPane`) and as a
  // terminal-native agent does (`launchAgentInPane`).
  const env = resolveAgentSpawnEnv(project?.envVars, config.env)
  const signature = spawnSignature(config, env)
  const currentAgentId = get().configToLiveAgent[reuseKey]
  const currentSignature = currentAgentId ? liveAgentSignatures.get(currentAgentId) : undefined
  const staleLaunch = currentSignature !== undefined && currentSignature !== signature
  if (
    currentAgentId &&
    (staleLaunch ||
      Object.values(get().sessions).some(
        (session) =>
          session.agentId === currentAgentId &&
          session.status !== 'closed' &&
          !ephemeralSessionIds.has(session.id)
      ))
  ) {
    // One Agent process per Agent chat, and none started with an outdated
    // launch. Keep this process for whatever it still serves (a chat, or an
    // ephemeral session such as a commit message whose session/new may not be
    // in `sessions` yet; the host's idle reaper stops it once quiet) and
    // reserve the canonical key for the next chat.
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
      message: staleLaunch
        ? `Detached agent ${currentAgentId}: its launch env no longer matches the project`
        : `Detached agent ${currentAgentId} so the next Agent chat gets its own process`
    })
  }

  const existing = get().configToLiveAgent[reuseKey]
  if (existing && isReusableStatus(get().agentStatus[existing])) {
    return Promise.resolve(existing)
  }

  const inFlight = inFlightWarms.get(reuseKey)
  if (inFlight) {
    // Join the running spawn, but judge ITS failure by THIS caller's options: a
    // prewarm (silent) started it, yet a user-initiated caller that joins must
    // still see a definite rejection instead of a swallowed `null`.
    const strict = inFlightWarmOutcomes.get(reuseKey)
    return strict ? asCallerView(strict, reuseKey, configId, options) : inFlight
  }

  if (
    options.silentSpawnFailure &&
    !options.surfaceDefiniteRejection &&
    definiteSpawnRejections.get(reuseKey) === signature
  ) {
    return Promise.resolve(null)
  }

  if (options.registerWarmUi) {
    set((s) => ({ warmingConfigs: { ...s.warmingConfigs, [reuseKey]: true } }))
  }

  if (projectId && otherProjectHoldsAgent(get(), configId, trimmedCwd, projectId)) {
    void logFrontendError({
      level: 'info',
      source: 'acp-store.ensureLiveAgent',
      message: `Project ${projectId} spawns its own agent for ${configId} at ${trimmedCwd}; another project already holds that cwd`
    })
  }

  const strictSpawn = (async (): Promise<AgentId | null> => {
    try {
      if (project?.envVars?.length) {
        void logFrontendError({
          level: 'info',
          source: 'acp-store.ensureLiveAgent',
          message: `Spawning ${config.name} with the env of project ${project.id} (${project.envVars.length} var(s))`
        })
      }
      const agentId = await get().spawnAgent(
        {
          configId,
          name: config.name,
          command: config.command,
          args: config.args,
          env,
          allowTerminal: config.allowTerminal
        },
        projectId || undefined
      )
      definiteSpawnRejections.delete(reuseKey)
      if (get().agentConfigs.some((c) => c.id === configId)) {
        liveAgentSignatures.set(agentId, signature)
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
      if (isDefiniteSpawnRejection(err)) definiteSpawnRejections.set(reuseKey, signature)
      throw err
    } finally {
      inFlightWarms.delete(reuseKey)
      inFlightWarmOutcomes.delete(reuseKey)
      if (options.registerWarmUi) {
        set((s) => {
          const warming = { ...s.warmingConfigs }
          delete warming[reuseKey]
          return { warmingConfigs: warming }
        })
      }
    }
  })()

  const spawnPromise = asCallerView(strictSpawn, reuseKey, configId, options)
  inFlightWarms.set(reuseKey, spawnPromise)
  inFlightWarmOutcomes.set(reuseKey, strictSpawn)
  // Joiners derive their own view; this handle must never be an unhandled rejection.
  strictSpawn.catch(() => undefined)
  return spawnPromise
}

/** True when a different Project already has a live process for this config and cwd. */
function otherProjectHoldsAgent(
  state: AcpState,
  configId: string,
  cwd: string,
  projectId: string
): boolean {
  return Object.keys(state.configToLiveAgent).some((key) => {
    if (isDetachedReuseKey(key)) return false
    const parsed = parseReuseKey(key)
    return (
      parsed.configId === configId &&
      parsed.cwd === cwd &&
      typeof parsed.projectId === 'string' &&
      parsed.projectId.length > 0 &&
      parsed.projectId !== projectId
    )
  })
}

/**
 * The spawn's outcome as one caller sees it: a silent caller gets `null` for a
 * failure (except a definite rejection it asked to surface); any other caller
 * gets the rejection.
 */
function asCallerView(
  strict: Promise<AgentId | null>,
  reuseKey: string,
  configId: string,
  options: EnsureLiveAgentOptions
): Promise<AgentId | null> {
  if (!options.silentSpawnFailure) return strict
  return strict.catch((err: unknown) => {
    if (isDefiniteSpawnRejection(err) && options.surfaceDefiniteRejection) throw err
    console.warn('[acp] ensureLiveAgent failed for', reuseKey, err)
    void logFrontendError({
      level: 'warn',
      source: 'acp-store.ensureLiveAgent',
      message: `Silent spawn failure for config ${configId} (${reuseKey}): ${err instanceof Error ? err.message : String(err)}`
    })
    return null
  })
}

export type LiveSwitchLink = { sourceId: SessionId; marker: SwitchMarkerFacts }

/**
 * Live switch target → source session link (spec-agent-switch-live-merged-transcript).
 * `spliceLiveSwitchTranscript` records the pair so an in-session wholesale
 * reinstall on the TARGET (crash retry, direct history open, resume install)
 * can re-splice the pre-switch band afterwards — the durable marker lives on
 * the SOURCE session's log, never the target's, so the reinstall alone would
 * otherwise collapse the merged view for the rest of the app session.
 * Entries clear in `dropSessionTranscriptState` (either endpoint dropped).
 */
export const liveSwitchSources = new Map<SessionId, LiveSwitchLink>()

/** Test-only: clear live-switch source links between tests. */
export function _resetLiveSwitchSourcesForTesting(): void {
  liveSwitchSources.clear()
}
