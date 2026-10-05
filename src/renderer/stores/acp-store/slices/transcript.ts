/**
 * Transcript slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import type { StateCreator } from 'zustand'
import { stripHandoffPreamble } from '@/components/chat/handoff-summary'
import type { ContentBlock, SessionId, SessionMode, SessionUsage, ToolCall } from '@/lib/acp-api'
import {
  getCachedSessionPayload,
  loadSessionPayload,
  markSessionPayloadPinned,
  setCachedSessionPayload,
  unpinSessionPayload
} from '@/lib/acp-history-persistence'
import { logFrontendError } from '@/lib/log-api'
import { wireBlocksToDisplay } from '@/lib/skills-wire-reverse'
import {
  acceptsSessionTranscriptEvents,
  cacheOptionsFromSession,
  dropHiddenTranscriptTurns,
  dropPlanForSession,
  dropRecordKey,
  hasActiveAssistantTail,
  isPersistedTwin,
  isServerHistoryMode,
  MAX_LIVE_TOOL_CALLS,
  MAX_LIVE_WINDOW_MESSAGES,
  mayStartChunkMessage,
  mergeAgentConfigOptions,
  newId,
  normalizeUserMessages,
  SWITCH_SPLICE_ID_PREFIX,
  toolIntervened,
  trimLiveToolCalls
} from '../helpers'
import { useAcpStore } from '../index'
import {
  commitMessageCollectors,
  handoffOnlyTurnIds,
  historySeqWatermarks,
  isHistoryCoveredEvent,
  liveSwitchSources,
  MAX_COMMIT_MESSAGE_RESPONSE_CHARS,
  MAX_TERMINAL_ASSIST_RESPONSE_CHARS,
  nextSeq,
  persistSession,
  rejectCommitMessageCollector,
  rejectTerminalAssistCollector,
  terminalAssistCollectors
} from '../shared-state'
import type { AcpState, ChatMessage, MessageRole } from '../types'

/**
 * Slack (in messages) for the streaming-prefix twin rule, measured as
 * `liveDistFromEnd - candidateDistFromEnd`. The persisted/live overlap ends
 * at "now" on both sides, so real twin pairs sit at matching distances; a
 * positive-only slack absorbs live bubbles appended after the payload read
 * (chunks that arrived mid-fold) without letting the prefix rule reach deep
 * history, where a short streaming text could collide with an unrelated
 * earlier message.
 */
const TWIN_SEAM_SLACK = 4

/**
 * Append text to a ContentBlock array, coalescing into a trailing text block.
 *
 * When `own` is true (the coalesced streaming path) the merge is amortized per
 * rAF flush: the FIRST text append of a flush takes a private copy of the
 * trailing block (cheap — the text string is shared by reference) and buffers
 * the chunk text; every later append of the same flush pushes its suffix onto
 * that buffer. {@link sealPendingTextDeltas} (end of `flushCoalesced`) joins
 * the buffered parts into the copy's `text` exactly once, so a frame's chunk
 * burst costs O(total delta) instead of O(N × full text) full-text copies —
 * and because the first append copies, no previously committed object (an
 * earlier store state, the payload cache, or a restored transcript) is ever
 * mutated. Store output is byte-identical to the eager path.
 */
export function appendBlocks(
  existing: ContentBlock[],
  incoming: ContentBlock,
  own = false
): ContentBlock[] {
  if (incoming.type === 'text') {
    const last = existing[existing.length - 1]
    if (last && last.type === 'text') {
      const suffix = incoming.text ?? ''
      if (own) {
        const parts = textDeltaParts.get(last)
        if (parts) {
          // Already merged into this flush — extend the buffered delta only.
          parts.push(suffix)
          return existing
        }
        // First text append this flush: take a private copy and buffer the
        // suffix; the join happens once in sealPendingTextDeltas.
        const owned: ContentBlock = { ...last }
        textDeltaParts.set(owned, [suffix])
        return [...existing.slice(0, -1), owned]
      }
      const merged: ContentBlock = { ...last, text: (last.text ?? '') + suffix }
      return [...existing.slice(0, -1), merged]
    }
  }
  return [...existing, incoming]
}

/**
 * Buffered text deltas for the current rAF flush, keyed by the private block
 * copy `appendBlocks(..., own)` created (object key — the copy is unique per
 * open stream; insertion order preserves registration).
 * `sealPendingTextDeltas` joins each block's parts into its `text` and
 * clears the map at the end of a flush.
 */
const textDeltaParts = new Map<ContentBlock, string[]>()

/**
 * Join and clear the buffered text deltas at the end of a coalesce flush.
 * Called once per flush AFTER all buffered applies ran, so each open stream's
 * trailing block holds its full text (`base + Σ deltas`) when the merged
 * `set()` commits — byte-identical to sequential eager appends.
 */
function sealPendingTextDeltas(): void {
  if (textDeltaParts.size === 0) return
  for (const [block, parts] of textDeltaParts) {
    if (parts.length > 0) {
      block.text = (block.text ?? '') + parts.join('')
    }
  }
  textDeltaParts.clear()
}

/**
 * Maximum UTF-16 length of a string `rawOutput` retained on a live tool card
 * (CAP-2). Mirrors the host's per-call byte budget
 * (`PERSISTED_TOOL_CALL_BYTE_BUDGET` = 32 KiB): a giant tool result clamps to
 * this length + a truncation marker so one call cannot balloon the live
 * window. Only string `rawOutput` is clamped on live update; non-string
 * `rawOutput` and `content` are agent-structural and left to the host's
 * durable sanitize.
 */
const MAX_LIVE_RAW_OUTPUT_CHARS = 32 * 1024

/** Suffix appended to a clamped `rawOutput` (no content follows it). */
const RAW_OUTPUT_TRUNCATION_MARKER = '\n[termul: tool output truncated]'

/**
 * Tool-call ids whose oversized `rawOutput` was already clamp-logged (CAP-2).
 * A streaming giant output re-sends per update; the boundary log fires once
 * per id, not per update. Cleared in `dropSessionTranscriptState`.
 */
const clampedRawOutputCallIds = new Set<string>()

/**
 * Clamp a string `rawOutput` to {@link MAX_LIVE_RAW_OUTPUT_CHARS} + a
 * truncation marker (CAP-2). Returns the original object when no clamp is
 * needed (byte-identical for normal-sized outputs). Logs the clamp WITHOUT
 * the content — once per toolCallId (deduped against
 * {@link clampedRawOutputCallIds}).
 */
function clampLiveRawOutput(sessionId: SessionId, toolCallId: string, rawOutput: unknown): unknown {
  if (typeof rawOutput !== 'string') return rawOutput
  if (rawOutput.length <= MAX_LIVE_RAW_OUTPUT_CHARS) return rawOutput
  if (!clampedRawOutputCallIds.has(toolCallId)) {
    clampedRawOutputCallIds.add(toolCallId)
    void logFrontendError({
      level: 'warn',
      source: 'acp.store',
      message: `Clamped tool rawOutput for call ${toolCallId} (session ${sessionId})`
    })
  }
  return rawOutput.slice(0, MAX_LIVE_RAW_OUTPUT_CHARS) + RAW_OUTPUT_TRUNCATION_MARKER
}

/**
 * Trim a session's messages to the live window: keep the most recent
 * `MAX_LIVE_WINDOW_MESSAGES` messages, always retaining the in-flight
 * streaming tail (never trimmed). A session whose full payload is not yet in
 * the renderer cache is first probed in the background (one
 * `loadSessionPayload` roundtrip): once the cache holds the durable copy (host
 * owns history), trimming engages — lossless, older messages restore via
 * `loadOlderMessages` on scroll-up. Sessions with no durable history
 * (`live_only` mode / degraded host → probe resolves `null`) are marked
 * untrimmable and never lose a message.
 */
export function trimLiveWindow(messages: ChatMessage[], sessionId: SessionId): ChatMessage[] {
  if (messages.length <= MAX_LIVE_WINDOW_MESSAGES) return messages
  // Probe gate: trim only when the full payload is cached — otherwise
  // un-persisted messages would be lost (no disk copy to lazy-load from).
  // The durable copy lives on the host (CAP-2), so a session that never
  // reloaded has a cold cache even though its history IS durable: fire a
  // one-shot background probe to seed the cache, then trim from the next
  // flush on. Never blocks the flush — the probe is fire-and-forget.
  if (!getCachedSessionPayload(sessionId)) {
    if (untrimmableSessions.has(sessionId)) return messages
    if (inFlightDurabilityProbes.has(sessionId)) return messages
    inFlightDurabilityProbes.add(sessionId)
    void loadSessionPayload(sessionId)
      .then((payload) => {
        // Close/delete wins the race: a probe resolving after the session was
        // dropped must not resurrect a pin (dropSessionTranscriptState removed
        // the in-flight entry). Guard on the store, not the bookkeeping.
        if (!useAcpStore.getState().messages[sessionId]) return
        if (payload) {
          // Trim engages from the next over-limit flush (the payload is now
          // cached, so a trim is lossless). Pin BEFORE inserting: an insert
          // on a cache at its inactive budget would otherwise evict the new
          // entry immediately (unpinned), forcing a re-probe/host refetch
          // churn on later flushes.
          markSessionPayloadPinned(sessionId)
          setCachedSessionPayload(sessionId, payload)
          return
        }
        // No durable history (`live_only` / degraded host): the session must
        // stay lossless — mark untrimmable and log the boundary once.
        untrimmableSessions.add(sessionId)
        void logFrontendError({
          level: 'warn',
          source: 'acp.store',
          message: `Live window trim skipped for session ${sessionId}: no durable history`
        })
      })
      .catch((err: unknown) => {
        // Probe failure (IPC error): warn and allow a retry on the next
        // over-limit flush (the session is not marked untrimmable).
        void logFrontendError({
          level: 'warn',
          source: 'acp.store',
          message: `Durability probe failed for session ${sessionId}: ${String(err)}`
        })
      })
      .finally(() => {
        // Release the in-flight slot on EVERY settlement so a rejected probe
        // (or a seeded payload later evicted from the cache) can re-probe on
        // the next over-limit flush. Untrimmable sessions stay blocked by the
        // separate `untrimmableSessions` set.
        inFlightDurabilityProbes.delete(sessionId)
      })
    return messages
  }
  // Pin only a session that actually trims (its cached payload must survive
  // the pin-cap eviction churn) — never a cold-cache/untrimmable one, whose
  // pin slot would be phantom (no cache entry to protect).
  markSessionPayloadPinned(sessionId)
  // Count trailing streaming messages (the in-flight tail — always retained).
  let streamingCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].streaming) streamingCount++
    else break
  }
  // Let the retained window grow by the reader's lazy-loaded backfill so a
  // coalesced flush keeps history the reader just pulled in (no load→trim thrash).
  const backfill = backfillCounts.get(sessionId) ?? 0
  const keepCount = Math.max(streamingCount, MAX_LIVE_WINDOW_MESSAGES + backfill)
  return messages.slice(messages.length - keepCount)
}

/**
 * CAP-1 durability-probe bookkeeping. `trimLiveWindow` fires one async
 * `loadSessionPayload` per cold-cache over-limit session;
 * `inFlightDurabilityProbes` prevents duplicate probes and
 * `untrimmableSessions` remembers sessions with no durable history (probe
 * resolved `null`) so they never trim (lossless). Both are cleared in
 * `dropSessionTranscriptState` so a dropped/recreated session re-establishes
 * its own probe state.
 */
const inFlightDurabilityProbes = new Set<SessionId>()

const untrimmableSessions = new Set<SessionId>()

/**
 * Free per-session transcript maps held in the WebView heap.
 * Disk history is untouched — reopen lazy-loads via `openHistorySession`.
 * Call only after any needed `persistSession` so the last mirror is flushed.
 */
export function dropSessionTranscriptState(
  state: Pick<
    AcpState,
    'messages' | 'toolCalls' | 'agentSwitches' | 'commands' | 'sessionUsage' | 'plans'
  >,
  sessionId: SessionId
): Pick<
  AcpState,
  'messages' | 'toolCalls' | 'agentSwitches' | 'commands' | 'sessionUsage' | 'plans'
> {
  // Drop per-session module-level bookkeeping too so a closed/deleted session
  // never leaks a backfill allowance, an in-flight load guard, a stale history
  // watermark, a durability-probe/untrimmable mark, or clamp-log dedup entries
  // (a recreated session must re-establish its own; a resolving probe must not
  // resurrect a pin).
  backfillCounts.delete(sessionId)
  loadingOlderSessions.delete(sessionId)
  historySeqWatermarks.delete(sessionId)
  inFlightDurabilityProbes.delete(sessionId)
  untrimmableSessions.delete(sessionId)
  // Live-switch source links die with either endpoint: the target's entry
  // outright, and any entry pointing at the dropped session as source.
  liveSwitchSources.delete(sessionId)
  for (const [target, source] of liveSwitchSources) {
    if (source === sessionId) liveSwitchSources.delete(target)
  }
  for (const call of state.toolCalls[sessionId] ?? []) {
    clampedRawOutputCallIds.delete(call.toolCallId)
  }
  unpinSessionPayload(sessionId)
  return {
    messages: dropRecordKey(state.messages, sessionId),
    toolCalls: dropRecordKey(state.toolCalls, sessionId),
    agentSwitches: dropRecordKey(state.agentSwitches, sessionId),
    commands: dropRecordKey(state.commands, sessionId),
    sessionUsage: dropRecordKey(state.sessionUsage, sessionId),
    plans: dropRecordKey(state.plans, sessionId)
  }
}

// --- Streaming coalescing (rAF-batched set()) -------------------------------
//
// Buffer streaming chunk/tool-call updates so ≤1 Zustand `set()` fires per
// animation frame. Flushed synchronously on turn-complete / agent-error /
// transport disconnect so the final transcript is consistent before status
// flips. Replay mode (`session.replaying`) keeps its immediate `set()` (the
// replay replaces the transcript, not a per-token storm).

interface CoalescedUpdate {
  sessionId: SessionId
  apply: (s: AcpState) => Partial<AcpState>
}

let coalescedBuffer: CoalescedUpdate[] = []

let coalesceRafId: number | null = null

/** Sessions whose `loadOlderMessages` is in flight (prevents concurrent loads). */
const loadingOlderSessions = new Set<SessionId>()

/**
 * Per-session count of older messages the reader lazy-loaded by scrolling up.
 * `trimLiveWindow` lets the retained window grow to MAX + backfill for that
 * session so a coalesced flush never discards history the reader just pulled
 * in (avoids a load→trim→load thrash while a turn streams and the reader is
 * scrolled up). Reset by `clearSessionBackfill` when the reader returns to the
 * live edge, and on session drop.
 */
const backfillCounts = new Map<SessionId, number>()

/** Test-only: clear the backfill counts between tests to avoid cross-test leakage. */
export function _resetBackfillForTesting(): void {
  backfillCounts.clear()
}

function scheduleCoalesceFlush(): void {
  if (coalesceRafId !== null) return
  coalesceRafId = requestAnimationFrame(flushCoalesced)
}

/**
 * Drain the coalesced buffer and apply a single merged `set()`. Each buffered
 * update is applied sequentially against a working copy so the second event
 * sees the first event's result. Live windows (messages + tool calls) are
 * trimmed for affected sessions after all updates are merged; buffered text
 * deltas are sealed into their blocks BEFORE the `set()` returns its patch.
 */
function flushCoalesced(): void {
  coalesceRafId = null
  const updates = coalescedBuffer
  coalescedBuffer = []
  if (updates.length === 0) return
  useAcpStore.setState((s) => {
    let working = s
    let merged: Partial<AcpState> = {}
    const affectedSessions = new Set<SessionId>()
    for (const { sessionId, apply } of updates) {
      const patch = apply(working)
      working = { ...working, ...patch }
      merged = { ...merged, ...patch }
      affectedSessions.add(sessionId)
    }
    // Seal the buffered text deltas into their block copies BEFORE building
    // the returned patch so the committed state holds the full text.
    sealPendingTextDeltas()
    // Trim live windows for affected sessions after merging all updates.
    const mergedMessages = merged.messages ?? working.messages
    const mergedToolCalls = merged.toolCalls ?? working.toolCalls
    let messages = mergedMessages
    let toolCalls = mergedToolCalls
    for (const sessionId of affectedSessions) {
      const list = messages[sessionId]
      if (list && list.length > MAX_LIVE_WINDOW_MESSAGES) {
        if (messages === mergedMessages) messages = { ...messages }
        messages[sessionId] = trimLiveWindow(list, sessionId)
      }
      const calls = toolCalls[sessionId]
      if (calls && calls.length > MAX_LIVE_TOOL_CALLS) {
        if (toolCalls === mergedToolCalls) toolCalls = { ...toolCalls }
        toolCalls[sessionId] = trimLiveToolCalls(calls)
      }
    }
    if (messages === mergedMessages && toolCalls === mergedToolCalls) return merged
    const patch: Partial<AcpState> = { ...merged }
    if (messages !== mergedMessages) patch.messages = messages
    if (toolCalls !== mergedToolCalls) patch.toolCalls = toolCalls
    return patch
  })
}

/** Cancel any pending rAF and flush synchronously (turn-complete / disconnect). */
export function flushCoalescedSync(): void {
  if (coalesceRafId !== null) {
    cancelAnimationFrame(coalesceRafId)
    coalesceRafId = null
  }
  flushCoalesced()
  // Defensive: a seal cannot survive a flush (sealPendingTextDeltas ran inside
  // the setState updater), but never leave buffered deltas dangling if an
  // updater threw before reaching the seal.
  textDeltaParts.clear()
}

/** Test-only: drain the coalesced buffer synchronously. */
export function _flushCoalescedForTesting(): void {
  flushCoalescedSync()
}

/** Test-only: reset coalescing state (clear buffer + cancel pending rAF). */
export function _resetCoalesceForTesting(): void {
  if (coalesceRafId !== null) {
    cancelAnimationFrame(coalesceRafId)
    coalesceRafId = null
  }
  coalescedBuffer = []
  textDeltaParts.clear()
}

/** Test-only: check whether a coalesce flush is pending. */
export function _isCoalescePendingForTesting(): boolean {
  return coalesceRafId !== null || coalescedBuffer.length > 0
}

/** Test-only: clear the loading-older guard set. */
export function _resetLoadingOlderForTesting(): void {
  loadingOlderSessions.clear()
}

/** Queue a streaming update for rAF-batched `set()`. */
function coalesceSet(sessionId: SessionId, apply: (s: AcpState) => Partial<AcpState>): void {
  coalescedBuffer.push({ sessionId, apply })
  scheduleCoalesceFlush()
}

type TranscriptSliceState = Pick<
  AcpState,
  | 'messages'
  | 'toolCalls'
  | 'plans'
  | 'commands'
  | 'loadOlderMessages'
  | 'clearSessionBackfill'
  | '_onUserPrompt'
  | '_onMessageChunk'
  | '_onToolCall'
  | '_onToolCallUpdate'
  | '_onPlanUpdate'
  | '_onCommandsUpdate'
  | '_onModeUpdate'
  | '_onConfigOptionsUpdate'
  | '_onSessionInfoUpdate'
  | '_onUsageUpdate'
>

export const createTranscriptSlice: StateCreator<AcpState, [], [], TranscriptSliceState> = (
  set,
  get
) => ({
  messages: {},
  toolCalls: {},
  plans: {},
  commands: {},

  // --- Live window: scroll-up lazy-load -------------------------------------

  /**
   * Lazy-load older messages from the cached full payload on scroll-up.
   * Reads the full payload via `loadSessionPayload` (cached module-side so
   * re-hydrations don't re-read disk), finds messages older than the
   * window's oldest retained id, and prepends the next `count` into the
   * in-memory window. Idempotent at the history head (no infinite loop).
   * Reversible trim — disk format unchanged.
   */
  loadOlderMessages: async (sessionId, count) => {
    // Prevent concurrent loads for the same session (rapid scroll-up).
    if (loadingOlderSessions.has(sessionId)) return
    loadingOlderSessions.add(sessionId)
    try {
      // Best-effort read: a disk/server failure must not surface as an
      // unhandled promise rejection in the UI — the reader keeps the current
      // view and can retry by scrolling up again.
      const payload = await loadSessionPayload(sessionId).catch((e: unknown) => {
        console.warn('[acp] loadOlderMessages: payload read failed', e)
        return null
      })
      if (!payload) return
      // Re-read current state after the async gap — new chunks may have arrived.
      const current = get().messages[sessionId] ?? []
      if (current.length === 0) return
      const oldestId = current[0].id
      // spec-agent-switch-live-merged-transcript: a spliced head can never
      // anchor — its durable home is the SOURCE session's log (namespaced id,
      // negative-band seq), not this session's payload. Cross-seam paging is
      // a declared limitation (spec design notes); info, not warn — this is
      // the expected boundary, not a failure.
      if (oldestId.startsWith(SWITCH_SPLICE_ID_PREFIX)) {
        void logFrontendError({
          level: 'info',
          source: 'acp.loadOlderMessages',
          message: `Scroll-back for session ${sessionId} reached the switch-splice seam; pre-switch records are not restorable from this session's payload`
        })
        return
      }
      // Hidden turns never render — the backfill window must not resurrect the
      // greeting prefix when scrolling to the transcript head.
      const fullMessages = normalizeUserMessages(dropHiddenTranscriptTurns(payload.messages))
      let oldestIdx = fullMessages.findIndex((m) => m.id === oldestId)
      if (oldestIdx === -1) {
        // Id anchor missed: the live head's id is absent from the persisted
        // payload. This happens when the live head is a locally-created
        // bubble (live-only session, or created after the last persist), and
        // historically when a tail fold minted a window-local `snapshot:` id
        // for a run that opened before the tail window (the backend now
        // deepens the window to a fold boundary, but persisted installs may
        // still carry the drift). Fall back to seq anchoring: the bubble that
        // contains `oldestSeq` is the last persisted message whose seq is at
        // or below it — restored ids share the persisted seq domain, and the
        // live counter is rebased above the max restored seq on install.
        const oldestSeq = current[0].seq
        if (typeof oldestSeq === 'number' && Number.isFinite(oldestSeq)) {
          for (let i = fullMessages.length - 1; i >= 0; i -= 1) {
            const seq = fullMessages[i].seq
            if (typeof seq === 'number' && Number.isFinite(seq) && seq <= oldestSeq) {
              oldestIdx = i
              break
            }
          }
        }
        if (oldestIdx === -1) {
          void logFrontendError({
            level: 'warn',
            source: 'acp.loadOlderMessages',
            message: `Oldest live message for session ${sessionId} is not in the persisted payload and could not be anchored by seq; older history will not load`
          })
          return
        }
        void logFrontendError({
          level: 'warn',
          source: 'acp.loadOlderMessages',
          message: `Oldest live message id for session ${sessionId} missing from persisted payload; anchored scroll-back by seq at index ${oldestIdx}`
        })
      }
      // Already at the head: no older messages (idempotent — prevents
      // infinite scroll-up loops).
      if (oldestIdx === 0) return
      const start = Math.max(0, oldestIdx - count)
      const older = fullMessages.slice(start, oldestIdx)
      if (older.length === 0) return
      set((s) => {
        const live = s.messages[sessionId] ?? []
        // Deduplicate against the live window — by id AND by content. The id
        // check catches restored bubbles; the content check catches the
        // live-only id dialects (`turn:*` optimistic prompts, `msg-*`
        // streams) whose persisted twins carry `user:seq-*`/`snapshot:*`
        // ids — otherwise a seq-anchored backfill re-renders the in-flight
        // turn above the live copy. Matches are consumed seam-ward (the end
        // of `older` first) so identical repeated content deeper in history
        // — e.g. the same prompt sent twice — keeps its own copy, and a
        // chunk arriving between the payload read and this set can't
        // double-render.
        const liveIds = new Set(live.map((m) => m.id))
        const twinUsed = new Array<boolean>(live.length).fill(false)
        const deduped: ChatMessage[] = []
        for (let i = older.length - 1; i >= 0; i -= 1) {
          const candidate = older[i]
          if (liveIds.has(candidate.id)) continue
          const candidateDistFromEnd = older.length - 1 - i
          const twin = live.findIndex(
            (m, index) =>
              !twinUsed[index] &&
              isPersistedTwin(
                candidate,
                m,
                live.length - 1 - index - candidateDistFromEnd >= 0 &&
                  live.length - 1 - index - candidateDistFromEnd <= TWIN_SEAM_SLACK
              )
          )
          if (twin !== -1) {
            twinUsed[twin] = true
            continue
          }
          deduped.push(candidate)
        }
        deduped.reverse()
        if (deduped.length === 0) return {}
        // Grow the retained window by the number of older messages actually
        // prepended so the next coalesced flush keeps them (no load→trim thrash
        // while a turn streams and the reader is scrolled up).
        backfillCounts.set(sessionId, (backfillCounts.get(sessionId) ?? 0) + deduped.length)
        return {
          messages: { ...s.messages, [sessionId]: [...deduped, ...live] }
        }
      })
    } finally {
      loadingOlderSessions.delete(sessionId)
    }
  },

  clearSessionBackfill: (sessionId) => {
    // Drop the per-session backfill allowance AND trim the window back to the
    // live bound immediately — don't wait for the next coalesced flush, which
    // may never arrive if the turn already ended. Called by the chat list when
    // the reader returns to the live edge (pinned), bounding browsing growth.
    backfillCounts.delete(sessionId)
    set((s) => {
      const list = s.messages[sessionId]
      if (!list || list.length <= MAX_LIVE_WINDOW_MESSAGES) return {}
      // backfill just cleared → trimLiveWindow keeps MAX (+ in-flight tail).
      const trimmed = trimLiveWindow(list, sessionId)
      if (trimmed.length === list.length) return {}
      return { messages: { ...s.messages, [sessionId]: trimmed } }
    })
  },

  _onUserPrompt: (e, eventSeq) => {
    // CAP-3 replay contract: drop events the installed payload already covers.
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    // Story 3: the echo of a summary-only handoff turn (no draft → no
    // optimistic user bubble) carries the summary wire text; it must not
    // render as a user bubble. The dispatch closure registered the turn id.
    if (e.turnId && handoffOnlyTurnIds.has(e.turnId)) {
      handoffOnlyTurnIds.delete(e.turnId)
      return
    }
    // The echo carries the WIRE blocks (path-framed skills); normalize ONCE
    // here so both the trailing-blocks dedup (display vs display — the stored
    // optimistic message holds display blocks, and a raw wire-vs-display
    // compare would never match, appending a duplicate bubble) and the
    // appended message use the same chip-rendering display blocks.
    const content = [...wireBlocksToDisplay(e.content)]
    // spec-agent-switch-separator-redesign: a framed `# Conversation
    // handoff` echo persisted by an OLD-format sender (queued flush on a
    // stale build, another client) arrives verbatim — strip the preamble
    // like the replay folds. `null` → the echo IS the summary: drop it.
    const first = content[0]
    if (first?.type === 'text' && typeof first.text === 'string') {
      const stripped = stripHandoffPreamble(first.text)
      if (stripped === null) {
        // Summary-only echo with attachments behind it: keep the attachments.
        if (content.length <= 1) return
        content.splice(0, 1)
      } else if (stripped !== first.text) {
        content[0] = { ...first, text: stripped }
      }
    }
    set((s) => {
      const session = s.sessions[e.sessionId]
      if (!session) return {}
      const list = s.messages[e.sessionId] ?? []
      const sameBlocks = (left: ContentBlock[], right: ContentBlock[]): boolean =>
        JSON.stringify(left) === JSON.stringify(right)
      // spec-agent-switch-live-merged-transcript: `switch-splice:` records are
      // projected pre-switch history, never this session's own tail — an echo
      // whose blocks match a spliced old user message is genuinely new input,
      // not a duplicate of the optimistic bubble.
      const trailingUser = [...list]
        .reverse()
        .find(
          (message) => message.role === 'user' && !message.id.startsWith(SWITCH_SPLICE_ID_PREFIX)
        )
      if (
        (e.turnId && list.some((message) => message.id === `turn:${e.turnId}`)) ||
        (trailingUser && sameBlocks(trailingUser.blocks, content))
      ) {
        return {}
      }
      const message: ChatMessage = {
        id: e.turnId ? `turn:${e.turnId}` : newId('msg'),
        role: 'user',
        blocks: content,
        streaming: false,
        timestamp: Date.now(),
        seq: nextSeq()
      }
      return { messages: { ...s.messages, [e.sessionId]: [...list, message] } }
    })
  },

  _onMessageChunk: (e, eventSeq) => {
    const commitCollector = commitMessageCollectors.get(e.sessionId)
    if (commitCollector) {
      if (e.role === 'agent' && e.content.type === 'text' && typeof e.content.text === 'string') {
        commitCollector.length += e.content.text.length
        if (commitCollector.length > MAX_COMMIT_MESSAGE_RESPONSE_CHARS) {
          commitCollector.reject(new Error('The ACP agent response was too large'))
        } else {
          commitCollector.chunks.push(e.content.text)
        }
      }
      return
    }
    const assistCollector = terminalAssistCollectors.get(e.sessionId)
    if (assistCollector) {
      if (e.role === 'agent' && e.content.type === 'text' && typeof e.content.text === 'string') {
        assistCollector.length += e.content.text.length
        if (assistCollector.length > MAX_TERMINAL_ASSIST_RESPONSE_CHARS) {
          assistCollector.reject(new Error('The ACP agent response was too large'))
        } else {
          assistCollector.chunks.push(e.content.text)
        }
      }
      return
    }
    // CAP-3 replay contract: drop chunks the installed payload already covers.
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    // Replay mode replaces the transcript with an immediate set (not a
    // per-token storm). Normal streaming is coalesced via rAF so ≤1 set()
    // fires per animation frame.
    const session = get().sessions[e.sessionId]
    const useCoalesce = !session?.replaying
    const apply = (s: AcpState): Partial<AcpState> => {
      const sess = s.sessions[e.sessionId]
      // Drop chunks for unknown or already-closed sessions (no orphan state) —
      // unless a session/load replay is in flight: the session stays 'closed'
      // until the load IPC resolves, but its replayed chunks must land.
      if (!sess || (sess.status === 'closed' && !sess.replaying)) return {}
      const role = e.role as MessageRole
      const content = e.content
      // Replayed user-role chunks (the agent re-streaming the accepted prompt
      // on session/load) carry WIRE text kept RAW while streaming — the
      // framing may split across several chunks, so a partial prefix must not
      // be parsed. `finalizeStreaming` normalizes the completed user bubble
      // once the stream ends. Agent/thought prose is never touched.
      // Server-history mode: the fetched payload is the authoritative
      // pre-reconnect transcript (CAP-3 replay contract) and replayed content
      // is seq-deduped at the handler top, so a chunk that survives is
      // genuinely new — the replay window must never replace the transcript
      // (desktop keeps the replace: the agent's re-stream is its only history
      // source) nor merge into a restored (never-streaming) bubble, so
      // replayed content can never splice into it.
      const serverReplayWindow = isServerHistoryMode() && Boolean(sess.replaying)
      // First replayed chunk: the agent is re-streaming the full conversation,
      // which supersedes the locally persisted mirror. Replace the transcript
      // (avoids duplicating history) and let later chunks append after it.
      // Stale tool calls from a previous live period are dropped too — the
      // replay re-delivers the conversation's tool calls, and keeping the old
      // list would render each of them twice.
      if (sess.replaying === 'pending' && !isServerHistoryMode()) {
        // A whitespace-only first chunk must not count as "real replay
        // content" — replacing the mirror with it would blank the chat.
        if (content.type === 'text' && !(content.text ?? '').trim().length) return {}
        // User chunks stay in RAW wire form while streaming (the framing may
        // split across chunks — normalizing a prefix would misparse it);
        // `finalizeStreaming` normalizes the completed bubble once the stream
        // ends.
        const message: ChatMessage = {
          id: newId('msg'),
          role,
          blocks: [content],
          streaming: true,
          timestamp: Date.now(),
          seq: nextSeq(),
          messageId: e.messageId
        }
        // spec-agent-switch-live-merged-transcript: a replay on a session
        // carrying a live-spliced band re-streams only ITS OWN durable log —
        // keep the projected pre-switch records across the replace or the
        // merged view collapses to post-switch turns with an orphaned
        // separator on `agentSwitches`.
        const preservedSplicedMessages = (s.messages[e.sessionId] ?? []).filter((m) =>
          m.id.startsWith(SWITCH_SPLICE_ID_PREFIX)
        )
        const preservedSplicedToolCalls = (s.toolCalls[e.sessionId] ?? []).filter((t) =>
          t.toolCallId.startsWith(SWITCH_SPLICE_ID_PREFIX)
        )
        return {
          messages: {
            ...s.messages,
            [e.sessionId]: [...preservedSplicedMessages, message]
          },
          toolCalls: { ...s.toolCalls, [e.sessionId]: preservedSplicedToolCalls },
          // CAP-2: the replay mirror replaces the transcript — switches stay
          // (same-session replay never re-authors markers; the host owns them
          // and the watermark guard dedups live events).
          sessions: {
            ...s.sessions,
            [e.sessionId]: { ...sess, replaying: 'streaming' }
          }
        }
      }
      const list = s.messages[e.sessionId] ?? []
      const last = list[list.length - 1]
      // Attach to the trailing assistant/user message for this turn (including
      // chunks that arrive after streaming was finalized but IPC lagged) —
      // UNLESS a tool call landed after that message. Coalescing across a tool
      // boundary would fold a post-tool text run back into the pre-tool bubble,
      // collapsing the real `text → tool → text` order into one position.
      // spec-agent-switch-live-merged-transcript: a spliced record
      // (`switch-splice:` id) is projected pre-switch history, never the live
      // tail — a new-session chunk must open its own bubble below the switch
      // separator instead of growing the last old transcript bubble.
      const tools = s.toolCalls[e.sessionId] ?? []
      const sameMessageId = Boolean(e.messageId && last?.messageId && last.messageId === e.messageId)
      // A chunk that carries messageId belongs to that ACP message. Do not
      // fold it into a tail that has no id, or a different id, via the
      // streaming heuristic.
      const idBlocksHeuristic = Boolean(e.messageId) && last?.messageId !== e.messageId
      const heuristicMerge =
        !idBlocksHeuristic &&
        Boolean(last) &&
        last?.role === role &&
        !last?.id.startsWith(SWITCH_SPLICE_ID_PREFIX) &&
        (last?.streaming || (!serverReplayWindow && hasActiveAssistantTail(list, role))) &&
        !toolIntervened(tools, last!)
      if (
        last &&
        last.role === role &&
        !last.id.startsWith(SWITCH_SPLICE_ID_PREFIX) &&
        !toolIntervened(tools, last) &&
        (sameMessageId || heuristicMerge)
      ) {
        // `own` = coalesced path: appendBlocks amortizes the text merge per
        // flush (copy-on-first-touch + buffered deltas sealed in
        // flushCoalesced) instead of copying the full text per chunk. User
        // runs keep the RAW wire text here too — `wireBlocksToDisplay` runs
        // once in `finalizeStreaming` against the fully-joined text, so it
        // never sees a partial framing (and the amortized delta buffer never
        // races the normalization).
        const merged = appendBlocks(last.blocks, content, useCoalesce)
        const updated: ChatMessage = {
          ...last,
          blocks: merged,
          streaming: true,
          messageId: last.messageId ?? e.messageId
        }
        return { messages: { ...s.messages, [e.sessionId]: [...list.slice(0, -1), updated] } }
      }
      if (!mayStartChunkMessage(sess, list, role)) return {}
      // Ignore an empty leading text chunk (avoids a flashing empty bubble).
      if (content.type === 'text' && !(content.text ?? '').length) return {}
      // Raw wire form while streaming — normalized at stream end (above).
      const message: ChatMessage = {
        id: newId('msg'),
        role,
        blocks: [content],
        streaming: true,
        timestamp: Date.now(),
        seq: nextSeq(),
        messageId: e.messageId
      }
      return { messages: { ...s.messages, [e.sessionId]: [...list, message] } }
    }
    if (useCoalesce) {
      coalesceSet(e.sessionId, apply)
    } else {
      set(apply)
    }
  },

  _onToolCall: (e, eventSeq) => {
    const hadCommit = commitMessageCollectors.has(e.sessionId)
    const hadAssist = terminalAssistCollectors.has(e.sessionId)
    if (hadCommit)
      rejectCommitMessageCollector(e.sessionId, 'The ACP agent attempted to use a tool')
    if (hadAssist)
      rejectTerminalAssistCollector(e.sessionId, 'The ACP agent attempted to use a tool')
    if (hadCommit || hadAssist) return
    if (terminalAssistCollectors.has(e.sessionId)) {
      rejectTerminalAssistCollector(e.sessionId, 'The ACP agent attempted to use a tool')
      return
    }
    // CAP-3 replay contract: drop events the installed payload already covers.
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    const session = get().sessions[e.sessionId]
    const useCoalesce = !session?.replaying
    const apply = (s: AcpState): Partial<AcpState> => {
      // Same guard as message chunks: never grow maps for unknown/closed sessions.
      if (!acceptsSessionTranscriptEvents(s.sessions[e.sessionId])) return {}
      // Stamp arrival time + monotonic seq (unless already present) so the UI
      // can interleave tool calls with messages on one chronological timeline.
      // CAP-2: clamp a string `rawOutput` on the initial call too (an
      // oversized first emission must not bypass the live bound).
      const stamped: ToolCall = {
        ...e.toolCall,
        timestamp: typeof e.toolCall.timestamp === 'number' ? e.toolCall.timestamp : Date.now(),
        seq: typeof e.toolCall.seq === 'number' ? e.toolCall.seq : nextSeq(),
        ...(e.toolCall.rawOutput !== undefined && {
          rawOutput: clampLiveRawOutput(e.sessionId, e.toolCall.toolCallId, e.toolCall.rawOutput)
        })
      }
      // Upsert by toolCallId (replace-or-append) so reconnect-replay overlap
      // can't double-render a tool card — the latest call wins. The transport's
      // `seq <= last` drop is the seq-level guard; this upsert is the
      // toolCallId-level guard (a same-toolCallId re-emission carries a
      // different seq, so only the store can dedup it). Mirrors the merge-by-id
      // pattern in `_onToolCallUpdate` below.
      const list = s.toolCalls[e.sessionId] ?? []
      const idx = list.findIndex((t) => t.toolCallId === e.toolCall.toolCallId)
      if (idx === -1) {
        return {
          toolCalls: { ...s.toolCalls, [e.sessionId]: [...list, stamped] }
        }
      }
      // Preserve the original timeline placement: a replay (reconnect overlap)
      // must not move the card to a later position. The latest call fields
      // (title/status/content/...) win; the arrival-stamped seq + timestamp stay.
      const merged: ToolCall = {
        ...list[idx],
        ...stamped,
        timestamp: list[idx].timestamp,
        seq: list[idx].seq
      }
      const next = [...list]
      next[idx] = merged
      return {
        toolCalls: { ...s.toolCalls, [e.sessionId]: next }
      }
    }
    if (useCoalesce) {
      coalesceSet(e.sessionId, apply)
    } else {
      set(apply)
    }
  },

  _onToolCallUpdate: (e, eventSeq) => {
    // CAP-3 replay contract: drop events the installed payload already covers
    // (the restored card already reflects the persisted update).
    if (isHistoryCoveredEvent(e.sessionId, eventSeq)) return
    const session = get().sessions[e.sessionId]
    const useCoalesce = !session?.replaying
    const apply = (s: AcpState): Partial<AcpState> => {
      if (!acceptsSessionTranscriptEvents(s.sessions[e.sessionId])) return {}
      const list = s.toolCalls[e.sessionId] ?? []
      const idx = list.findIndex((t) => t.toolCallId === e.update.toolCallId)
      if (idx === -1) return {}
      // CAP-2: clamp a string `rawOutput` to the live bound so one giant tool
      // result cannot balloon the WebView heap (logged without content;
      // non-string values pass through untouched).
      const update = { ...e.update }
      if (update.rawOutput !== undefined) {
        update.rawOutput = clampLiveRawOutput(e.sessionId, update.toolCallId, update.rawOutput)
      }
      const merged = { ...list[idx], ...update }
      const next = [...list]
      next[idx] = merged
      return { toolCalls: { ...s.toolCalls, [e.sessionId]: next } }
    }
    if (useCoalesce) {
      coalesceSet(e.sessionId, apply)
    } else {
      set(apply)
    }
  },

  _onPlanUpdate: (e) =>
    set((s) => {
      const entries = e.plan.entries ?? []
      if (entries.length === 0) {
        return { plans: dropPlanForSession(s.plans, e.sessionId) }
      }
      // Do not re-grow plan cache for closed/unknown sessions after eviction.
      if (!acceptsSessionTranscriptEvents(s.sessions[e.sessionId])) return {}
      return { plans: { ...s.plans, [e.sessionId]: entries } }
    }),

  _onCommandsUpdate: (e) =>
    set((s) => {
      if (!acceptsSessionTranscriptEvents(s.sessions[e.sessionId])) return {}
      return { commands: { ...s.commands, [e.sessionId]: e.availableCommands ?? [] } }
    }),

  _onModeUpdate: (e) => {
    let preservedModeId: string | null = null
    set((s) => {
      const session = s.sessions[e.sessionId]
      if (!session) return {}
      const availableModes: SessionMode[] =
        e.availableModes && e.availableModes.length > 0
          ? e.availableModes
          : (session.modes?.availableModes ?? [])
      let currentModeId = e.currentModeId
      // Creation-default echo guard: a stale event can re-assert the mode the
      // session was created with while the session has moved to another
      // still-advertised value (e.g. a launcher pick applied after
      // `session/new`). Preserve the moved-off value; a NON-default incoming
      // value is a genuine agent-side change and applies normally.
      const movedOffMode = session.modes?.currentModeId
      const creationDefault = session.creationOptionDefaults?.modeId
      if (
        creationDefault !== undefined &&
        movedOffMode !== undefined &&
        movedOffMode !== e.currentModeId &&
        e.currentModeId === creationDefault &&
        availableModes.some((m) => m.id === movedOffMode)
      ) {
        currentModeId = movedOffMode
        if (!session.creationEchoLogged?.__mode__) preservedModeId = movedOffMode
      }
      return {
        sessions: {
          ...s.sessions,
          [e.sessionId]: {
            ...session,
            modes: { currentModeId, availableModes },
            ...(preservedModeId
              ? { creationEchoLogged: { ...session.creationEchoLogged, __mode__: true } }
              : {})
          }
        }
      }
    })
    if (preservedModeId) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.modeEchoPreserved',
        message: `mode_update for session ${e.sessionId} re-asserted creation default '${e.currentModeId}'; kept current mode '${preservedModeId}'`
      })
    }
    cacheOptionsFromSession(set, get, e.sessionId)
  },

  _onConfigOptionsUpdate: (e) => {
    const preservedOptionIds: string[] = []
    set((s) => {
      const session = s.sessions[e.sessionId]
      if (!session) return {}
      const merged = mergeAgentConfigOptions(session.configOptions, e.configOptions, {
        creationValues: session.creationOptionDefaults?.configValues,
        onEchoPreserved: (optionId) => {
          if (!session.creationEchoLogged?.[optionId]) preservedOptionIds.push(optionId)
        }
      })
      let creationEchoLogged = session.creationEchoLogged
      if (preservedOptionIds.length > 0) {
        creationEchoLogged = { ...creationEchoLogged }
        for (const optionId of preservedOptionIds) creationEchoLogged[optionId] = true
      }
      return {
        sessions: {
          ...s.sessions,
          [e.sessionId]: { ...session, configOptions: merged, creationEchoLogged }
        }
      }
    })
    for (const optionId of preservedOptionIds) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.configOptionEchoPreserved',
        message: `config_option_update for session ${e.sessionId} re-asserted the creation default on '${optionId}'; kept the session's current value`
      })
    }
    cacheOptionsFromSession(set, get, e.sessionId)
  },

  _onSessionInfoUpdate: (e) => {
    // `title` is `undefined` when the field is absent (no change), `null` when
    // the agent explicitly cleared it, or a string when set. An omitted title
    // must leave the existing title (and the persisted index) untouched.
    if (e.title === undefined) return
    const nextTitle = e.title
    set((s) => {
      const session = s.sessions[e.sessionId]
      if (!session) return {}
      return {
        sessions: { ...s.sessions, [e.sessionId]: { ...session, title: nextTitle } }
      }
    })
    // Gate on sessionIndex membership so an un-promoted (ephemeral) pooled
    // session is never persisted by an event before `startChat` promotes it
    // (matches the prompt/error reducers).
    if (
      get().sessions[e.sessionId] &&
      get().sessionIndex.some((entry) => entry.id === e.sessionId)
    ) {
      persistSession(get(), e.sessionId, (entries) => set({ sessionIndex: entries }))
    }
  },

  _onUsageUpdate: (e) => {
    if (!Number.isFinite(e.used) || !Number.isFinite(e.size) || e.size <= 0 || e.used <= 0) {
      return
    }
    set((s) => {
      // Closed shells remain in `sessions` after eviction — still reject usage.
      if (!acceptsSessionTranscriptEvents(s.sessions[e.sessionId])) return {}
      const prev = s.sessionUsage[e.sessionId]
      const baselineUsed = prev?.baselineUsed ?? e.used
      const next: SessionUsage = {
        used: e.used,
        size: e.size,
        baselineUsed,
        updatedAt: Date.now(),
        source: 'reported'
      }
      if (e.cost && Number.isFinite(e.cost.amount) && e.cost.amount > 0 && e.cost.currency) {
        next.cost = { amount: e.cost.amount, currency: e.cost.currency }
      }
      return {
        sessionUsage: { ...s.sessionUsage, [e.sessionId]: next }
      }
    })
  }
})
