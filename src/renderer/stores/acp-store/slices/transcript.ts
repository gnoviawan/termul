/**
 * Transcript slice — extracted from ../acp-store.ts (spec-04 PR B). Pure move, no logic changes.
 */

import type { StateCreator } from 'zustand'
import { stripHandoffPreamble } from '@/components/chat/handoff-summary'
import type {
  ContentBlock,
  SessionId,
  SessionMode,
  SessionUsage,
  ToolCall,
  ToolCallContent
} from '@/lib/acp-api'
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
  sessionTurnBusy,
  toolIntervened,
  trimLiveToolCalls
} from '../helpers'
import { useAcpStore } from '../index'
import {
  acceptedServerPromptTurnIds,
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
 * Tool-call ids whose oversized fields were already clamp-logged (CAP-2/F-2).
 * A streaming giant output re-sends per update; the boundary log fires once
 * per id, not per update. Cleared in `dropSessionTranscriptState`.
 */
const clampedToolCallIds = new Set<string>()

/**
 * Bound for the clamp-log dedup set: entries expire FIFO past the cap so a
 * long-lived session emitting more clamped calls than the live window holds
 * cannot grow the set unboundedly between trims. An evicted id simply
 * re-logs on its next clamp — the cap bounds retention, not correctness.
 */
const MAX_CLAMP_LOGGED_CALL_IDS = 2 * MAX_LIVE_TOOL_CALLS

/**
 * Bounded dedup key for {@link clampedToolCallIds}: agent-sourced ids are
 * unbounded, so the set entry and the log line key on a truncated prefix —
 * a giant id cannot smuggle megabytes into either.
 */
function clampLogKey(toolCallId: string): string {
  return toolCallId.length > MAX_LIVE_TOOL_CALL_TITLE_CHARS
    ? `${toolCallId.slice(0, MAX_LIVE_TOOL_CALL_TITLE_CHARS)}…`
    : toolCallId
}

function logToolCallClampOnce(sessionId: SessionId, toolCallId: string, what: string): void {
  const key = clampLogKey(toolCallId)
  if (clampedToolCallIds.has(key)) return
  // FIFO-evict the oldest entry at the cap (a Set iterates insertion order).
  if (clampedToolCallIds.size >= MAX_CLAMP_LOGGED_CALL_IDS) {
    const oldest = clampedToolCallIds.values().next().value
    if (oldest !== undefined) clampedToolCallIds.delete(oldest)
  }
  clampedToolCallIds.add(key)
  void logFrontendError({
    level: 'warn',
    source: 'acp.store',
    message: `${what} for call ${key} (session ${sessionId})`
  })
}

/** Serialized JSON length, tolerant of non-serializable agent payloads. */
function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Keep the small fields of an over-budget agent object verbatim —
 * `path`/`command`/`query`/`description` drive the chip label, the open-file
 * action, and subagent detection, and `readableOutput`'s text keys drive the
 * card fallback — while the oversized values (a write_file `content` body, a
 * giant embedded blob) are dropped. A projected object still over the bound,
 * or a non-object oversize value, drops entirely. Returns the original
 * reference when the value is already within `boundChars`.
 */
function projectUnderBound(value: unknown, boundChars: number): unknown {
  if (value === undefined || value === null) return value
  if (serializedLength(value) <= boundChars) return value
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const projected: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (serializedLength(entry) <= boundChars) projected[key] = entry
  }
  return serializedLength(projected) <= boundChars ? projected : undefined
}

/**
 * Clamp a `rawOutput` to the live bound (CAP-2/F-2). String outputs clamp at
 * {@link MAX_LIVE_RAW_OUTPUT_CHARS} + a truncation marker; non-string agent
 * payloads keep only their small fields (the same projection `rawInput`
 * gets) so a giant embedded blob cannot bypass the bound by arriving as an
 * object. Returns the original value when no clamp is needed. Logs the clamp
 * WITHOUT the content — once per toolCallId.
 */
function clampLiveRawOutput(sessionId: SessionId, toolCallId: string, rawOutput: unknown): unknown {
  if (typeof rawOutput !== 'string') {
    const projected = projectUnderBound(rawOutput, MAX_LIVE_RAW_OUTPUT_CHARS)
    if (projected !== rawOutput) {
      logToolCallClampOnce(sessionId, toolCallId, 'Clamped tool rawOutput')
    }
    return projected
  }
  if (rawOutput.length <= MAX_LIVE_RAW_OUTPUT_CHARS) return rawOutput
  logToolCallClampOnce(sessionId, toolCallId, 'Clamped tool rawOutput')
  return rawOutput.slice(0, MAX_LIVE_RAW_OUTPUT_CHARS) + RAW_OUTPUT_TRUNCATION_MARKER
}

/**
 * Maximum UTF-16 length of a single text leaf inside a live tool call's
 * `content` items, and of a serialized `rawInput` (CAP-2 gap — F-2).
 * `rawOutput` already clamps at {@link MAX_LIVE_RAW_OUTPUT_CHARS}, but diff
 * `oldText`/`newText` (full file bodies) and write-file `rawInput` payloads
 * bypassed the live bound entirely: the host forwards tool calls verbatim,
 * so 500 retained calls × unbounded fields let a few ACP sessions grow the
 * WebView heap by gigabytes (#901). 64 KiB per leaf keeps ordinary file
 * diffs rendering while bounding the pathological cases; a marker suffix
 * keeps the clamp visible instead of looking like corrupt data.
 */
const MAX_LIVE_TOOL_CALL_FIELD_CHARS = 64 * 1024

/**
 * Serialized bound for a live call's whole `content` array after per-item
 * clamps. Still-over-budget content degrades field-wise — the same degrade
 * the durable mirror (`sanitizeToolCallsForPersistence`) applies to
 * over-budget calls — rather than retaining megabytes of serialized items.
 */
const MAX_LIVE_TOOL_CALL_CONTENT_CHARS = 256 * 1024

/**
 * Catch-all serialized bound for one live tool call after every field clamp
 * (F-2). `ToolCall`'s index signature lets an agent attach arbitrary fields;
 * `locations` and other unaccounted payloads would otherwise bypass the
 * per-field bounds. A call still over this limit degrades to its structural
 * subset — the same contract the durable mirror applies.
 */
const MAX_LIVE_TOOL_CALL_TOTAL_CHARS = 384 * 1024

/** Agent-controlled titles are unbounded strings — bound them like the durable path. */
const MAX_LIVE_TOOL_CALL_TITLE_CHARS = 1024

/** `locations` is a UI hint array; more than a few dozen is pathological. */
const MAX_LIVE_TOOL_CALL_LOCATIONS = 32

/** Marker text appended to a clamped diff/text leaf. */
const FIELD_TRUNCATION_MARKER = '\n[termul: tool call content truncated]'

/** Marker substituted for a non-text/unknown content item over the field bound. */
const OMITTED_CONTENT_ITEM: ToolCallContent = {
  type: 'content',
  content: { type: 'text', text: '[termul: oversized tool call content item omitted]' }
}

function clampLiveFieldText(text: string): string {
  return text.length <= MAX_LIVE_TOOL_CALL_FIELD_CHARS
    ? text
    : text.slice(0, MAX_LIVE_TOOL_CALL_FIELD_CHARS) + FIELD_TRUNCATION_MARKER
}

/**
 * Bound a single streamed `ContentBlock` (F-2 sibling). Text blocks pass
 * through — message prose is legitimately long and merges into the trailing
 * stream. Non-text blocks (image/audio/resource) carry protocol payloads via
 * the index signature and render only as placeholders, so an oversized one
 * is pure retention: replace it with an explicit marker text block.
 */
function clampLiveContentBlock(block: ContentBlock): ContentBlock {
  if (block?.type === 'text') return block
  if (serializedLength(block) <= MAX_LIVE_TOOL_CALL_FIELD_CHARS) return block
  return { type: 'text', text: '[termul: oversized content block omitted]' }
}

/**
 * Bound a live tool call's structured `content` (F-2): diff `oldText`/
 * `newText` and text-block leaves clamp at {@link MAX_LIVE_TOOL_CALL_FIELD_CHARS}
 * so the card still renders a (marked) partial diff; any other oversized item —
 * non-text blocks like image base64, unknown agent shapes — is replaced
 * wholesale since a partially-clamped unknown shape is more misleading than an
 * explicit omission. An array still over {@link MAX_LIVE_TOOL_CALL_CONTENT_CHARS}
 * after leaf clamps drops the field entirely. Returns the same reference when
 * nothing needed bounding.
 */
function clampLiveToolCallContent(
  content: ToolCallContent[] | undefined
): ToolCallContent[] | undefined {
  if (!Array.isArray(content)) return content
  let changed = false
  const next = content.map((item) => {
    if (item?.type === 'diff') {
      const oldText =
        typeof item.oldText === 'string' ? clampLiveFieldText(item.oldText) : item.oldText
      const newText =
        typeof item.newText === 'string' ? clampLiveFieldText(item.newText) : item.newText
      if (oldText === item.oldText && newText === item.newText) return item
      changed = true
      return { ...item, oldText, newText }
    }
    if (item?.type === 'content') {
      const block = (item as { content?: ContentBlock }).content
      if (
        block?.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.length > MAX_LIVE_TOOL_CALL_FIELD_CHARS
      ) {
        changed = true
        return { ...item, content: { ...block, text: clampLiveFieldText(block.text) } }
      }
    }
    // 'terminal' items are tiny; anything else oversized — non-text content
    // blocks like image base64, or unknown item shapes — is replaced
    // wholesale since a partially clamped unknown shape is more misleading
    // than an explicit omission. The bound is 2× the leaf clamp so a
    // legitimate max-size text leaf + JSON envelope is never mistaken for
    // an oversized item.
    if (serializedLength(item) > MAX_LIVE_TOOL_CALL_FIELD_CHARS * 2) {
      changed = true
      return OMITTED_CONTENT_ITEM
    }
    return item
  })
  const candidate = changed ? next : content
  return serializedLength(candidate) > MAX_LIVE_TOOL_CALL_CONTENT_CHARS ? undefined : candidate
}

/** The agent-controlled fields bounded by {@link clampLiveToolCallFields}. */
type LiveToolCallShape = {
  toolCallId: string
  title?: string
  kind?: ToolCall['kind']
  status?: ToolCall['status']
  content?: ToolCallContent[]
  locations?: ToolCall['locations']
  rawInput?: unknown
  rawOutput?: unknown
  [k: string]: unknown
}

/**
 * Rewrite one field on a clamped copy: a dropped (`undefined`) value DELETES
 * the key. Spread merges (`{ ...stored, ...update }`) copy an explicit
 * `undefined` over the stored field — a key that is absent instead preserves
 * it, so an over-budget incoming `content`/`rawInput`/`rawOutput` cannot
 * blank a card whose previously stored value was in bounds.
 */
function rewriteField<T extends LiveToolCallShape>(call: T, key: string, value: unknown): T {
  const next: Record<string, unknown> = { ...call }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next as T
}

/**
 * Clamp the unbounded agent-controlled fields on a live tool call or update
 * (F-2): `title`, `kind`, `status`, structured `content`, `rawInput`,
 * `rawOutput`, and `locations`. A call still over
 * {@link MAX_LIVE_TOOL_CALL_TOTAL_CHARS} after field clamps — index-signature
 * extras or other unaccounted payloads — degrades to the structural subset
 * (id/kind/status/title/stamps + already-bounded render fields), the same
 * contract the durable mirror applies to over-budget calls. When even the
 * structural subset exceeds the bound — the `toolCallId` itself is the
 * payload and cannot be truncated without breaking upsert/update
 * correlation — the call is omitted entirely (`null`), matching
 * `sanitizeToolCallsForPersistence`. Returns the same object when nothing
 * needed bounding; clamps log once per toolCallId, without the content.
 */
export function clampLiveToolCallFields<T extends LiveToolCallShape>(
  sessionId: SessionId,
  call: T
): T | null {
  // `toolCallId` is the record's identity: truncating it would orphan every
  // later update/upsert, and retaining it unbounded defeats the live bound.
  // The durable mirror omits a call whose structural subset alone exceeds
  // the budget — the live path drops the same way.
  if (
    typeof call.toolCallId !== 'string' ||
    call.toolCallId.length > MAX_LIVE_TOOL_CALL_FIELD_CHARS
  ) {
    logToolCallClampOnce(sessionId, String(call.toolCallId), 'Dropped over-size tool call')
    return null
  }
  const title =
    typeof call.title === 'string' && call.title.length > MAX_LIVE_TOOL_CALL_TITLE_CHARS
      ? `${call.title.slice(0, MAX_LIVE_TOOL_CALL_TITLE_CHARS)}…`
      : call.title
  // `kind`/`status` are enum hints — bound them like agent titles so neither
  // the stored call nor the structural subset carries a giant string.
  const kind: ToolCall['kind'] =
    typeof call.kind === 'string' && call.kind.length > MAX_LIVE_TOOL_CALL_TITLE_CHARS
      ? `${call.kind.slice(0, MAX_LIVE_TOOL_CALL_TITLE_CHARS)}…`
      : call.kind
  const status: ToolCall['status'] =
    typeof call.status === 'string' && call.status.length > MAX_LIVE_TOOL_CALL_TITLE_CHARS
      ? `${call.status.slice(0, MAX_LIVE_TOOL_CALL_TITLE_CHARS)}…`
      : call.status
  const content = clampLiveToolCallContent(call.content)
  const rawInput = projectUnderBound(call.rawInput, MAX_LIVE_TOOL_CALL_FIELD_CHARS)
  const rawOutput = clampLiveRawOutput(sessionId, call.toolCallId, call.rawOutput)
  const locations =
    Array.isArray(call.locations) && call.locations.length > MAX_LIVE_TOOL_CALL_LOCATIONS
      ? call.locations.slice(0, MAX_LIVE_TOOL_CALL_LOCATIONS)
      : call.locations
  // Only rewrite fields that actually changed: an update that never carried
  // `content`/`rawInput`/… must not merge explicit `undefined` over the
  // stored call's fields — and neither may a field that WAS carried but had
  // to be dropped as oversized (rewriteField deletes the key instead).
  let next = call
  if (title !== call.title) next = { ...next, title }
  if (kind !== call.kind) next = { ...next, kind }
  if (status !== call.status) next = { ...next, status }
  if (content !== call.content) next = rewriteField(next, 'content', content)
  if (rawInput !== call.rawInput) next = rewriteField(next, 'rawInput', rawInput)
  if (rawOutput !== call.rawOutput) next = rewriteField(next, 'rawOutput', rawOutput)
  if (locations !== call.locations) next = { ...next, locations }
  if (serializedLength(next) <= MAX_LIVE_TOOL_CALL_TOTAL_CHARS) {
    if (next !== call) {
      logToolCallClampOnce(sessionId, call.toolCallId, 'Clamped oversized tool call fields')
    }
    return next
  }
  logToolCallClampOnce(sessionId, call.toolCallId, 'Degraded oversized tool call')
  const reduced: Record<string, unknown> = { toolCallId: call.toolCallId }
  if (typeof next.title === 'string') reduced.title = next.title
  // kind/status are already hint-clamped; gate them anyway so a non-string
  // agent value cannot carry an unbounded payload into the subset.
  for (const key of ['kind', 'status'] as const) {
    if (next[key] !== undefined && serializedLength(next[key]) <= MAX_LIVE_TOOL_CALL_FIELD_CHARS) {
      reduced[key] = next[key]
    }
  }
  // Render fields ride along only while individually bounded — a location
  // path or object output could itself be the unaccounted payload.
  if (
    next.locations !== undefined &&
    serializedLength(next.locations) <= MAX_LIVE_TOOL_CALL_FIELD_CHARS
  ) {
    reduced.locations = next.locations
  }
  if (next.rawOutput !== undefined) reduced.rawOutput = next.rawOutput
  for (const key of ['timestamp', 'seq'] as const) {
    if (typeof next[key] === 'number') reduced[key] = next[key]
  }
  // Re-measure like the durable mirror: every field above is individually
  // bounded, so this only trips if a future field slips through — the bound
  // must provably hold rather than be assumed.
  return serializedLength(reduced) <= MAX_LIVE_TOOL_CALL_TOTAL_CHARS ? (reduced as T) : null
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
    clampedToolCallIds.delete(clampLogKey(call.toolCallId))
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
let coalesceTimerId: ReturnType<typeof setTimeout> | null = null

/**
 * Max delay the coalesced buffer may sit undrained when rAF is suspended.
 * WebView2 keeps the rAF callback armed but never fires it while the window
 * is occluded/minimized — the PTY sibling (`use-terminal-detached-output`)
 * carries the same 250 ms backstop for the same reason. Without it a hidden-
 * but-streaming session buffers chunk updates unboundedly (F-1, the #133
 * memory-growth class) until the next repaint.
 */
const COALESCE_BACKSTOP_MS = 250

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

function cancelCoalesceSchedule(): void {
  if (coalesceRafId !== null) {
    cancelAnimationFrame(coalesceRafId)
    coalesceRafId = null
  }
  if (coalesceTimerId !== null) {
    clearTimeout(coalesceTimerId)
    coalesceTimerId = null
  }
}

function scheduleCoalesceFlush(): void {
  if (coalesceRafId !== null || coalesceTimerId !== null) return
  // rAF stays the primary scheduler; the timer only covers the suspended-rAF
  // case (occluded/minimized WebView). Whichever fires first drains the
  // buffer and clears both. When rAF is unavailable the 16 ms timer simply
  // replicates the per-frame cadence.
  coalesceRafId =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flushCoalesced) : null
  coalesceTimerId = setTimeout(flushCoalesced, coalesceRafId === null ? 16 : COALESCE_BACKSTOP_MS)
}

/**
 * Drain the coalesced buffer and apply a single merged `set()`. Each buffered
 * update is applied sequentially against a working copy so the second event
 * sees the first event's result. Live windows (messages + tool calls) are
 * trimmed for affected sessions after all updates are merged; buffered text
 * deltas are sealed into their blocks BEFORE the `set()` returns its patch.
 */
function flushCoalesced(): void {
  cancelCoalesceSchedule()
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

/** Cancel any pending schedule and flush synchronously (turn-complete / disconnect). */
export function flushCoalescedSync(): void {
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

/** Test-only: reset coalescing state (clear buffer + cancel pending schedule). */
export function _resetCoalesceForTesting(): void {
  cancelCoalesceSchedule()
  coalescedBuffer = []
  textDeltaParts.clear()
}

/** Test-only: check whether a coalesce flush is pending. */
export function _isCoalescePendingForTesting(): boolean {
  return coalesceRafId !== null || coalesceTimerId !== null || coalescedBuffer.length > 0
}

/** Test-only: clear the loading-older guard set. */
export function _resetLoadingOlderForTesting(): void {
  loadingOlderSessions.clear()
}

/** Test-only: current size of the clamp-log dedup set (bounded-cache proof). */
export function _clampedToolCallIdsSizeForTesting(): number {
  return clampedToolCallIds.size
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
    // Issue #846: an echo citing a turn id is the server's proof the prompt
    // was accepted (and persisted) BEFORE the agent dispatch. Record it so a
    // later transport drop during the turn resolves as "outcome unknown" in
    // `runPromptTurn`'s catch — resubscribe, never blind re-send. Cleared
    // when the dispatch settles.
    if (e.turnId) acceptedServerPromptTurnIds.add(e.turnId)
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
    // F-2 sibling: bound non-text block payloads (attachment/resource data)
    // at ingest — the echo path carries the same unbounded wire blocks.
    const content = [...wireBlocksToDisplay(e.content)].map(clampLiveContentBlock)
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
      const duplicate =
        (e.turnId && list.some((message) => message.id === `turn:${e.turnId}`)) ||
        (trailingUser && sameBlocks(trailingUser.blocks, content))
      // Issue #838: a live `user_prompt` echo means a turn is running — the
      // sending tab set `activeTurn` itself, but a second device (or a
      // reloaded tab that reconnected mid-turn) only sees this echo. Mark the
      // turn active whenever the session is not already busy so the spinner,
      // stop button, and queue flush work everywhere. Do NOT clear it here:
      // `_onPromptComplete`/`scheduleTurnEnd` own the close.
      const markTurnActive = !duplicate && !sessionTurnBusy(session) && session.status !== 'closed'
      const message: ChatMessage = {
        id: e.turnId ? `turn:${e.turnId}` : newId('msg'),
        role: 'user',
        blocks: content,
        streaming: false,
        timestamp: Date.now(),
        seq: nextSeq()
      }
      if (duplicate) return {}
      return {
        messages: { ...s.messages, [e.sessionId]: [...list, message] },
        sessions: markTurnActive
          ? {
              ...s.sessions,
              [e.sessionId]: {
                ...session,
                activeTurn: true,
                openTurnId: e.turnId ? `turn:${e.turnId}` : session.openTurnId
              }
            }
          : s.sessions
      }
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
      // F-2 sibling: bound non-text block payloads (image/resource base64) at
      // ingest — the host forwards blocks verbatim and unbounded.
      const content = clampLiveContentBlock(e.content)
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
      const sameMessageId = Boolean(
        e.messageId && last?.messageId && last.messageId === e.messageId
      )
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
      // CAP-2/F-2: clamp `rawOutput`/`title`/`content`/`rawInput`/`locations`
      // on the initial call too — the host forwards them verbatim and
      // unbounded, so an oversized first emission must not bypass the bound.
      const stamped = clampLiveToolCallFields(e.sessionId, {
        ...e.toolCall,
        timestamp: typeof e.toolCall.timestamp === 'number' ? e.toolCall.timestamp : Date.now(),
        seq: typeof e.toolCall.seq === 'number' ? e.toolCall.seq : nextSeq()
      })
      // Dropped entirely: even the structural subset exceeds the live bound
      // (the agent-sent toolCallId/kind/status alone is oversized).
      if (!stamped) return {}
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
      // Re-clamp the MERGED call: only clamping the update would let
      // successive payloads accumulate distinct fields in the stored call
      // past the live bound.
      const merged = clampLiveToolCallFields(e.sessionId, {
        ...list[idx],
        ...stamped,
        timestamp: list[idx].timestamp,
        seq: list[idx].seq
      })
      if (!merged) return {}
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
      // CAP-2/F-2: clamp `rawOutput`/`title`/`content`/`rawInput`/`locations`
      // to the live bounds so one giant tool payload cannot balloon the
      // WebView heap (logged once per call, without the content).
      const clampedUpdate = clampLiveToolCallFields(e.sessionId, e.update)
      if (!clampedUpdate) return {}
      // Then clamp the MERGED call, not just the update: successive updates
      // carrying different arbitrary fields would otherwise accumulate in
      // `list[idx]` and grow one retained call past the live bound.
      const merged = clampLiveToolCallFields(e.sessionId, { ...list[idx], ...clampedUpdate })
      if (!merged) return {}
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
