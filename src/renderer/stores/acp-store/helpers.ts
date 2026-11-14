/**
 * Pure helper functions for the ACP store — extracted from `../acp-store.ts`
 * (spec-04 PR A). Everything here is stateless: no module-level singletons
 * and no store closure — `set`/`get` arrive as parameters.
 */

import type { BugReportSubmitRequest } from '@shared/types/bug-report.types'
import { UNASSIGNED_PROJECT_ID } from '@shared/types/web-projects.types'
import { runningBackgroundCommands } from '@/components/chat/background-commands'
import {
  flattenConfigOptionValues,
  MODEL_CATEGORY,
  sessionModelSnapshot,
  wireConfigValue
} from '@/components/chat/chat-input-bar-config'
import { stripHandoffPreamble } from '@/components/chat/handoff-summary'
import { runningBackgroundSubagents } from '@/components/chat/subagent-strip'
import { describeToolCall, toolCallChangedPaths } from '@/components/chat/tool-call-summary'
import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  type AgentId,
  type AvailableCommand,
  acpApi,
  type ContentBlock,
  type McpServer,
  type PlanEntry,
  parseAcpErrorDetail,
  type SessionConfigOption,
  type SessionConfigOptionEntry,
  type SessionId,
  type SessionModelState,
  type SessionModeState,
  type StopReason,
  type ToolCall
} from '@/lib/acp-api'
import {
  type AgentSwitchRecord,
  isUntitledTitle,
  maxPayloadSeq,
  type PersistedTurnError,
  type SessionIndexEntry
} from '@/lib/acp-history-persistence'
import { getAcpTransport } from '@/lib/acp-transport'
import { agentConfigIdentityKey } from '@/lib/agents/acp-config-identity'
import { type AgentAuthPolicy, agentPolicyForConfigId } from '@/lib/agents/acp-registry'
import {
  classifySetupError,
  claudeAccountSignedOutMessage,
  codexAccountSignedOutMessage,
  describeProviderFailure,
  isAgentAuthRequiredError,
  isClaudeAccountSignedOutError,
  isCodexAccountSignedOutError
} from '@/lib/agents/acp-spawn-errors'
import { serializeSelectionContexts } from '@/lib/composer/selection-context'
import { restoreConversationLabels, stripConversationEnvelopes } from '@/lib/conversation-envelope'
import { splitReadOnlyGuard } from '@/lib/github-handoff/read-only-guard'
import { logFrontendError } from '@/lib/log-api'
import { isAfter, type LogPoint } from '@/lib/log-point'
import {
  isFolderTokenPath,
  parseFileSegments,
  replaceFileTokensInline,
  SKILL_PAD_END,
  SKILL_PAD_START
} from '@/lib/skill-tokens'
import { wireBlocksToDisplay, wireTextToDisplay } from '@/lib/skills-wire-reverse'
import { randomUUID } from '@/lib/uuid'
import {
  configIdFromReuseKey,
  detachedReuseKey,
  isDetachedReuseKey,
  parseReuseKey
} from '../acp-reuse-keys'
import {
  buildRecoverPromptToQueuePatch,
  dropPromptQueueForSession,
  type QueuedPrompt,
  sessionTurnBusy
} from '../prompt-queue-orchestration'
import {
  latestModelPick,
  type OptionValues,
  readComposerOptions,
  reopenRestores,
  savedAgentWideValues,
  savedModelValues,
  warnOnce
} from './composer-options'
import { ephemeralSessionIds, stoppingAgentIds } from './ephemeral-ids'
import { isIndexedRealSession } from './live-turn'
import { modelCatalogFromOptions, persistModelCatalog } from './model-catalog'
import { forgetRegistryMcpServers, mcpServersFingerprint } from './registry-mcp-fingerprints'

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
 * Agent and thought rows before the first user bubble stay visible. An empty
 * handoff-boundary row stays hidden. An empty-content user bubble and the
 * agent/thought rows that belong only to that empty bubble stay hidden until
 * the next visible user bubble.
 */
export function partitionTranscriptTurns(messages: ChatMessage[]): {
  visible: ChatMessage[]
  hidden: Array<[number, number]>
} {
  const visible: ChatMessage[] = []
  const hidden: Array<[number, number]> = []
  let hiddenTurn = false
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
 * Visible transcript after hidden empty-user turns are removed. Leading
 * agent and thought rows stay.
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
export function normalizeUserMessageBlocks(input: ChatMessage): ChatMessage {
  if (input.role !== 'user') return input
  const guarded = splitReadOnlyGuard(input.blocks)
  const message: ChatMessage = guarded.guard
    ? { ...input, blocks: guarded.blocks, readOnlyGuard: guarded.guard }
    : input
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
 * prompt. File tokens reduce to their `(display)` marker — the wire form;
 * the resulting `(display)` vs literal ambiguity is resolved by
 * `twinFileEvidence`. `wireTextToDisplay` also runs on the persisted side
 * so a record that skipped display normalization still canonicalizes (it
 * is a passthrough for any text lacking the exact framing).
 */
export function canonicalTwinText(message: ChatMessage): string {
  const text = transcriptText(message)
  const display = message.role === 'user' ? wireTextToDisplay(text) : text
  // Selection contexts compare in prompt form: the restore cannot recover the
  // spacing after a leading command pill, and typed text in the exact prompt
  // shape restores as chips.
  return replaceFileTokensInline(
    serializeSelectionContexts(
      restoreConversationLabels(stripConversationEnvelopes(display)).replace(SKILL_PAD_BLOCK_RE, '')
    )
  ).trim()
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
    // Folder tokens send as plain text with no block, so they leave no
    // persisted-side evidence to match.
    if (seg.kind === 'file' && !isFolderTokenPath(seg.absPath)) {
      evidence.push(`file:${seg.display}`)
    }
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
  _messages: ChatMessage[],
  role: MessageRole
): boolean {
  if (session.openTurnId) return true
  // A session/load replay re-streams the whole conversation (user and agent
  // turns alike) outside any prompt turn; every replayed chunk may open a
  // bubble.
  if (session.replaying) return true
  // ACP allows agent and thought updates outside an active prompt turn
  // (session/new greeting, late chunks after the prompt response).
  if (role === 'agent' || role === 'thought') return true
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
    case 'error':
      // AD-5 turn terminators: the host closes an errored / timed-out /
      // crashed turn with exactly one `prompt_complete` so no client keeps a
      // turn open. These are failures, not completions.
      return 'The turn ended with an error.'
    case 'timeout':
      return 'The turn timed out.'
    case 'crashed':
      return 'The agent stopped unexpectedly.'
    default:
      return `Response stopped: ${reason}`
  }
}

/**
 * Stop reasons the host writes for a turn that FAILED (as opposed to ending
 * normally or by user cancel). The preceding `agent_error` / `agent_crashed`
 * event carries the specific message; the terminator must not overwrite it.
 */
export function isFailedTurnStopReason(reason: StopReason): boolean {
  return reason === 'error' || reason === 'timeout' || reason === 'crashed'
}

type LastErrorFields = Pick<AcpSession, 'lastError' | 'lastErrorCode' | 'lastErrorData'>

/**
 * `lastError` after a turn terminator: a failed-turn terminator keeps the
 * specific error already recorded by the preceding `agent_error` and only
 * falls back to the generic note; every other reason keeps the existing
 * `note ?? current` rule. The code and data stay only with the error they
 * came with.
 */
export function lastErrorAfterStop(current: LastErrorFields, reason: StopReason): LastErrorFields {
  const note = noteForStopReason(reason)
  const keep = isFailedTurnStopReason(reason) ? current.lastError !== null : note === null
  if (!keep) return plainLastError(note)
  return {
    lastError: current.lastError,
    lastErrorCode: current.lastErrorCode,
    lastErrorData: current.lastErrorData
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

/**
 * Mark a reopened history session live after a successful load/resume IPC
 * call. `keepLastError` keeps the failed-turn error the reopen restored from
 * the payload instead of clearing it.
 */
export function withSessionActive(
  sessions: Record<SessionId, AcpSession>,
  sessionId: SessionId,
  keepLastError = false
): Record<SessionId, AcpSession> {
  const session = sessions[sessionId]
  if (!session) return sessions
  return {
    ...sessions,
    [sessionId]: {
      ...session,
      status: 'active',
      ...(keepLastError ? {} : plainLastError(null))
    }
  }
}

/**
 * The banner fields for the last turn's failure recorded in a session
 * payload. Mirrors what the live `agent_error` handler writes: the provider
 * wording when the host classified one, else the message, falling back to the
 * stop-reason note when the host kept no detail. The host persists no error
 * `data`, so a restored banner has none.
 */
export function lastErrorFromPersistedTurn(turn: PersistedTurnError | undefined): LastErrorFields {
  if (!turn) return plainLastError(null)
  const message = turn.message || noteForStopReason(turn.stopReason)
  if (message === null) return plainLastError(null)
  const detail = parseAcpErrorDetail(turn)
  return {
    lastError: detail.providerCode
      ? describeProviderFailure(detail.providerCode, message)
      : message,
    lastErrorCode: detail.code ?? null,
    lastErrorData: undefined
  }
}

export function plainLastError(message: string | null): LastErrorFields {
  return { lastError: message, lastErrorCode: null, lastErrorData: undefined }
}

/** Prefix of the `lastError` a failed history load/resume writes. */
export const RESUME_FAILED_PREFIX = 'Resume failed: '

/**
 * Whether `lastError` records a failed resume (as opposed to a turn note such
 * as "Interrupted by server restart."). A failed resume blocks the seamless
 * resume of a stopped chat; a leftover turn note does not.
 */
export function isResumeFailureError(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && lastError.startsWith(RESUME_FAILED_PREFIX)
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
    [sessionId]: {
      ...session,
      replaying: null,
      ...plainLastError(
        `${RESUME_FAILED_PREFIX}${
          isClaudeAccountSignedOutError(err)
            ? claudeAccountSignedOutMessage(err)
            : isCodexAccountSignedOutError(err)
              ? codexAccountSignedOutMessage(err)
              : String(err)
        }`
      )
    }
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
export function dropElicitationsForSession<T extends { sessionId: SessionId }>(
  pending: Record<string, T>,
  sessionId: SessionId
): Record<string, T> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].sessionId === sessionId) delete next[id]
  }
  return next
}

export function dropElicitationsForAgent<T extends { agentId: AgentId }>(
  pending: Record<string, T>,
  agentId: AgentId
): Record<string, T> {
  const next = { ...pending }
  for (const id of Object.keys(next)) {
    if (next[id].agentId === agentId) delete next[id]
  }
  return next
}

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

/**
 * Install `list` as the session's slash commands unless the store holds a
 * list from a newer record of the same log incarnation. `point` locates the
 * `commands_update` record that set the list; a list without one (an older
 * host) installs and drops the held point.
 */
export function withCommands(
  state: Pick<AcpState, 'commands' | 'commandsSeq'>,
  sessionId: SessionId,
  list: AvailableCommand[],
  point: LogPoint | undefined
): Pick<AcpState, 'commands' | 'commandsSeq'> {
  const held = state.commandsSeq[sessionId]
  if (point !== undefined && held !== undefined && !isAfter(point, held) && point.seq < held.seq) {
    return { commands: state.commands, commandsSeq: state.commandsSeq }
  }
  return {
    commands: { ...state.commands, [sessionId]: list },
    commandsSeq:
      point === undefined
        ? dropRecordKey(state.commandsSeq, sessionId)
        : { ...state.commandsSeq, [sessionId]: point }
  }
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
 * a renderer-initiated kill clears its own state here without waiting for the
 * host's `session_closed`/`agent_disconnected`, so `killAgent`/`closeSession`
 * clean up just like the event handlers do and the result never depends on
 * event order.
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

export function isLivePreparedSession(
  state: Pick<AcpState, 'sessions' | 'agentStatus'>,
  sessionId: SessionId
): boolean {
  const session = state.sessions[sessionId]
  return session?.status === 'active' && state.agentStatus[session.agentId] === 'connected'
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
 * 500 in acp-history-persistence) so the live calls plateau at the same size
 * the durable history keeps — older finished cards drop, in-flight calls are
 * always retained, and late updates for trimmed ids are already no-ops
 * (`_onToolCallUpdate`'s `idx === -1` path). File-change summaries do not
 * count toward the cap, so the list grows past it by one small summary per
 * dropped file-changing call.
 */
export const MAX_LIVE_TOOL_CALLS = 500

/**
 * The restored-style summary of a file-changing call: its paths (both ends
 * of a move, every file of a multi-file edit), kind, status and line counts,
 * which the changed files list reads, without the diff text. Null for a call
 * that changes no file.
 */
function fileChangeSummary(call: ToolCall): ToolCall | null {
  if (call.kind !== 'edit' && call.kind !== 'delete' && call.kind !== 'move') return null
  const paths = toolCallChangedPaths(call)
  if (paths.length === 0) return null
  const summary: ToolCall = {
    toolCallId: call.toolCallId,
    kind: call.kind,
    locations: paths.map((path) => ({ path })),
    restoredSummary: true
  }
  if (call.status !== undefined) summary.status = call.status
  if (call.seq !== undefined) summary.seq = call.seq
  if (call.timestamp !== undefined) summary.timestamp = call.timestamp
  const diffStat = describeToolCall(call).diffStat
  if (diffStat) summary.diffStat = diffStat
  return summary
}

/**
 * Cap a session's live tool calls at {@link MAX_LIVE_TOOL_CALLS}: drop the
 * OLDEST FINISHED calls (status `completed`/`failed`), always retaining
 * in-flight ones (`pending`/`in_progress`/absent status — never drop what we
 * can't prove finished). Subagent dispatches are never dropped either: each
 * is a row of the transcript, while the calls a subagent makes are its detail.
 * A dropped file-changing call leaves its {@link fileChangeSummary}, and
 * summaries never count toward the cap, so the changed files list keeps every
 * file the session touched. The result preserves relative order of survivors.
 */
export function trimLiveToolCalls(calls: ToolCall[]): ToolCall[] {
  if (calls.length <= MAX_LIVE_TOOL_CALLS) return calls
  const liveCount = calls.reduce((count, call) => (call.restoredSummary ? count : count + 1), 0)
  if (liveCount <= MAX_LIVE_TOOL_CALLS) return calls
  let dropCount = liveCount - MAX_LIVE_TOOL_CALLS
  const survivors: ToolCall[] = []
  let liveSurvivors = 0
  // Walk oldest→newest; finished calls (completed/failed — provably done) drop
  // from the head until the cap holds. Absent status is treated as in-flight:
  // never drop what we can't prove finished.
  for (const call of calls) {
    if (call.restoredSummary) {
      survivors.push(call)
      continue
    }
    if (
      dropCount > 0 &&
      call.subagent === undefined &&
      (call.status === 'completed' || call.status === 'failed')
    ) {
      dropCount--
      const summary = fileChangeSummary(call)
      if (summary) survivors.push(summary)
      continue
    }
    survivors.push(call)
    liveSurvivors++
  }
  // Degenerate guard: more in-flight calls than the cap — keep the newest
  // (never trim in-flight, and the array must not grow without bound).
  let excess = liveSurvivors - MAX_LIVE_TOOL_CALLS
  if (excess <= 0) return survivors
  return survivors.filter((call) => call.restoredSummary || excess-- <= 0)
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
 * A chat's creation time is first-write-wins: keep `recorded` once it holds a
 * real timestamp, so reopening or resuming a chat (which stamps a fresh
 * `Date.now()` on the live session) never moves it.
 */
export function keepCreatedAt(recorded: number | undefined, candidate: number): number {
  return typeof recorded === 'number' && Number.isFinite(recorded) && recorded > 0
    ? recorded
    : candidate
}

/** Keep a known live turn when the other side never sent the flag. */
function mergeTurnActive(
  local: boolean | undefined,
  host: boolean | undefined,
  localWins: boolean
): boolean | undefined {
  if (local === true || host === true) return true
  if (localWins) return local ?? host
  return host ?? local
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
            lastSeq: Math.max(entry.lastSeq ?? 0, hostEntry.lastSeq ?? 0),
            // A projection made after the agent left the live map has no
            // config; the host's durable attribution must survive the spread.
            agentConfigId: entry.agentConfigId ?? hostEntry.agentConfigId,
            // A local projection made before the host stamp landed must not
            // erase the host's durable chain edge — and once the host has
            // one it wins, so a stale local edge cannot hide a host
            // correction. `undefined` still falls through to the local stamp.
            continuedFrom: hostEntry.continuedFrom ?? entry.continuedFrom,
            turnActive: mergeTurnActive(entry.turnActive, hostEntry.turnActive, true),
            // The host stamps `created_at` once at registration; a local
            // projection re-stamped by a reopen must not override it.
            createdAt: keepCreatedAt(hostEntry.createdAt, entry.createdAt),
            // A newer local row must not downgrade a real host-derived title to
            // the `Untitled Chat` placeholder (issue #1798): a watching device
            // re-stamps the stale placeholder at turn end with a fresh
            // `lastActivityAt`, which would otherwise beat the host's derived
            // title on every refetch. Keep the host title when ours is a
            // placeholder and theirs is real; a real local rename still wins.
            title:
              isUntitledTitle(entry.title) && !isUntitledTitle(hostEntry.title)
                ? hostEntry.title
                : entry.title
          }
        }
      } else {
        // A newer host row must not erase what the client already projected
        // and the host cannot know yet: the host titles a chat only once its
        // first prompt is durable (a promoted warm session registers
        // untitled), and its index omits `turnActive`.
        const keepTitle = isUntitledTitle(hostEntry.title)
        const keepTurn = entry.turnActive === true && hostEntry.turnActive === undefined
        // A locally-stamped/healed chain edge (switch just ran, or the
        // payload-install backfill covered a pre-feature chain) survives a
        // newer host row that predates the host's own stamp landing.
        const keepEdge = entry.continuedFrom !== undefined && hostEntry.continuedFrom === undefined
        const idx = merged.findIndex((e) => e.id === entry.id)
        if ((keepTitle || keepTurn || keepEdge) && idx >= 0) {
          merged[idx] = {
            ...hostEntry,
            ...(keepTitle ? { title: entry.title } : {}),
            ...(keepTurn ? { turnActive: true } : {}),
            ...(keepEdge ? { continuedFrom: entry.continuedFrom } : {})
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
 * The title a live session should show when it may still hold the
 * `Untitled Chat` placeholder (issue #1808). A watching device can install a
 * chat started on another device before the host has titled it (the payload
 * then carries the placeholder); the host's later title only reaches the index
 * row, while the tab, phone header and drawer read `session.title`. A
 * placeholder gives way to a real index title; any other title (including a
 * user rename) and a `null` title are kept as they are.
 */
export function preferIndexTitle(
  title: string | null,
  entries: readonly SessionIndexEntry[],
  sessionId: SessionId
): string | null {
  if (!isUntitledTitle(title)) return title
  const indexTitle = entries.find((e) => e.id === sessionId)?.title
  return indexTitle && !isUntitledTitle(indexTitle) ? indexTitle : title
}

/**
 * Give every live session that still shows a placeholder title the real title
 * its index row now carries (issue #1808). Returns `sessions` itself when
 * nothing changes, so subscribers do not re-render.
 */
export function adoptIndexTitles(
  sessions: Record<SessionId, AcpSession>,
  entries: readonly SessionIndexEntry[]
): Record<SessionId, AcpSession> {
  let next: Record<SessionId, AcpSession> | null = null
  for (const [id, session] of Object.entries(sessions)) {
    const title = preferIndexTitle(session.title, entries, id)
    if (title === session.title) continue
    next ??= { ...sessions }
    next[id] = { ...session, title }
  }
  return next ?? sessions
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
 * through `createSession`, and the host's `chat_history` watch
 * reaches WS clients only, not the desktop renderer. Skipped on the WS
 * transport (its sidebar refetches from the negotiated push).
 */
export function refreshHostOwnedIndex(get: () => AcpState): void {
  // The relay-negotiated modes (`server`/`live_only`) refetch from the pushed
  // index; the desktop's `tauri_store` still reads the host index on demand.
  const mode = getAcpTransport().historyMode?.()
  if (mode === 'server' || mode === 'live_only') return
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
  const mcpKey = mcpServersFingerprint(mcpServers ?? [])
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

/**
 * The project a chat session names: the live record's `projectId`, else its
 * session-index entry (closed history chats are evicted from `sessions` but
 * stay indexed). `''` (an unattributed `session_created` stub) and the host's
 * unassigned sentinel name no project: `undefined`. A plain field read, not a
 * filter — nothing is hidden or dropped on the basis of it.
 */
export function sessionProjectId(
  state: Pick<AcpState, 'sessions' | 'sessionIndex'>,
  sessionId: string
): string | undefined {
  const projectId =
    state.sessions[sessionId]?.projectId ||
    state.sessionIndex.find((entry) => entry.id === sessionId)?.projectId
  return projectId && projectId !== UNASSIGNED_PROJECT_ID ? projectId : undefined
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
  const written: { entry: AgentOptionsCacheEntry | null } = { entry: null }
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
    written.entry = next
    return {
      agentOptionsCache: { ...s.agentOptionsCache, [configId]: next }
    }
  })
  // Keep the model list after a restart so the composer selector can show
  // this agent's models before it runs again.
  const catalog = written.entry ? modelCatalogFromOptions(written.entry) : null
  if (catalog) persistModelCatalog(configId, catalog)
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
    configValues[option.id] =
      typeof option.currentValue === 'boolean' ? String(option.currentValue) : option.currentValue
  }
  return {
    modeId: input.modes?.currentModeId,
    modelId: input.models?.currentModelId,
    configValues
  }
}

function appendUnseen<T>(
  current: T[],
  incoming: T[],
  key: (item: T) => string,
  enrich?: (item: T, other: T) => T
): T[] {
  const incomingByKey = new Map(incoming.map((item) => [key(item), item]))
  const enriched = enrich
    ? current.map((item) => {
        const other = incomingByKey.get(key(item))
        return other ? enrich(item, other) : item
      })
    : current
  const seen = new Set(current.map(key))
  const added = incoming.filter((item) => !seen.has(key(item)))
  const changed = enriched.some((item, index) => item !== current[index])
  return changed || added.length > 0 ? [...enriched, ...added] : current
}

const configEntryKey = (entry: SessionConfigOptionEntry): string =>
  Array.isArray(entry.options) ? `group:${entry.group ?? entry.name}` : `value:${entry.value}`

function appendUnseenGroupValues(
  entry: SessionConfigOptionEntry,
  other: SessionConfigOptionEntry
): SessionConfigOptionEntry {
  if (!entry.options || !other.options) return entry
  const options = appendUnseen(entry.options, other.options, (value) => value.value)
  return options === entry.options ? entry : { ...entry, options }
}

function appendUnseenConfigValues(
  option: SessionConfigOption,
  other: SessionConfigOption
): SessionConfigOption {
  if (!option.options || !other.options) return option
  const options = appendUnseen(
    option.options,
    other.options,
    configEntryKey,
    appendUnseenGroupValues
  )
  return options === option.options ? option : { ...option, options }
}

export function addAdvertisedOptionsKeepingCurrent(
  current: Pick<AcpSession, 'modes' | 'models' | 'configOptions'>,
  payload: {
    modes?: SessionModeState | null
    models?: SessionModelState | null
    configOptions?: SessionConfigOption[] | null
  }
): Pick<AcpSession, 'modes' | 'models' | 'configOptions'> {
  let modes = current.modes ?? payload.modes ?? null
  if (current.modes && payload.modes) {
    const availableModes = appendUnseen(
      current.modes.availableModes,
      payload.modes.availableModes,
      (mode) => mode.id
    )
    if (availableModes !== current.modes.availableModes) {
      modes = { ...current.modes, availableModes }
    }
  }
  let models = current.models ?? payload.models ?? null
  if (current.models && payload.models) {
    const availableModels = appendUnseen(
      current.models.availableModels,
      payload.models.availableModels,
      (model) => model.modelId
    )
    if (availableModels !== current.models.availableModels) {
      models = { ...current.models, availableModels }
    }
  }
  return {
    modes,
    models,
    configOptions: appendUnseen(
      current.configOptions,
      payload.configOptions ?? [],
      (option) => option.id,
      appendUnseenConfigValues
    )
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
    const priorComparable =
      typeof prior.currentValue === 'boolean' ? String(prior.currentValue) : prior.currentValue
    const incomingComparable =
      typeof option.currentValue === 'boolean' ? String(option.currentValue) : option.currentValue
    const booleanOption =
      typeof prior.currentValue === 'boolean' || typeof option.currentValue === 'boolean'
    if (
      !booleanOption &&
      !flattenConfigOptionValues(option).some((entry) => entry.value === priorComparable)
    ) {
      return option
    }
    const creation = opts?.creationValues?.[option.id]
    const isDefaultEcho = creation !== undefined && incomingComparable === creation
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
  // #1486/#1479: advertised options landing on a live session (fresh
  // session/new after a branch-checkout re-prepare, or the first
  // config_option_update after an idle reopen) is exactly the moment a
  // silently-reset pick can be healed from the persisted composer options.
  // Idempotent: values equal to the session's current ones are no-ops, and
  // picks no longer advertised are dropped.
  void reapplyPersistedComposerOptions(get, sessionId, configId)
}

/** Sessions with a reapply currently in flight (dedupes event storms). */
const reapplyInFlight = new Set<SessionId>()
/** Sessions whose reapply was triggered while one ran: one more pass follows it. */
const reapplyRerun = new Set<SessionId>()

/** The model a session runs now, as the composer shows it. */
export function currentSessionModel(session: AcpSession | undefined): string | null {
  return sessionModelSnapshot(session)?.modelId ?? null
}

/** Every option's value now: a later mismatch means something else moved it. */
export function optionValueBaseline(
  session: AcpSession | undefined
): ReadonlyMap<string, string | boolean> {
  return new Map((session?.configOptions ?? []).map((o) => [o.id, o.currentValue]))
}

/** How long a native model switch may take to re-advertise the options. */
const READVERTISE_WAIT_MS = 1000
const READVERTISE_POLL_MS = 25

/** The non-model options as data: `setModel` itself only moves the model's value. */
function nonModelOptionsKey(options: readonly SessionConfigOption[] | undefined): string {
  return JSON.stringify((options ?? []).filter((o) => o.category !== MODEL_CATEGORY))
}

/**
 * After a native `setModel`, wait (bounded) for the agent to re-advertise the
 * options: the new model's effort choices arrive as a separate event, and
 * values applied before it would be checked against the old model's.
 * `before` is the option list from before the `setModel` call, so an update
 * that landed ahead of the reply ends the wait at once.
 */
export async function waitForReadvertisedOptions(
  get: AcpGet,
  sessionId: SessionId,
  before: readonly SessionConfigOption[]
): Promise<void> {
  const beforeKey = nonModelOptionsKey(before)
  const deadline = Date.now() + READVERTISE_WAIT_MS
  while (Date.now() < deadline) {
    const session = get().sessions[sessionId]
    if (session?.status !== 'active') return
    if (nonModelOptionsKey(session.configOptions) !== beforeKey) return
    await new Promise((resolve) => setTimeout(resolve, READVERTISE_POLL_MS))
  }
}

/**
 * Set saved option values on a live session, after its model is in place.
 * Skips the model option, an option or value the session does not advertise
 * (warn log), a value already current, and an option that moved off
 * `baseline`: a change made while the restore ran wins. Stops once the
 * session leaves `modelId`, the model the values belong to.
 */
export async function applyOptionValues(
  get: AcpGet,
  sessionId: SessionId,
  values: OptionValues,
  opts: {
    source: string
    modelId?: string | null
    baseline?: ReadonlyMap<string, string | boolean>
    persist?: boolean
  }
): Promise<void> {
  const { source } = opts
  const setOpts = opts.persist === false ? { persist: false } : undefined
  let baseline = opts.baseline ?? optionValueBaseline(get().sessions[sessionId])
  for (const [optionId, valueId] of Object.entries(values)) {
    const session = get().sessions[sessionId]
    if (session?.status !== 'active') return
    if (opts.modelId && currentSessionModel(session) !== opts.modelId) return
    const option = session.configOptions.find((o) => o.id === optionId)
    if (option?.category === MODEL_CATEGORY) continue
    if (option && baseline.has(optionId) && baseline.get(optionId) !== option.currentValue) continue
    const wire = option ? wireConfigValue(option, valueId) : null
    // Grouped selects nest their values; flatten like mergeAgentConfigOptions.
    const advertised =
      option != null &&
      wire != null &&
      (option.type === 'boolean' || flattenConfigOptionValues(option).some((v) => v.value === wire))
    if (!advertised) {
      warnOnce(
        sessionId,
        `${optionId}\0${valueId}`,
        source,
        `skipped saved value for '${optionId}' on session ${sessionId}: the session does not advertise it`
      )
      continue
    }
    if (option.currentValue === wire) continue
    try {
      await get().setConfigOption(sessionId, optionId, wire, setOpts)
      void logFrontendError({
        level: 'info',
        source,
        message: `restored saved value for '${optionId}' on session ${sessionId}`
      })
    } catch {
      void logFrontendError({
        level: 'warn',
        source,
        message: `the agent rejected the saved value for '${optionId}' on session ${sessionId}; kept its value (details withheld)`
      })
    }
    // The set may re-advertise other options; compare later changes to that.
    baseline = optionValueBaseline(get().sessions[sessionId])
  }
}

/**
 * Heal a live chat from the agent's saved composer record (#1486/#1479):
 * the saved model first (the agent re-advertises effort choices on a model
 * switch), then that model's values and the agent-wide ones. A reopened chat
 * (`reopenRestores`) keeps its own model and values and gets only the
 * agent-wide ones; so does a chat whose saved model is no longer offered.
 * Skipped while a model pick runs on the chat. A restore, so it never writes
 * the record.
 */
export async function reapplyPersistedComposerOptions(
  get: AcpGet,
  sessionId: SessionId,
  configId: string
): Promise<void> {
  if (latestModelPick.has(sessionId)) return
  if (reapplyInFlight.has(sessionId)) {
    // The pass in flight read the record before this trigger: run once more after it.
    reapplyRerun.add(sessionId)
    return
  }
  const session = get().sessions[sessionId]
  // Only heal live chats: a session still initializing or sitting in an
  // error/launch-fail state has no stable advertised surface to validate
  // picks against, and firing set-config calls there can race the launch
  // failure path.
  if (
    !session ||
    session.status !== 'active' ||
    (session.configOptions.length === 0 && (session.models?.availableModels.length ?? 0) === 0)
  )
    return
  reapplyInFlight.add(sessionId)
  // Snapshot the live values when the read starts. The read is async; if the
  // user (or any event) changes a value while it is in flight, the change is
  // newer than the persisted record and must win — the saved value for that
  // option is then skipped instead of undoing it (review: race on #1488).
  let baseline = optionValueBaseline(session)
  const modelAtReadStart = currentSessionModel(session)
  try {
    const saved = await readComposerOptions(configId)
    if (!saved || latestModelPick.has(sessionId)) return
    const live = get().sessions[sessionId]
    const current = currentSessionModel(live)
    if (current !== modelAtReadStart) return // model changed during read
    const agentWide = savedAgentWideValues(saved, live?.configOptions ?? [])
    const applyValues = (values: OptionValues, modelId: string | null) =>
      applyOptionValues(get, sessionId, values, {
        source: 'acp.reapplyComposerOptions',
        modelId,
        baseline,
        persist: false
      })
    // A reopened chat keeps its own model and values.
    if (reopenRestores.has(sessionId)) return await applyValues(agentWide, current)
    const target = saved.modelId
    if (target && target !== current) {
      // Advertised via a model-category config option (flattened for groups)
      // or through the native session.models state when no option exists.
      const modelOption = live?.configOptions.find((o) => o.category === MODEL_CATEGORY)
      const advertised = modelOption
        ? flattenConfigOptionValues(modelOption).some((v) => v.value === target)
        : (live?.models?.availableModels.some((m) => m.modelId === target) ?? false)
      if (!advertised) {
        warnOnce(
          sessionId,
          `model\0${target}`,
          'acp.reapplyComposerOptions',
          `saved model is not advertised on session ${sessionId}; kept the session's model and its values`
        )
        return await applyValues(agentWide, current)
      }
      try {
        // Same route as the launcher apply: the native model state when the
        // session has one, else the model option.
        if (live?.models || !modelOption) {
          const before = live?.configOptions ?? []
          await get().setModel(sessionId, target, { persist: false })
          if (Object.keys(savedModelValues(saved, target)).length > 0) {
            await waitForReadvertisedOptions(get, sessionId, before)
          }
        } else {
          await get().setConfigOption(sessionId, modelOption.id, target, { persist: false })
        }
        void logFrontendError({
          level: 'info',
          source: 'acp.reapplyComposerOptions',
          message: `re-applied persisted model on session ${sessionId} (#1486/#1479)`
        })
      } catch {
        void logFrontendError({
          level: 'warn',
          source: 'acp.reapplyComposerOptions',
          message: 'failed to re-apply persisted model (details withheld)'
        })
        return
      }
      // The switch re-advertised the options; compare later changes to that.
      baseline = optionValueBaseline(get().sessions[sessionId])
    }
    const model = currentSessionModel(get().sessions[sessionId])
    await applyValues({ ...agentWide, ...savedModelValues(saved, model) }, model)
  } finally {
    reapplyInFlight.delete(sessionId)
    if (reapplyRerun.delete(sessionId)) {
      void reapplyPersistedComposerOptions(get, sessionId, configId)
    }
  }
}

/** Best-effort tear-down for a session created by a cancelled/stale prepare. */
export function reapOrphanPreparedSession(
  get: AcpGet,
  set: AcpSet,
  sessionId: SessionId
): Promise<void> {
  // Index membership is the placeholder check. A host id may start with
  // `launch-`; that prefix is only a renderer tab convention.
  if (isIndexedRealSession(get().sessionIndex, sessionId)) {
    ephemeralSessionIds.delete(sessionId)
    void logFrontendError({
      level: 'warn',
      source: 'acp.reapOrphanPreparedSession',
      message: `Skipped teardown of indexed session ${sessionId}; orphan reap must not close or delete a persisted chat`
    })
    return Promise.resolve()
  }
  // createSession may have set activeSessionId as a side effect; that must not
  // block reaping a session that never became a published preparedSessions entry.
  set((s) => (s.activeSessionId === sessionId ? { activeSessionId: null } : s))
  const agentId = get().sessions[sessionId]?.agentId
  const disposed =
    agentId && !stoppingAgentIds.has(agentId)
      ? acpApi.disposeEphemeralSession(agentId, sessionId).catch((error) => {
          void logFrontendError({
            level: 'warn',
            source: 'acp.reapOrphanPreparedSession',
            message: `Failed to dispose warm session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
          })
        })
      : Promise.resolve()
  return disposed
    .then(() => get().deleteHistorySession(sessionId))
    .finally(() => {
      ephemeralSessionIds.delete(sessionId)
      forgetRegistryMcpServers(sessionId)
      set((s) => (s.sessions[sessionId] ? dropEphemeralSessionState(s, sessionId) : s))
    })
}

/** True when cache has model-relevant content (native models or model config option). */
export function hasModelRelevantOptionsCache(
  entry: AgentOptionsCacheEntry | null | undefined
): boolean {
  if (!entry) return false
  if (entry.models && entry.models.availableModels.length > 0) return true
  return entry.configOptions.some(
    (option) => option.category === 'model' && (option.options?.length ?? 0) > 0
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

/**
 * Bug report AI draft (spec-bug-report-dialog): parse the one-shot agent's
 * `{"title":"...","body":"..."}` reply — same output convention as
 * `parseGeneratedCommitMessage` (optional fenced block, then strict JSON).
 */
export function parseGeneratedBugReportDraft(raw: string): BugReportSubmitRequest {
  const trimmed = raw.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const jsonText = fenced?.[1]?.trim() ?? trimmed
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    throw new Error('The ACP agent returned an invalid bug report draft response')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The ACP agent returned an invalid bug report draft response')
  }
  const record = value as Record<string, unknown>
  if (typeof record.title !== 'string' || record.title.trim().length === 0) {
    throw new Error('The ACP agent returned a blank bug report title')
  }
  const title = record.title.trim()
  if (/\r|\n/.test(title) || title.length > 120) {
    throw new Error(
      'The ACP agent returned a bug report title that is longer than 120 characters or contains a newline'
    )
  }
  if (typeof record.body !== 'string' || record.body.trim().length === 0) {
    throw new Error('The ACP agent returned a blank bug report body')
  }
  return { title, body: record.body.trim() }
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
    commandsSeq: dropRecordKey(state.commandsSeq, sessionId),
    sessionUsage,
    pendingPermissions: dropPermissionsForSession(state.pendingPermissions, sessionId),
    pendingQuestions: dropQuestionsForSession(state.pendingQuestions, sessionId),
    pendingElicitations: dropElicitationsForSession(state.pendingElicitations ?? {}, sessionId),
    promptQueues: dropPromptQueueForSession(state.promptQueues, sessionId),
    suppressQueueFlush: dropRecordKey(state.suppressQueueFlush, sessionId),
    activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId
  }
}

/** Checked last with the commands reason, so a caller can tell that nothing else blocks. */
export const BACKGROUND_SUBAGENTS_BLOCK_REASON =
  'background subagents are still running — switching would stop them'

export const BACKGROUND_COMMANDS_BLOCK_REASON =
  'commands are still running in the background — switching would stop them'

/** Whether only background work (subagents or commands) blocks the switch. */
export function isBackgroundWorkBlock(reason: string | null): boolean {
  return reason === BACKGROUND_SUBAGENTS_BLOCK_REASON || reason === BACKGROUND_COMMANDS_BLOCK_REASON
}

/**
 * Story 3 (spec-in-chat-agent-switch): the busy gate for a switch. True when
 * the old session has an active turn, an open turn, queued prompts, or a
 * pending permission/question — the "never kill a live turn" rule (CAP-4/CAP-6).
 * A pending browser-auth dialog also counts (the agent is waiting on the user),
 * and so do background subagents and commands that outlive the turn: a new
 * agent process would kill them.
 */
export function switchBlockedReason(
  state: Pick<
    AcpState,
    | 'sessions'
    | 'toolCalls'
    | 'messages'
    | 'promptQueues'
    | 'pendingPermissions'
    | 'pendingQuestions'
    | 'pendingElicitations'
    | 'pendingSignIn'
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
  const elicitation = Object.values(state.pendingElicitations ?? {}).find(
    (item) => item.sessionId === sessionId
  )
  if (elicitation) return 'the agent is waiting for your input before switching'
  if (session.agentId && state.pendingSignIn[session.agentId]) {
    return 'the agent is waiting for you to sign in before switching'
  }
  if (
    runningBackgroundSubagents(state.toolCalls[sessionId], state.messages[sessionId]).length > 0
  ) {
    return BACKGROUND_SUBAGENTS_BLOCK_REASON
  }
  if (runningBackgroundCommands(session) > 0) return BACKGROUND_COMMANDS_BLOCK_REASON
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
          ...plainLastError(`Could not switch agent: ${message}`)
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
  const trimmedCwd = cwd.trim()
  set((s) => {
    // Detach every canonical key for this process (legacy and Project-scoped).
    // A later prepare must not reuse any of them.
    const reuseKeys = Object.keys(s.configToLiveAgent).filter((key) => {
      if (isDetachedReuseKey(key) || s.configToLiveAgent[key] !== agentId) return false
      const parsed = parseReuseKey(key)
      return parsed.configId === configId && parsed.cwd === trimmedCwd
    })
    if (reuseKeys.length === 0) return {}
    const configToLiveAgent = { ...s.configToLiveAgent }
    for (const reuseKey of reuseKeys) {
      delete configToLiveAgent[reuseKey]
      // Keep the superseded process resolvable for its (still-open) old session
      // — the detached key is never consumed by a new prepare.
      configToLiveAgent[detachedReuseKey(reuseKey, agentId)] = agentId
    }
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
  const { sessions, openingHistoryIds } = get()
  const hasOtherSession = Object.values(sessions).some(
    (s) => s.agentId === agentId && (s.status !== 'closed' || openingHistoryIds[s.id])
  )
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
 * CAP-8 (spec-in-chat-agent-switch): stamp the durable chain edge
 * `target.continuedFrom = source` on the switch TARGET's index entry. The
 * host writes the same edge (`note_continued_from`) after flushing the
 * marker, but the renderer stamp closes the window where the host's index
 * hasn't landed yet — and self-heals rows whose host stamp raced a stale
 * projection. Idempotent: an already-set edge wins (the FIRST durable
 * switch is authoritative; a corrupted or replayed later value must not
 * repoint the chain). A missing target entry is a no-op — the fold reads
 * only what exists, and the host index is the fallback authority. A source
 * in another project is refused, matching the host's `note_continued_from`.
 */
export function stampSwitchContinuation(
  state: Pick<AcpState, 'sessionIndex'>,
  targetSessionId: SessionId,
  sourceSessionId: SessionId
): SessionIndexEntry[] {
  if (targetSessionId === sourceSessionId) return state.sessionIndex
  const existing = state.sessionIndex.find((e) => e.id === targetSessionId)
  if (!existing || existing.continuedFrom !== undefined) return state.sessionIndex
  // A switch creates its target in the source's project; an edge naming a
  // session elsewhere (a stray marker) would fold another project's chat.
  const source = state.sessionIndex.find((e) => e.id === sourceSessionId)
  if (source !== undefined && source.projectId !== existing.projectId) return state.sessionIndex
  const entry: SessionIndexEntry = { ...existing, continuedFrom: sourceSessionId }
  return [entry, ...state.sessionIndex.filter((e) => e.id !== targetSessionId)]
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
 * The display blocks of the chat's last own user prompt, for a re-send.
 * `switch-splice:` records are projected pre-switch history: re-sending one
 * would send the OLD agent's prompt to the new session.
 */
export function lastOwnUserPromptBlocks(messages: ChatMessage[]): ContentBlock[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].id.startsWith(SWITCH_SPLICE_ID_PREFIX)) {
      return messages[i].blocks
    }
  }
  return null
}

/**
 * Story 3 (CAP-7): splice a session's installed pre-switch transcript into the
 * redirect target's transcript under ONE consistent namespace.
 * Seq/id collision fix: the old session's durable records carry per-session
 * seqs (each session's host log restarts at 1) and per-session ids
 * (`user:seq-1`, `snapshot:agent:2`). Naively concatenating them with the
 * target's own records interleaves the merged timeline wrongly (buildTimeline
 * sorts seq-first) and collides ids (duplicate React keys, wrong
 * `_onUserPrompt` dedup matches). Every spliced record is re-stamped:
 * `seq = original seq + floor - (source's highest seq) - 1` (a NEGATIVE band
 * whose top sits just below the target's whole seq space — spliced records
 * sort before every target record, however long the source ran) and
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
  const offset = floor - maxPayloadSeq(installed) - 1
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

export type SwitchMarkerFacts = Omit<AgentSwitchRecord, 'id' | 'seq'>

export function withSwitchMarker(
  band: { messages: ChatMessage[]; toolCalls: ToolCall[]; switches: AgentSwitchRecord[] },
  marker: SwitchMarkerFacts
): { messages: ChatMessage[]; toolCalls: ToolCall[]; switches: AgentSwitchRecord[] } {
  if (band.switches.some((sw) => sw.newSessionId === marker.newSessionId)) return band
  const bandTop = maxPayloadSeq(band) + 1
  return {
    ...band,
    switches: [...band.switches, { ...marker, id: `switch:fabricated:${bandTop}`, seq: bandTop }]
  }
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
 * Server seq of the prompt that opened the trailing turn: the last user bubble
 * when it is a real prompt (visible content, not a handoff boundary row) with
 * a positive seq. `null` when the window cuts the turn off from its prompt or
 * the trailing turn is a hidden one, whose cards never render.
 */
export function openTurnPromptSeq(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const seq = message.seq
    const prompt = message.handoffBoundary !== true && hasVisibleContent(message)
    return prompt && typeof seq === 'number' && Number.isFinite(seq) && seq > 0 ? seq : null
  }
  return null
}

/**
 * Issue #838: derive the open turn (a `user_prompt` with no matching
 * `prompt_complete`) from an installed transcript. The server's session
 * metadata may carry `turnActive` (authoritative: `true` when a turn runs,
 * `false` when it ended); the transcript derivation covers older hosts and a
 * prompt without a turn id, where the host leaves it absent. Returns the open turn id (`turn:<turnId>`)
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
  // An explicit `false` is the host saying the turn ended (a completion or a
  // host terminator closed it, or the session is not active). A transcript can
  // still end on the user's bubble then — a failed turn has no agent reply — so
  // it must not be read as a turn still running (issue #1192). `undefined` is an
  // older host, or an open prompt without a turn id: derive it from the tail.
  if (metadataTurnActive === false) return null
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
