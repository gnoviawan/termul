/**
 * Pure helper functions for the ACP store — extracted from `../acp-store.ts`
 * (spec-04 PR A). Everything here is stateless: no module-level singletons
 * and no store closure — `set`/`get` arrive as parameters.
 */

import { stripHandoffPreamble } from '@/components/chat/handoff-summary'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import type {
  AgentId,
  ContentBlock,
  McpServer,
  PlanEntry,
  SessionConfigOption,
  SessionId,
  SessionModelState,
  SessionModeState,
  StopReason,
  ToolCall
} from '@/lib/acp-api'
import type { AgentSwitchRecord, SessionIndexEntry } from '@/lib/acp-history-persistence'
import { getAcpTransport } from '@/lib/acp-transport'
import { agentConfigIdentityKey } from '@/lib/agents/acp-config-identity'
import { type AgentAuthPolicy, agentPolicyForConfigId } from '@/lib/agents/acp-registry'
import { classifySetupError, isAgentAuthRequiredError } from '@/lib/agents/acp-spawn-errors'
import { logFrontendError } from '@/lib/log-api'
import {
  parseFileSegments,
  replaceFileTokensInline,
  SKILL_PAD_END,
  SKILL_PAD_START
} from '@/lib/skill-tokens'
import { wireBlocksToDisplay, wireTextToDisplay } from '@/lib/skills-wire-reverse'
import { randomUUID } from '@/lib/uuid'
import { agentReuseKey, configIdFromReuseKey, detachedReuseKey } from '../acp-reuse-keys'
import {
  buildRecoverPromptToQueuePatch,
  dropPromptQueueForSession,
  type QueuedPrompt,
  sessionTurnBusy
} from '../prompt-queue-orchestration'

// Re-export so the transcript/session slices can consult turn-busy state via
// the shared helpers surface they already import (issue #838/#846 wiring).
export { sessionTurnBusy }

import type {
  AcpGet,
  AcpSession,
  AcpSet,
  AcpState,
  AgentIdentity,
  AgentOptionsCacheEntry,
  AgentStatus,
  ChatMessage,
  CommitMessageCollector,
  ConfigWarmState,
  GeneratedCommitMessage,
  MessageRole,
  PendingPermission,
  PendingQuestion,
  ReopenControlBaseline,
  TurnEndSetter
} from './types'

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

/** True when history is server-authoritative (web/remote `server` mode). */
export function isServerHistoryMode(): boolean {
  return getAcpTransport().historyMode?.() === 'server'
}

/**
 * True when the message carries user-visible content. A user bubble whose
 * text blocks are all blank (the host's synthetic greeting prompt) is hidden.
 */
export function hasVisibleContent(message: ChatMessage): boolean {
  return message.blocks.some((block) =>
    block.type === 'text' ? (block.text ?? '').trim().length > 0 : true
  )
}

/**
 * CAP-3 replay contract partition: splits a transcript into the visible
 * messages and the seq intervals `[start, end)` of the hidden turns (dropped
 * content). A hidden turn opens at the first dropped message carrying a
 * numeric seq — at 0 for the leading prefix, whose span starts at the
 * conversation head — and closes at the next visible user bubble; a trailing
 * hidden turn runs to +∞. Tool cards whose seq falls inside a hidden interval
 * belong to a dropped turn and must not render either.
 *
 * Hidden / pre-first-user-prompt turns never render: everything before the
 * first visible user bubble (leading agent/thought bubbles of the agent's
 * hidden greeting turn) and every empty-content user bubble together with the
 * agent/thought bubbles that follow it (a synthetic prompt turn) up to the
 * next visible user bubble.
 */
export function partitionTranscriptTurns(messages: ChatMessage[]): {
  visible: ChatMessage[]
  hidden: Array<[number, number]>
} {
  const visible: ChatMessage[] = []
  const hidden: Array<[number, number]> = []
  let hiddenTurn = true
  let intervalStart: number | null = null
  for (const message of messages) {
    // A summary-only handoff boundary row renders nothing but still opens a
    // visible turn — a switch turn is real work, not a synthetic greeting.
    const boundary = message.role === 'user' && message.handoffBoundary === true
    if (boundary) {
      // Close any open hidden interval but keep the boundary row itself OUT
      // of `visible` — its empty blocks would render as a ghost bubble.
      hiddenTurn = false
      if (intervalStart !== null && typeof message.seq === 'number') {
        hidden.push([intervalStart, message.seq])
      }
      intervalStart = null
      continue
    }
    if (message.role === 'user') {
      hiddenTurn = !hasVisibleContent(message)
      if (!hiddenTurn) {
        // A visible user bubble closes any open hidden-turn interval. Without
        // a numeric close seq the interval is dropped entirely (conservative:
        // later cards cannot be attributed to the hidden turn reliably).
        if (intervalStart !== null && typeof message.seq === 'number') {
          hidden.push([intervalStart, message.seq])
        }
        intervalStart = null
        visible.push(message)
        continue
      }
    } else if (!hiddenTurn) {
      visible.push(message)
      continue
    }
    // Dropped (hidden) message: open the interval at its seq.
    if (intervalStart === null && typeof message.seq === 'number') {
      intervalStart = visible.length === 0 && hidden.length === 0 ? 0 : message.seq
    }
  }
  if (intervalStart !== null) hidden.push([intervalStart, Number.POSITIVE_INFINITY])
  return { visible, hidden }
}

/**
 * CAP-3 replay contract: hidden / pre-first-user-prompt turns never render.
 */
export function dropHiddenTranscriptTurns(messages: ChatMessage[]): ChatMessage[] {
  const { visible } = partitionTranscriptTurns(messages)
  return visible.length === messages.length ? messages : visible
}

/**
 * Drop restored tool cards that belong to any hidden turn (their seq falls
 * inside a hidden-turn interval established by `partitionTranscriptTurns`).
 * Cards without a numeric seq and cards of visible turns survive.
 */
export function dropHiddenToolCalls(
  toolCalls: ToolCall[],
  visible: ChatMessage[],
  hidden: Array<[number, number]>
): ToolCall[] {
  if (visible.length === 0) return []
  if (hidden.length === 0) return toolCalls
  const filtered = toolCalls.filter((call) => {
    const seq = call.seq
    if (typeof seq !== 'number') return true
    return !hidden.some(([start, end]) => seq >= start && seq < end)
  })
  return filtered.length === toolCalls.length ? toolCalls : filtered
}

/**
 * Normalize a persisted/replayed user bubble's text blocks from WIRE text to
 * DISPLAY text (skill/command chips). The durable `user_prompt` record and
 * every replayed user chunk carry the path-framed wire text; the live
 * optimistic message carries the token text that renders as chips. Applying
 * `wireBlocksToDisplay` here restores chip rendering on resume without
 * touching the wire contract (the agent + durable log stay wire-text).
 * Non-user roles pass through untouched — the agent may legitimately echo
 * the framing in prose.
 */
export function normalizeUserMessageBlocks(message: ChatMessage): ChatMessage {
  if (message.role !== 'user') return message
  // spec-agent-switch-separator-redesign: a user bubble re-streamed from
  // message_chunks (recovery fold) still carries the handoff wire framing —
  // the `user_prompt` fold strips it, this pass covers the chunk path.
  // Fully-stripped → a handoff BOUNDARY row: renders nothing but keeps the
  // switch turn's reply visible (a switch turn is real, not a greeting).
  const first = message.blocks[0] as ContentBlock | undefined
  let blocks = message.blocks
  let boundary = message.handoffBoundary === true
  if (first?.type === 'text' && typeof first.text === 'string') {
    const stripped = stripHandoffPreamble(first.text)
    if (stripped === null) {
      blocks = message.blocks.slice(1)
      if (blocks.length === 0) {
        if (boundary) return message
        return { ...message, blocks: [], handoffBoundary: true }
      }
      boundary = false
    } else if (stripped !== first.text) {
      blocks = [{ ...first, text: stripped }, ...message.blocks.slice(1)]
    }
  }
  const display = wireBlocksToDisplay(blocks as Array<{ type: string; text?: string }>)
  return (display as ChatMessage['blocks']) === message.blocks && !boundary
    ? message
    : { ...message, blocks: display as ChatMessage['blocks'], handoffBoundary: boundary }
}
/** `normalizeUserMessageBlocks` over a list. */
export function normalizeUserMessages(list: ChatMessage[]): ChatMessage[] {
  return list.map(normalizeUserMessageBlocks)
}

/** Index of the last user message in a thread, or -1 if none. */
export function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/** Concatenated text of a message's text blocks (cross-dialect twin compare). */
export function transcriptText(message: ChatMessage): string {
  let text = ''
  for (const block of message.blocks) {
    if (block.type === 'text') text += block.text ?? ''
  }
  return text
}

/**
 * A `\uE002…\uE003` caret-alignment padding block. Live display text carries
 * one after each skill token; the wire framer drops it, so the persisted
 * twin never has it. Stripping the block (rather than running the text
 * through `sanitizeDisplayText`) keeps the `\uE000…\uE001` / `\uE004…\uE005`
 * sentinels in the canonical form — a real chip must never collapse onto
 * literal `(name)` / `/cmd` text the user may have typed.
 */
export const SKILL_PAD_BLOCK_RE = new RegExp(
  `${SKILL_PAD_START}[^${SKILL_PAD_END}]*${SKILL_PAD_END}`,
  'g'
)

/**
 * Canonical text for the persisted/live twin compare. The optimistic live
 * user bubble stores DISPLAY text — skill `\uE000…\uE001` tokens carrying a
 * caret-alignment padding block (`\uE002…\uE003`), `\uE004…\uE005` command
 * tokens, `\uE006…\uE007` file tokens — while the durable `user_prompt`
 * record stores WIRE text (path-framed skills, `/cmd` prefix, `(file)`
 * markers, and the wire framer's `.trim()`), normalized back to display
 * tokens — without padding — on restore. Comparing raw text misses that
 * twin and scroll-up backfill re-prepends the first prompt, so drop the
 * live-only padding blocks and edge whitespace on both sides while KEEPING
 * the skill/command sentinels: chip text must stay distinguishable from
 * literal `(name)` / `/cmd` text or backfill could discard a distinct
 * prompt. File tokens reduce to their `(display)` marker — the wire form —
 * because the chip never round-trips (the file rides a `resource_link`
 * block); the resulting `(display)` vs literal ambiguity is resolved by
 * `twinFileEvidence`. `wireTextToDisplay` also runs on the persisted side
 * so a record that skipped display normalization still canonicalizes (it
 * is a passthrough for any text lacking the exact framing).
 */
export function canonicalTwinText(message: ChatMessage): string {
  const text = transcriptText(message)
  const display = message.role === 'user' ? wireTextToDisplay(text) : text
  return replaceFileTokensInline(display.replace(SKILL_PAD_BLOCK_RE, '')).trim()
}

/**
 * File/attachment evidence for a twin pair, in each side's own dialect: a
 * live user bubble carries `\uE006…\uE007` mention tokens and appended
 * attachment blocks; the persisted record carries the `resource_link` /
 * `resource` / `image` / `audio` blocks it was dispatched with. Canonical
 * text cannot separate a persisted file chip's `(display)` marker from a
 * literally-typed `(display)` — without this check backfill could silently
 * discard a real prompt that merely text-collides with a live chip.
 */
export function twinFileEvidence(message: ChatMessage): string[] {
  const evidence: string[] = []
  for (const seg of parseFileSegments(transcriptText(message))) {
    if (seg.kind === 'file') evidence.push(`file:${seg.display}`)
  }
  for (const block of message.blocks) {
    if (block.type === 'resource_link' || block.type === 'resource') {
      const name = (block.name as string | undefined) ?? (block.uri as string | undefined) ?? ''
      evidence.push(`file:${name}`)
    } else if (block.type === 'image' || block.type === 'audio') {
      evidence.push(`${block.type}:${(block.mimeType as string | undefined) ?? ''}`)
    }
  }
  // Set: the wire dedupes same-path mentions into one resource_link while the
  // display keeps every inline token — count each distinct mention once.
  return [...new Set(evidence)].sort()
}

/**
 * True when `persisted` is the durable copy of a bubble already in the live
 * window. Id and seq dialects legitimately diverge across the live/persisted
 * boundary — the desktop host logs `user:seq-*` for a `turn:*` optimistic
 * bubble, and `snapshot:<role>:*` folds a `msg-*` live stream — so scroll-up
 * backfill must dedupe by content, not just id. A still-streaming live
 * bubble may be a strict prefix of its persisted twin (the host logged more
 * chunks before the read); `seamAligned` restricts that looser rule to pairs
 * near the live/persisted seam. Empty-text bubbles (e.g. an image-only
 * prompt) fall back to full block equality.
 */
export function isPersistedTwin(
  persisted: ChatMessage,
  liveMessage: ChatMessage,
  seamAligned: boolean
): boolean {
  if (persisted.role !== liveMessage.role) return false
  const persistedText = canonicalTwinText(persisted)
  const liveText = canonicalTwinText(liveMessage)
  if (persistedText === liveText) {
    if (persistedText.length === 0) {
      return JSON.stringify(persisted.blocks) === JSON.stringify(liveMessage.blocks)
    }
    // `(display)` text alone cannot tell a persisted file chip (which rides a
    // resource block) from literally-typed `(display)` text — require the
    // file/attachment evidence to match so a real prompt is never dropped on
    // a text collision. User-only concern; other roles never carry chips.
    return (
      persisted.role !== 'user' ||
      JSON.stringify(twinFileEvidence(persisted)) === JSON.stringify(twinFileEvidence(liveMessage))
    )
  }
  return (
    seamAligned &&
    liveMessage.streaming === true &&
    liveText.length > 0 &&
    persistedText.startsWith(liveText)
  )
}

/**
 * True when `messages` ends with an in-progress assistant reply to the latest
 * user message. Covers late chunks delivered after `finalizeStreaming` cleared
 * `streaming` but before the UI turn fully closed.
 */
export function hasActiveAssistantTail(messages: ChatMessage[], role: MessageRole): boolean {
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
export function toolIntervened(toolCalls: ToolCall[], message: ChatMessage): boolean {
  if (message.seq == null) return false
  return toolCalls.some((t) => typeof t.seq === 'number' && t.seq > message.seq!)
}

/** Whether a chunk may open a new message (not coalesced into the previous one). */
export function mayStartChunkMessage(
  session: AcpSession,
  messages: ChatMessage[],
  role: MessageRole
): boolean {
  if (session.openTurnId) return true
  // A session/load replay re-streams the whole conversation (user and agent
  // turns alike) outside any prompt turn; every replayed chunk may open a
  // bubble.
  if (session.replaying) return true
  const last = messages[messages.length - 1]
  if ((role === 'agent' || role === 'thought') && last?.role === 'user') return true
  return false
}

/** Human-readable note for a non-`end_turn` stop reason, or null if none needed. */
export function noteForStopReason(reason: StopReason): string | null {
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
    case 'interrupted':
      // Issue #842: the server wrote this synthetic marker at shutdown —
      // the turn was cut off mid-flight, not finished or user-cancelled.
      return 'Interrupted by server restart.'
    default:
      return `Response stopped: ${reason}`
  }
}

/**
 * Finalize every streaming message for a session (mark non-streaming). A turn
 * can leave several messages mid-stream (e.g. a thought followed by the agent
 * reply); clearing only the trailing one strands earlier markers in their
 * `streaming` state and leaves their shimmer animating forever.
 *
 * A streaming USER bubble is normalized from wire text to display (chip)
 * text here: replayed user-role chunks are kept in raw wire form while they
 * accumulate (the framing may split across chunks — a partial prefix cannot
 * be parsed), and this is the single point where the completed, fully-joined
 * text is reconstructed. Non-streaming messages are left untouched (the
 * payload/recovery install paths already normalized them).
 */
export function finalizeStreaming(
  messages: Record<SessionId, ChatMessage[]>,
  sessionId: SessionId
): Record<SessionId, ChatMessage[]> {
  const list = messages[sessionId] ?? []
  if (!list.some((m) => m.streaming)) return messages
  return {
    ...messages,
    [sessionId]: list.map((m) =>
      m.streaming ? (normalizeUserMessageBlocks({ ...m, streaming: false }) ?? m) : m
    )
  }
}

/** Mark a reopened history session live after a successful load/resume IPC call. */
export function withSessionActive(
  sessions: Record<SessionId, AcpSession>,
  sessionId: SessionId
): Record<SessionId, AcpSession> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return { ...sessions, [sessionId]: { ...session, status: 'active', lastError: null } }
}

/** Surface a failed history load/resume on the session without changing status. */
export function withSessionResumeError(
  sessions: Record<SessionId, AcpSession>,
  sessionId: SessionId,
  err: unknown
): Record<SessionId, AcpSession> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return {
    ...sessions,
    [sessionId]: { ...session, replaying: null, lastError: `Resume failed: ${String(err)}` }
  }
}

/** Remove all pending permissions belonging to a session. */
export function dropPermissionsForSession(
  pending: Record<string, PendingPermission>,
  sessionId: SessionId
): Record<string, PendingPermission> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].sessionId === sessionId) delete next[id]
  }
  return next
}

/** Remove cached plan entries for a session (close or new prompt turn). */
export function dropPlanForSession(
  plans: Record<SessionId, PlanEntry[]>,
  sessionId: SessionId
): Record<SessionId, PlanEntry[]> {
  if (!(sessionId in plans)) return plans
  const next = { ...plans }
  delete next[sessionId]
  return next
}

/**
 * Parse the LAST ```termul-plan fence out of a markdown text blob. Returns
 * the parsed `PlanEntry[]` when the JSON is a valid array, or `null` when
 * there is no fence or the JSON is malformed. Last-fence-wins matches the
 * snapshot contract: each assistant message carries at most one renderer-
 * authored snapshot, and a rehydrate must surface the most recent one.
 */
export function parseTermulPlanFence(text: string | undefined): PlanEntry[] | null {
  const json = extractTermulPlanFenceJson(text)
  if (json === null) return null
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    // Coerce to PlanEntry[]: keep only objects with a string `content`; drop
    // malformed entries so a single bad entry doesn't poison the whole plan.
    // `status` and `priority` are optional but must be strings when present.
    return parsed.filter((entry): entry is PlanEntry => {
      if (entry === null || typeof entry !== 'object') return false
      const e = entry as PlanEntry
      if (typeof e.content !== 'string') return false
      if (e.status !== undefined && typeof e.status !== 'string') return false
      if (e.priority !== undefined && typeof e.priority !== 'string') return false
      return true
    })
  } catch {
    return null
  }
}

/**
 * Extract the raw JSON string from the LAST ```termul-plan fence in the text.
 * Returns `null` when no fence is present. Used by the rehydrate path to
 * distinguish "no fence" (skip silently) from "malformed fence JSON" (warn).
 */
export function extractTermulPlanFenceJson(text: string | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null
  // \r? handles both LF and CRLF line endings (Windows host/agent normalization).
  const fence = /```termul-plan\r?\n([\s\S]*?)\r?\n```/g
  let lastJson: string | null = null
  for (let match = fence.exec(text); match !== null; match = fence.exec(text)) {
    lastJson = match[1]
  }
  return lastJson
}

/**
 * Scan assistant messages in reverse for a `termul-plan` fence (last fence
 * wins). Returns the parsed plan, or `null` when no fence is present or the
 * JSON is malformed. Scans ALL assistant messages — if the last message has
 * no fence (e.g. the turn was interrupted before `_onPromptComplete` ran),
 * earlier messages' fences are the plan-of-record.
 */
export function scanPlanFenceFromMessages(messages: ChatMessage[]): PlanEntry[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'agent') continue
    const blocks = messages[i].blocks
    // Last fence wins: scan blocks in reverse so the most recent snapshot
    // surfaces first.
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j]
      if (block.type !== 'text') continue
      // A fence exists in this block — parse it. If the newest fence is
      // malformed, treat it as terminal: return null rather than continuing
      // to older fences (last-fence-wins means a malformed newest fence
      // supersedes any older valid plan).
      if (extractTermulPlanFenceJson(block.text) !== null) {
        const parsed = parseTermulPlanFence(block.text)
        return parsed
      }
    }
    // Continue to earlier assistant messages — the most recent fence across
    // all turns is the plan-of-record.
  }
  return null
}

/**
 * Check whether a text block IS a termul-plan fence (the entire text is the
 * fence, not just contains one). Used by `appendPlanSnapshot` to decide which
 * blocks to replace — only drop blocks that ARE fences, preserving assistant
 * prose that merely quotes or references the fence format.
 */
export function isTermulPlanFenceBlock(text: string | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  // Full-string match (anchored): the entire block must be the fence.
  return /^```termul-plan\r?\n([\s\S]*?)\r?\n```$/.test(text)
}

/**
 * Append a `termul-plan` fence `text` block carrying the live plan to the
 * last assistant message's `blocks`. The snapshot is a full deterministic
 * replace of any prior snapshot block on the same message (one fence per
 * assistant message, last write wins). Returns the messages map unchanged
 * when there is no live plan or no assistant message to attach to.
 */
export function appendPlanSnapshot(
  messages: Record<SessionId, ChatMessage[]>,
  sessionId: SessionId,
  plan: PlanEntry[] | undefined
): Record<SessionId, ChatMessage[]> {
  if (!plan || plan.length === 0) return messages
  const list = messages[sessionId]
  if (!list || list.length === 0) return messages
  let lastAgentIdx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    // spec-agent-switch-live-merged-transcript: a `switch-splice:` record is
    // projected pre-switch history — stamping the NEW session's plan fence
    // onto it would mutate the copied transcript, not the turn's own tail.
    if (list[i].role === 'agent' && !list[i].id.startsWith(SWITCH_SPLICE_ID_PREFIX)) {
      lastAgentIdx = i
      break
    }
  }
  if (lastAgentIdx < 0) return messages
  const target = list[lastAgentIdx]
  // Replace any prior termul-plan fence block on the same message so the
  // snapshot is a full deterministic replace (one fence per assistant message).
  // Only drop blocks that ARE fences (full-string match), preserving assistant
  // prose that merely contains or quotes the fence format.
  const filteredBlocks = target.blocks.filter(
    (b) => b.type !== 'text' || !isTermulPlanFenceBlock(b.text)
  )
  // CommonMark requires the opening ``` of a fenced code block to be at the
  // start of a line. `blocksToText` joins text blocks with '', so a preceding
  // prose block that does not end in '\n' would glue the fence opener onto the
  // prose (e.g. "working on it```termul-plan") and Streamdown would not recognize
  // the fence — the snapshot would render as plain text instead of a PlanPanel.
  // `blocksToText` skips non-text blocks, so the block that ends up immediately
  // before the fence in the joined text is the LAST non-empty text block —
  // search backward for it (not just the last array element, which may be a
  // non-text block like an image) and ensure it ends in a newline boundary.
  let lastTextBlockIdx = -1
  for (let i = filteredBlocks.length - 1; i >= 0; i -= 1) {
    const block = filteredBlocks[i]
    if (block.type === 'text' && (block.text ?? '').length > 0) {
      lastTextBlockIdx = i
      break
    }
  }
  const blocksWithBoundary = filteredBlocks.map((b, i) => {
    if (i !== lastTextBlockIdx || b.type !== 'text') return b
    const text = b.text ?? ''
    if (text.length === 0 || text.endsWith('\n')) return b
    return { ...b, text: `${text}\n` }
  })
  const fenceBlock: ContentBlock = {
    type: 'text',
    text: `\`\`\`termul-plan\n${JSON.stringify(plan)}\n\`\`\``
  }
  const updatedMessage: ChatMessage = {
    ...target,
    blocks: [...blocksWithBoundary, fenceBlock]
  }
  const newList = [...list]
  newList[lastAgentIdx] = updatedMessage
  return { ...messages, [sessionId]: newList }
}

/** Remove all pending permissions belonging to an agent. */
export function dropPermissionsForAgent(
  pending: Record<string, PendingPermission>,
  agentId: AgentId
): Record<string, PendingPermission> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].agentId === agentId) delete next[id]
  }
  return next
}

/** Remove all pending questions belonging to a session (issue #411). */
export function dropQuestionsForSession(
  pending: Record<string, PendingQuestion>,
  sessionId: SessionId
): Record<string, PendingQuestion> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].sessionId === sessionId) delete next[id]
  }
  return next
}

/** Remove all pending questions belonging to an agent (issue #411). */
export function dropQuestionsForAgent(
  pending: Record<string, PendingQuestion>,
  agentId: AgentId
): Record<string, PendingQuestion> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].agentId === agentId) delete next[id]
  }
  return next
}

export function nextQueueId(): string {
  return newId('queue')
}

export function dropRecordKey<T>(
  record: Record<SessionId, T>,
  sessionId: SessionId
): Record<SessionId, T> {
  if (!(sessionId in record)) return record
  const next = { ...record }
  delete next[sessionId]
  return next
}

/**
 * Drop warm-pool slots whose target session matches `match`, preserving the
 * map's identity when nothing is removed. A stale slot routes launcher option
 * calls (`set_mode` / `set_config_option` / `set_model`) and `startChat`
 * promotion at a session whose agent may already be gone — the backend
 * answers `unknown agent`. Every session/agent teardown must drop its slots:
 * renderer-initiated kills emit no `session_closed`/`agent_disconnected`
 * events (intentional kills are silent), so `killAgent`/`closeSession` clean
 * up here just like the event handlers do.
 */
export function dropPreparedSlots(
  prepared: Record<string, SessionId>,
  match: (sessionId: SessionId) => boolean
): Record<string, SessionId> {
  let next: Record<string, SessionId> | null = null
  for (const [key, sessionId] of Object.entries(prepared)) {
    if (!match(sessionId)) continue
    if (!next) next = { ...prepared }
    delete next[key]
  }
  return next ?? prepared
}

/**
 * Maximum number of messages retained per session in the live React window.
 * Generous so normal single-session use never trims — only the multi-hour /
 * multi-session pathology that climbs toward GB engages. Older messages fall
 * out of the in-memory window but remain on disk, restorable via
 * `loadOlderMessages` on scroll-up.
 */
export const MAX_LIVE_WINDOW_MESSAGES = 300

/**
 * Maximum number of tool calls retained per session in the live React window
 * (CAP-2). Mirrors the host's persisted budget (`PERSISTED_TOOL_CALLS_LIMIT` =
 * 500 in acp-history-persistence) so the live list plateaus at the same size
 * the durable history keeps — older finished cards drop, in-flight calls are
 * always retained, and late updates for trimmed ids are already no-ops
 * (`_onToolCallUpdate`'s `idx === -1` path).
 */
export const MAX_LIVE_TOOL_CALLS = 500

/**
 * Cap a session's live tool calls at {@link MAX_LIVE_TOOL_CALLS}: drop the
 * OLDEST FINISHED calls (status `completed`/`failed`), always retaining
 * in-flight ones (`pending`/`in_progress`/absent status — never drop what we
 * can't prove finished). The result preserves relative order of survivors.
 */
export function trimLiveToolCalls(calls: ToolCall[]): ToolCall[] {
  if (calls.length <= MAX_LIVE_TOOL_CALLS) return calls
  let dropCount = calls.length - MAX_LIVE_TOOL_CALLS
  const survivors: ToolCall[] = []
  // Walk oldest→newest; finished calls (completed/failed — provably done) drop
  // from the head until the cap holds. Absent status is treated as in-flight:
  // never drop what we can't prove finished.
  for (let i = 0; i < calls.length; i++) {
    const status = calls[i].status
    if (dropCount > 0 && (status === 'completed' || status === 'failed')) {
      dropCount--
      continue
    }
    survivors.push(calls[i])
  }
  // Degenerate guard: more in-flight calls than the cap — keep the newest
  // (never trim in-flight, and the array must not grow without bound).
  return survivors.length > MAX_LIVE_TOOL_CALLS ? survivors.slice(-MAX_LIVE_TOOL_CALLS) : survivors
}

/** True when live (or mid-replay) session updates may mutate transcript maps. */
export function acceptsSessionTranscriptEvents(
  session: AcpSession | undefined
): session is AcpSession {
  return Boolean(session && (session.status !== 'closed' || session.replaying))
}

/** Move a failed optimistic send into the queue when the backend is still busy. */
export function recoverPromptToQueue(
  set: TurnEndSetter,
  sessionId: SessionId,
  userMessage: ChatMessage,
  blocks: ContentBlock[],
  displayBlocks: ContentBlock[] | undefined,
  previousOpenTurnId: string | null,
  attemptedTurnId: string,
  queuedOrigin?: QueuedPrompt
): void {
  set((s) => {
    const patch = buildRecoverPromptToQueuePatch(s, {
      sessionId,
      userMessage,
      blocks,
      displayBlocks,
      previousOpenTurnId,
      attemptedTurnId,
      createQueueId: nextQueueId,
      queuedOrigin
    })
    return {
      messages: patch.messages as AcpState['messages'],
      promptQueues: patch.promptQueues,
      sessions: patch.sessions as AcpState['sessions']
    }
  })
}

/**
 * Merge a host session-index response with the locally-known projection so a
 * stale async load cannot remove a just-created row or revert a
 * freshly-titled session to `Untitled Chat`. Preserves local entries that are
 * newer than the host response (match by id, keep the one with the newer
 * `lastActivityAt`) or absent from it but belonging to a live session (created
 * locally and not yet flushed to the durable index). The initial empty-load
 * case (no local entries) applies the host response verbatim.
 */
export function mergeSessionIndexEntries(
  local: SessionIndexEntry[],
  host: SessionIndexEntry[],
  liveSessionIds: Set<SessionId>
): SessionIndexEntry[] {
  if (local.length === 0) return host
  const hostById = new Map(host.map((e) => [e.id, e] as const))
  const merged: SessionIndexEntry[] = [...host]
  const mergedIds = new Set(host.map((e) => e.id))
  for (const entry of local) {
    const hostEntry = hostById.get(entry.id)
    if (hostEntry) {
      // Host has this entry: keep the newer projection. On ties, prefer
      // local (the source of the freshest title) so a same-millisecond
      // host flush cannot revert a just-set title to `Untitled Chat`.
      if ((entry.lastActivityAt ?? 0) >= (hostEntry.lastActivityAt ?? 0)) {
        const idx = merged.findIndex((e) => e.id === entry.id)
        if (idx >= 0) {
          // Field-level merge: carry forward host-only durable fields
          // (messageCount, lastSeq) so the local projection does not
          // regress durable-advanced metadata while preserving the
          // local title/activity.
          merged[idx] = {
            ...hostEntry,
            ...entry,
            messageCount: Math.max(entry.messageCount ?? 0, hostEntry.messageCount ?? 0),
            lastSeq: Math.max(entry.lastSeq ?? 0, hostEntry.lastSeq ?? 0)
          }
        }
      }
    } else if (liveSessionIds.has(entry.id) && !mergedIds.has(entry.id)) {
      // Host omits it but it is a live session (created/restored locally and
      // not yet flushed to the durable index): keep the local projection.
      merged.push(entry)
    }
  }
  // Display-side title normalization (spec fix-agent-switch-merge-ui):
  // pre-`displayContent` sessions persisted the `# Conversation handoff`
  // wire framing AS the title. The durable record is host-owned — normalize
  // the projection, not the store.
  return merged.map((e) =>
    e.title.includes('# Conversation handoff') ? { ...e, title: normalizeIndexTitle(e.title) } : e
  )
}

/**
 * Strip the `# Conversation handoff` wire framing from a persisted index
 * title. Sessions switched before the `displayContent` fix (or titled from
 * a summary-only first prompt) keep the framed summary as their title —
 * the sidebar then shows "# Conversation handoff" instead of a topic.
 * Recovery: prefer the persisted marker's own draft tail when the title IS
 * the wire block (summary-only switch), else keep the first line minus the
 * header. Pure display-side normalization — the durable title is
 * host-owned and left untouched.
 */
export function normalizeIndexTitle(title: string): string {
  const trimmed = title.trim()
  // Exact leaked form: the durable title is the first LINE of the wire
  // block (host derive takes line 1), i.e. literally `# Conversation
  // handoff` — no topic recoverable from the title alone.
  if (trimmed === '# Conversation handoff') return 'Untitled Chat'
  const stripped = stripHandoffPreamble(title)
  // stripHandoffPreamble returns null for a summary-only record (no `---`
  // separator): the title IS the handoff — fall back to the last `User:`/
  // `Agent:` line inside it, which is the closest thing to a topic.
  if (stripped === null) {
    const lastTurnLine = title
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('User: ') || l.startsWith('Agent: '))
      .at(-1)
    const topic = lastTurnLine?.replace(/^(User|Agent):\s*/, '')
    return topic && topic.length > 0 ? topic : 'Untitled Chat'
  }
  // A draft-bearing wire block: the draft IS the user's message — title it.
  if (stripped !== title && stripped.length > 0) {
    const firstLine = stripped.split(/\r?\n/, 1)[0].trim()
    if (firstLine.length > 0) return firstLine
  }
  return title
}

/**
 * CAP-2: history is host-owned. Refresh the desktop sidebar from the host
 * index after session lifecycle events — browser-origin sessions never flow
 * through `createSession`, and the host's `chat_history_changed` broadcast
 * reaches WS clients only, not the desktop renderer. Skipped on the WS
 * transport (its sidebar refetches from the negotiated push).
 */
export function refreshHostOwnedIndex(get: () => AcpState): void {
  if (getAcpTransport().historyMode?.() !== undefined) return
  void get().loadSessionIndex()
}

/** Composite dedup key for {@link inFlightAuth}: agent + normalized method id. */
export function inFlightAuthKey(agentId: AgentId, methodId: string): string {
  return `${agentId}\0${methodId}`
}

/**
 * A live agent can be reused (instead of spawning a second process) when it is
 * connected. Provider CLIs own authentication, so an auth-blocked process is not
 * treated as reusable for new chat preparation.
 */
export function isReusableStatus(status: AgentStatus | undefined): boolean {
  return status === 'connected'
}

/**
 * Identity of a live agent *process*: a configured agent + its working
 * directory. Distinct from {@link prepareChatKey} (which also folds in MCP
 * selection) because the agent process is MCP-agnostic — only the session is.
 * Keying the reuse map by this gives each project/cwd its own process, so the
 * same agent runs in parallel across projects and a crash in one is contained.
 * The key format (`configId\0cwd`, plus the detached third segment) is owned
 * by `./acp-reuse-keys` — see {@link agentReuseKey}, re-exported above.
 */

/**
 * Normalize a filesystem path for keying/comparison: forward slashes and no
 * trailing slash. Case-folds only Windows-style paths (drive-letter or
 * backslash-bearing), which are case-insensitive; POSIX paths keep their case
 * since `/Work` and `/work` are distinct directories there.
 */
export function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim()
  if (trimmed === '') return ''
  const isWindowsPath = /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\')
  let slashed = trimmed.replace(/\\/g, '/').replace(/\/+$/, '')
  // Preserve roots: stripping trailing slashes must not collapse a root like
  // "/" (POSIX) or "C:/" (Windows drive) into "" / "C:", which would alias the
  // no-cwd key or lose the drive root.
  if (slashed === '') slashed = '/'
  else if (/^[a-zA-Z]:$/.test(slashed)) slashed = `${slashed}/`
  return isWindowsPath ? slashed.toLowerCase() : slashed
}

/**
 * Stable key for a discovery result/in-flight slot, scoped per (agent, cwd) so
 * switching cwd never clobbers another cwd's results and a slow in-flight
 * discovery can't overwrite a newer cwd's results. cwd is normalized.
 */
export function discoveryKey(agentId: AgentId, cwd: string): string {
  return `${agentId}\0${normalizeCwd(cwd)}`
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
  // Normalize cwd here so every producer (`prepareChat` trims; armed-switch
  // lookups pass the raw session cwd) agrees on the same key.
  return `${configId}\0${cwd.trim()}\0${mcpKey}`
}

/**
 * Identity fingerprint for options-cache invalidation: cmd / args / env /
 * allowTerminal (path and install identity are reflected in `command` + `args`).
 * The canonical comparator lives in `acp-config-identity.ts` (shared with
 * catalog-migration reconciliation); env keys are sorted so insertion-order
 * differences do not spuriously invalidate.
 */
export function agentConfigIdentityChanged(
  prev: StoredAgentConfig | undefined,
  next: StoredAgentConfig
): boolean {
  if (!prev) return false
  return agentConfigIdentityKey(prev) !== agentConfigIdentityKey(next)
}

export function configIdForAgentId(state: AcpState, agentId: AgentId): string | null {
  for (const [key, id] of Object.entries(state.configToLiveAgent)) {
    if (id === agentId) return configIdFromReuseKey(key)
  }
  return null
}

export function writeAgentOptionsCache(
  set: AcpSet,
  configId: string,
  patch: {
    models?: SessionModelState | null
    modes?: SessionModeState | null
    configOptions?: SessionConfigOption[]
  }
): void {
  set((s) => {
    const prev = s.agentOptionsCache[configId]
    const next: AgentOptionsCacheEntry = {
      models: patch.models !== undefined ? patch.models : (prev?.models ?? null),
      modes: patch.modes !== undefined ? patch.modes : (prev?.modes ?? null),
      configOptions:
        patch.configOptions !== undefined ? patch.configOptions : (prev?.configOptions ?? []),
      updatedAt: Date.now()
    }
    // Avoid writing empty shells that would look like a real cache hit.
    const hasContent =
      next.models != null ||
      next.modes != null ||
      (next.configOptions != null && next.configOptions.length > 0)
    if (!hasContent) {
      if (!prev) return s
      const agentOptionsCache = { ...s.agentOptionsCache }
      delete agentOptionsCache[configId]
      return { agentOptionsCache }
    }
    return {
      agentOptionsCache: { ...s.agentOptionsCache, [configId]: next }
    }
  })
}

export function invalidateAgentOptionsCache(set: AcpSet, configId: string): void {
  set((s) => {
    if (!(configId in s.agentOptionsCache)) return s
    const agentOptionsCache = { ...s.agentOptionsCache }
    delete agentOptionsCache[configId]
    return { agentOptionsCache }
  })
}

/** Option values a session was created with (`session/new` result or the
 * `session_created` payload) — the baseline the stale-echo guards compare
 * `config_option_update`/`mode_update` snapshots against. */
export function creationOptionDefaultsFrom(input: {
  modes?: SessionModeState | null
  models?: SessionModelState | null
  configOptions?: SessionConfigOption[] | null
}): NonNullable<AcpSession['creationOptionDefaults']> {
  const configValues: Record<string, string> = {}
  for (const option of input.configOptions ?? []) {
    configValues[option.id] = option.currentValue
  }
  return {
    modeId: input.modes?.currentModeId,
    modelId: input.models?.currentModelId,
    configValues
  }
}

/**
 * Merge an agent-provided config-option snapshot into the session state
 * without letting a backend-side desync clobber the user's model selection
 * (QA: a `set_config_option` response / `config_option_update` push reporting
 * a different model `currentValue` flipped the picker to another model while
 * the agent kept answering with the user's pick). For `model`-category
 * options, the session's current value wins as long as the snapshot still
 * lists it. The option the user JUST set always applies (their explicit act),
 * and a value the snapshot dropped from the list legitimately yields to the
 * agent (e.g. the picked model was retired).
 *
 * Creation-default echo guard (spec-acp-composer-option-fidelity): a stale
 * snapshot (`session_created` re-fanning the `session/new` payload, or an
 * option snapshot that predates a pending-options flush) can re-assert the
 * creation-time value for ANY option. When the incoming `currentValue` equals
 * the recorded creation default while the session has moved to another
 * still-advertised value, the session's value is preserved and `onEchoPreserved`
 * fires so the caller can warn-log once per option. A non-default incoming
 * value is a genuine agent-side change and flows through — this is NOT a
 * blanket pin of local state.
 */
export function mergeAgentConfigOptions(
  previous: SessionConfigOption[] | undefined,
  next: SessionConfigOption[],
  opts?: {
    /** The option the user just explicitly set — its snapshot value always wins. */
    optedConfigId?: string
    /** Values the agent advertised at session creation, keyed by option id. */
    creationValues?: Record<string, string>
    /** Fires when a moved-off current value was preserved over a creation-default echo. */
    onEchoPreserved?: (optionId: string) => void
  }
): SessionConfigOption[] {
  if (!previous || previous.length === 0) return next
  return next.map((option) => {
    if (option.id === opts?.optedConfigId) return option
    const prior = previous.find((p) => p.id === option.id)
    if (!prior || prior.currentValue === option.currentValue) return option
    if (!option.options.some((o) => o.value === prior.currentValue)) return option
    const isDefaultEcho =
      opts?.creationValues != null &&
      opts.creationValues[option.id] !== undefined &&
      option.currentValue === opts.creationValues[option.id]
    if (option.category === 'model' || isDefaultEcho) {
      if (isDefaultEcho) opts?.onEchoPreserved?.(option.id)
      return { ...option, currentValue: prior.currentValue }
    }
    return option
  })
}

export function cacheOptionsFromSession(set: AcpSet, get: AcpGet, sessionId: SessionId): void {
  const state = get()
  const session = state.sessions[sessionId]
  if (!session) return
  const configId = configIdForAgentId(state, session.agentId)
  if (!configId) return
  writeAgentOptionsCache(set, configId, {
    models: session.models ?? null,
    modes: session.modes ?? null,
    configOptions: session.configOptions ?? []
  })
}

/** Best-effort tear-down for a session created by a cancelled/stale prepare. */
export function reapOrphanPreparedSession(get: AcpGet, set: AcpSet, sessionId: SessionId): void {
  // createSession may have set activeSessionId as a side effect; that must not
  // block reaping a session that never became a published preparedSessions entry.
  set((s) => (s.activeSessionId === sessionId ? { activeSessionId: null } : s))
  void get()
    .closeSession(sessionId)
    .catch(() => {
      /* best-effort: backend may already be gone */
    })
    .finally(() => {
      void get().deleteHistorySession(sessionId)
    })
}

/** True when cache has model-relevant content (native models or model config option). */
export function hasModelRelevantOptionsCache(
  entry: AgentOptionsCacheEntry | null | undefined
): boolean {
  if (!entry) return false
  if (entry.models && entry.models.availableModels.length > 0) return true
  return entry.configOptions.some(
    (option) => option.category === 'model' && option.options.length > 0
  )
}

export function createCommitMessageCollector(agentId: AgentId): CommitMessageCollector {
  let complete!: (reason: StopReason) => void
  let reject!: (error: Error) => void
  const completed = new Promise<StopReason>((resolve, rejectPromise) => {
    complete = resolve
    reject = rejectPromise
  })
  return { agentId, chunks: [], length: 0, completed, complete, reject }
}

export function parseGeneratedCommitMessage(raw: string): GeneratedCommitMessage {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const jsonText = fenced?.[1]?.trim() ?? trimmed
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    throw new Error('The ACP agent returned an invalid commit message response')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The ACP agent returned an invalid commit message response')
  }
  const record = value as Record<string, unknown>
  if (typeof record.summary !== 'string' || record.summary.trim().length === 0) {
    throw new Error('The ACP agent returned a blank commit summary')
  }
  const summary = record.summary.trim()
  if (/\r|\n/.test(summary) || summary.length > 72) {
    throw new Error(
      'The ACP agent returned a commit summary that is longer than 72 characters or contains a newline'
    )
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw new Error('The ACP agent returned an invalid commit description')
  }
  return {
    summary,
    description: typeof record.description === 'string' ? record.description.trim() : ''
  }
}

export function dropEphemeralSessionState(
  state: AcpState,
  sessionId: SessionId
): Partial<AcpState> {
  const sessions = { ...state.sessions }
  const messages = { ...state.messages }
  const toolCalls = { ...state.toolCalls }
  const agentSwitches = { ...state.agentSwitches }
  const plans = { ...state.plans }
  const commands = { ...state.commands }
  const sessionUsage = { ...state.sessionUsage }
  delete sessions[sessionId]
  delete messages[sessionId]
  delete toolCalls[sessionId]
  delete agentSwitches[sessionId]
  delete plans[sessionId]
  delete commands[sessionId]
  delete sessionUsage[sessionId]
  return {
    sessions,
    messages,
    toolCalls,
    agentSwitches,
    plans,
    commands,
    sessionUsage,
    pendingPermissions: dropPermissionsForSession(state.pendingPermissions, sessionId),
    pendingQuestions: dropQuestionsForSession(state.pendingQuestions, sessionId),
    promptQueues: dropPromptQueueForSession(state.promptQueues, sessionId),
    suppressQueueFlush: dropRecordKey(state.suppressQueueFlush, sessionId),
    activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId
  }
}

/**
 * Story 3 (spec-in-chat-agent-switch): the busy gate for a switch. True when
 * the old session has an active turn, an open turn, queued prompts, or a
 * pending permission/question — the "never kill a live turn" rule (CAP-4/CAP-6).
 * A pending browser-auth dialog also counts (the agent is waiting on the user).
 */
export function switchBlockedReason(
  state: Pick<
    AcpState,
    | 'sessions'
    | 'promptQueues'
    | 'pendingPermissions'
    | 'pendingQuestions'
    | 'pendingBrowserOpen'
    | 'launchingSessionIds'
  >,
  sessionId: SessionId
): string | null {
  const session = state.sessions[sessionId]
  if (!session) return 'session not found'
  if (sessionTurnBusy(session)) {
    return 'the agent is still working on a turn — cancel it or wait for it to finish before switching'
  }
  // A mid-replay handoff would build from a PARTIAL transcript (the replay
  // is still reconstructing it); a launching chat is mid-creation.
  if (session.replaying) {
    return 'the chat history is still being restored — wait for it to finish before switching'
  }
  if (state.launchingSessionIds[sessionId]) {
    return 'the chat is still starting up — wait for it to open before switching'
  }
  if ((state.promptQueues[sessionId] ?? []).length > 0) {
    return 'queued prompts are waiting — let them send before switching'
  }
  const permission = Object.values(state.pendingPermissions).find((p) => p.sessionId === sessionId)
  if (permission) return 'a permission request is waiting for your answer before switching'
  const question = Object.values(state.pendingQuestions).find((q) => q.sessionId === sessionId)
  if (question) return 'the agent asked a question — answer it before switching'
  if (session.agentId && state.pendingBrowserOpen[session.agentId]) {
    return 'the agent is waiting for you to sign in before switching'
  }
  return null
}

/** Stamp the busy-gate (or any switch) rejection on the old session's banner. */
export function setSwitchRejection(
  set: TurnEndSetter,
  sessionId: SessionId,
  message: string
): void {
  set((s) => {
    const session = s.sessions[sessionId]
    if (!session) return {}
    return {
      sessions: {
        ...s.sessions,
        [sessionId]: {
          ...session,
          switching: null,
          lastError: `Could not switch agent: ${message}`
        }
      }
    }
  })
}

/**
 * Story 3: detach the old agent's canonical reuse key unconditionally (kill
 * only when idle) — the `teardownConfigForUpdate` / `detachAgentForNewCredentials`
 * precedent. The idle reaper owns the actual kill of a live agent; a detached
 * key keeps the process resolvable for its open sessions while guaranteeing no
 * NEW prepare reuses the process.
 */
export function detachOldAgentForSwitch(
  set: TurnEndSetter,
  configId: string,
  cwd: string,
  agentId: AgentId
): void {
  const reuseKey = agentReuseKey(configId, cwd)
  set((s) => {
    if (s.configToLiveAgent[reuseKey] !== agentId) return {}
    const configToLiveAgent = { ...s.configToLiveAgent }
    delete configToLiveAgent[reuseKey]
    // Keep the superseded process resolvable for its (still-open) old session
    // — the detached key is never consumed by a new prepare.
    configToLiveAgent[detachedReuseKey(reuseKey, agentId)] = agentId
    return { configToLiveAgent }
  })
}

/**
 * Story 3: kill a just-spawned-for-this-switch agent when its session/new
 * failed (rollback). The process was spawned FOR the switch, so unlike the
 * old agent (detach-only) it may be killed outright — but only when it owns
 * no other live session (a warm agent may serve other chats).
 */
export async function killSpawnedAgentIfUnused(
  get: () => AcpState,
  agentId: AgentId
): Promise<void> {
  const hasOtherSession = Object.values(get().sessions).some((s) => s.agentId === agentId)
  if (hasOtherSession) return
  try {
    await get().killAgent(agentId)
  } catch (err) {
    void logFrontendError({
      level: 'warn',
      source: 'acp.switchAgent.rollback',
      message: `Could not stop the just-spawned agent ${agentId} after a failed session/new: ${err instanceof Error ? err.message : String(err)}`
    })
  }
}

/**
 * Story 3: append `toConfigId` to the session's ordered-agent cache
 * (first = original, last = current), deduping consecutive entries. Applied
 * to the session-index projection through `persistSession` — the durable
 * markers stay the authoritative source (this is the cheap CAP-7/CAP-8 cache).
 * No existing index entry → NO append: a synthetic entry minted here (no
 * agentConfigId, messageCount 0) would be wrong — the next `persistSession`
 * derives the entry correctly and carries the list from the markers then.
 */
export function appendOrderedAgents(
  state: Pick<AcpState, 'sessionIndex'>,
  sessionId: SessionId,
  originalConfigId: string | undefined,
  toConfigId: string
): SessionIndexEntry[] {
  const existing = state.sessionIndex.find((e) => e.id === sessionId)
  if (!existing) return state.sessionIndex
  const base = existing.agents ?? (originalConfigId ? [originalConfigId] : [])
  const list = base.length === 0 && existing.agentConfigId ? [existing.agentConfigId] : base
  if (list.length > 0 && list[list.length - 1] === toConfigId) return state.sessionIndex
  const entry: SessionIndexEntry = {
    ...existing,
    lastActivityAt: Date.now(),
    agents: [...list, toConfigId]
  }
  return [entry, ...state.sessionIndex.filter((e) => e.id !== sessionId)]
}

/**
 * Story 3 (CAP-7): resolve the redirect target for reopening a possibly
 * switched chat. The LAST durable switch marker is authoritative: when it
 * carries a resolvable `(toConfigId, newSessionId)`, the reopen must continue
 * the conversation on the NEW agent + NEW session. A missing/empty
 * `newSessionId` (corrupt or pre-feature record) degrades to null → the
 * caller takes the original reopen path unchanged.
 */
export function resolveSwitchRedirect(
  switches: AgentSwitchRecord[]
): { toConfigId: string; newSessionId: SessionId } | null {
  const last = switches.length > 0 ? switches[switches.length - 1] : null
  if (!last) return null
  if (typeof last.newSessionId !== 'string' || last.newSessionId.length === 0) return null
  if (typeof last.toConfigId !== 'string' || last.toConfigId.length === 0) return null
  return { toConfigId: last.toConfigId, newSessionId: last.newSessionId }
}

/**
 * Id namespace `spliceSwitchTranscript` re-stamps every spliced record into
 * (`switch-splice:<source session>:<original id>`). Shared with the live
 * paths that must distinguish spliced pre-switch history (projected records,
 * never the new session's own live tail) from real session records — e.g.
 * `runPromptTurn`'s trailing-user reuse and `_onMessageChunk`'s tail merge.
 */
export const SWITCH_SPLICE_ID_PREFIX = 'switch-splice:'

/**
 * Story 3 (CAP-7): splice a session's installed pre-switch transcript into the
 * redirect target's transcript under ONE consistent namespace.
 * Seq/id collision fix: the old session's durable records carry per-session
 * seqs (each session's host log restarts at 1) and per-session ids
 * (`user:seq-1`, `snapshot:agent:2`). Naively concatenating them with the
 * target's own records interleaves the merged timeline wrongly (buildTimeline
 * sorts seq-first) and collides ids (duplicate React keys, wrong
 * `_onUserPrompt` dedup matches). Every spliced record is re-stamped:
 * `seq = (floor - 1000) + original seq` (a NEGATIVE band below the target's
 * whole seq space — spliced records sort before every target record) and
 * `id = switch-splice:<source session>:<original id>` — so the merged
 * timeline orders old-before-new with ids unique across hops.
 *
 * Idempotency: a repeat open re-runs the redirect; a spliced record whose
 * re-stamped id is already present in the target list is skipped (the
 * [old, old, new] double-splice bug). Non-text tool calls and switch markers
 * splice with the same offset rule.
 */
export function spliceSwitchTranscript(
  sourceSessionId: string,
  installed: { messages: ChatMessage[]; toolCalls: ToolCall[]; switches: AgentSwitchRecord[] },
  targetMessages: ChatMessage[],
  targetToolCalls: ToolCall[],
  targetSwitches: AgentSwitchRecord[]
): { messages: ChatMessage[]; toolCalls: ToolCall[]; switches: AgentSwitchRecord[] } {
  // Re-stamp old records BELOW the target's LOWEST seq: buildTimeline sorts
  // seq-first, so the spliced pre-switch turns land BEFORE every target
  // record, and each fold's band grows downward (no cross-hop collisions —
  // two hops' original seqs may coincide). Live events stay above: the live
  // counter is rebased above every installed payload, so the negative band
  // belongs to the splice alone.
  const floor = Math.min(
    0,
    ...targetMessages.map((m) => (typeof m.seq === 'number' ? m.seq : 0)),
    ...targetToolCalls.map((t) => (typeof t.seq === 'number' ? t.seq : 0)),
    ...targetSwitches.map((sw) => (typeof sw.seq === 'number' ? sw.seq : 0))
  )
  const offset = floor - 1000
  // Namespaced ids: two hops may share original ids (each session's log
  // restarts its seq space), so the source session id keeps the React keys
  // unique.
  const spliceId = (id: string): string => `${SWITCH_SPLICE_ID_PREFIX}${sourceSessionId}:${id}`
  const seen = new Set(targetMessages.map((m) => m.id))
  // Prepend (front = oldest): the raw array order mirrors the timeline
  // order so downstream last-index scans (trailing-user lookups, live-window
  // trims) see the pre-switch turns where they render. Relative order is
  // preserved (map over the installed list, not per-item unshift).
  const splicedMessages = installed.messages
    .filter((message) => {
      const nextId = spliceId(message.id)
      if (seen.has(nextId)) return false
      seen.add(nextId)
      return true
    })
    .map((message) => ({
      ...message,
      id: spliceId(message.id),
      seq: (typeof message.seq === 'number' ? message.seq : 0) + offset
    }))
  const messages: ChatMessage[] = [...splicedMessages, ...targetMessages]
  const toolCallIds = new Set(targetToolCalls.map((t) => t.toolCallId))
  const splicedToolCalls = installed.toolCalls
    .filter((call) => {
      const nextId = spliceId(call.toolCallId)
      if (toolCallIds.has(nextId)) return false
      toolCallIds.add(nextId)
      return true
    })
    .map((call) => ({
      ...call,
      toolCallId: spliceId(call.toolCallId),
      seq: (typeof call.seq === 'number' ? call.seq : 0) + offset
    }))
  const toolCalls: ToolCall[] = [...splicedToolCalls, ...targetToolCalls]
  const switchIds = new Set(targetSwitches.map((sw) => sw.id))
  const splicedSwitches = installed.switches
    .filter((record) => {
      const nextId = spliceId(record.id)
      if (switchIds.has(nextId)) return false
      switchIds.add(nextId)
      return true
    })
    .map((record) => ({
      ...record,
      id: spliceId(record.id),
      seq: record.seq + offset
    }))
  const switches: AgentSwitchRecord[] = [...splicedSwitches, ...targetSwitches]
  return { messages, toolCalls, switches }
}

export function liveInlineKeyAuthPolicy(
  get: () => AcpState,
  agentId: AgentId
): AgentAuthPolicy | null {
  for (const [reuseKey, liveId] of Object.entries(get().configToLiveAgent)) {
    if (liveId !== agentId) continue
    const auth = agentPolicyForConfigId(configIdFromReuseKey(reuseKey)).auth
    if (auth.mode === 'acp' && auth.inlineKeyFormMethodId != null) return auth
  }
  return null
}

/**
 * True when a failed session call is worth an authenticate+retry
 * (spec-acp-persistent-auth-reuse): the explicit auth-required signal —
 * `agent_auth_required` code / `ACP_AUTH_REQUIRED` prefix, surfaced by both
 * transports — OR a natural-language failure that classifies as category
 * 'auth' (some agents only reply "not logged in" / "401" and never emit the
 * wire code; the preemptive-auth flow used to cover them, so dropping the
 * wording fallback would regress them). 'multi-auth', 'transport',
 * 'timeout', 'spawn', and 'unknown' classifications never trigger a retry.
 */
export function isAuthRetriableSessionError(raw: unknown): boolean {
  return isAgentAuthRequiredError(raw) || classifySetupError(raw).category === 'auth'
}

/**
 * Reopen/resume surfaces render `session/load`/`session/resume` failures as
 * text (`withSessionResumeError` + a Retry button) with no method picker —
 * translate the multi-method signal into actionable guidance pointing at the
 * picker that DOES exist (a new chat's launcher). The plain `Error` still
 * classifies as 'auth' (the "sign-in" wording matches AUTH_PATTERN).
 */
export function authPickerUnavailableError(): Error {
  return new Error(
    'This agent requires sign-in. Start a new chat for this agent to choose a sign-in method, then retry.'
  )
}

export function captureReopenControlBaseline(
  sessions: Record<SessionId, AcpSession>,
  sessionId: SessionId
): ReopenControlBaseline | null {
  const session = sessions[sessionId]
  if (!session) return null
  return {
    modes: session.modes,
    models: session.models,
    configOptions: session.configOptions
  }
}

/**
 * Resolve the configured agent's display name + template + custom icon behind
 * a live session, via the configToLiveAgent mapping. Falls back to the session
 * index `agentConfigId` when the live map is cold (history reopen / empty
 * state) so `AgentGlyph` still resolves the registry icon instead of Bot.
 */
export function selectAgentIdentity(state: AcpState, agentId: AgentId | null): AgentIdentity {
  if (!agentId) return { name: null, templateId: null, icon: null }
  const reuseKey = Object.keys(state.configToLiveAgent).find(
    (k) => state.configToLiveAgent[k] === agentId
  )
  let configId = reuseKey ? configIdFromReuseKey(reuseKey) : undefined
  if (!configId) {
    const indexed = state.sessionIndex.find((e) => e.agentId === agentId && e.agentConfigId)
    configId = indexed?.agentConfigId
  }
  const config = configId ? state.agentConfigs.find((c) => c.id === configId) : undefined
  return {
    name: config?.name ?? null,
    templateId: config?.templateId ?? null,
    icon: config?.icon ?? null
  }
}

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
  const sessionReady = Object.keys(state.preparedSessions).some(
    (key) => configIdFromReuseKey(key) === configId
  )
  const warmingSession = Object.keys(state.preparingChatKeys).some(
    (key) => configIdFromReuseKey(key) === configId
  )
  return { connected, warming, sessionReady, warmingSession }
}

/**
 * Issue #838: derive the open turn (a `user_prompt` with no matching
 * `prompt_complete`) from an installed transcript. The server's session
 * metadata may carry `turnActive` (authoritative, set when the host knows a
 * turn is running); the transcript derivation covers older hosts and any
 * window where metadata lagged. Returns the open turn id (`turn:<turnId>`)
 * or null. A turn id missing from the bubble (older records) yields
 * `turn:<lastUserSeq>` so the stop button + spinner have a stable handle.
 */
export function deriveOpenTurn(
  messages: ChatMessage[],
  metadataTurnActive?: boolean
): string | null {
  // The open-turn signals, most-reliable first: the host's `turnActive`
  // metadata flag, else the transcript tail (a trailing user bubble with no
  // assistant reply after it — a streaming turn may have zero agent output
  // yet, so absence of a reply is not proof of completion, but its presence
  // IS proof the turn finished).
  if (metadataTurnActive) {
    // Metadata says a turn runs; recover the id from the last user bubble.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return messages[i].id.startsWith('turn:')
          ? messages[i].id
          : messages[i].seq != null
            ? `turn:seq-${messages[i].seq}`
            : `turn:open-${i}`
      }
    }
    return null
  }
  // Trailing-derivation: the transcript ends with a user message that has no
  // turn:<id> completion behind it. We cannot see prompt_complete records
  // from ChatMessage[] alone, but an assistant reply AFTER the last user
  // message implies the turn finished (the reply streams during the turn and
  // finalizes at completion). A trailing user bubble with NO assistant
  // message after it means the turn is still open.
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) return null
  const agentAfter = messages.slice(lastUserIdx + 1).some((m) => m.role === 'agent')
  if (agentAfter) return null
  const last = messages[lastUserIdx]
  return last.id.startsWith('turn:')
    ? last.id
    : last.seq != null
      ? `turn:seq-${last.seq}`
      : `turn:open-${lastUserIdx}`
}
