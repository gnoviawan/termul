/**
 * Pure handoff-summary builder for the in-chat agent switch (CAP-3).
 *
 * ACP v1 `session/new` has no context field, so the prior conversation
 * reaches the new agent's fresh session on the wire: the first `sendPrompt`
 * carries a bounded, structured summary of the old session's transcript plus
 * the pending user message. This module derives the pair the store
 * dispatches at switch time:
 *
 * - `summaryText` — the framed summary section alone (header + preamble +
 *   capped turns). Never includes the pending message; this is what the
 *   switch marker persists.
 * - `wireBlocks` — exactly one text block (summary + pending when both
 *   exist) for the new session's first `sendPrompt`.
 * - `displayBlocks` — the pending user prompt only, or an empty array. The
 *   summary never renders as a user message.
 *
 * Turn partitioning follows the timeline model: messages and tool calls are
 * merged by arrival (`seq`, then `timestamp`), each user message opens a
 * turn, `thought` messages are excluded (internal reasoning, not
 * conversation), and agent text + compact tool one-liners join in arrival
 * order. The summary is bounded — the last `maxTurns` turns (default 12)
 * plus the first user message as the conversation-intent anchor — never a
 * verbatim replay (no `rawInput`/`rawOutput` bodies; tool calls become
 * `describeToolCall` one-liners).
 *
 * Every wire-side fragment — transcript text, tool one-liners, and the
 * pending message — runs through `sanitizeDisplayText` so no private-use
 * sentinel (`\uE000`–`\uE007`) reaches the agent; the display blocks pass
 * the pending text through trimmed, tokens intact (the timeline renders
 * inline chips from raw token text, mirroring the composer's display path).
 * Output is deterministic: no timestamps, ids, or random values participate.
 */
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import { sanitizeDisplayText } from '@/lib/skill-tokens'
import type { ChatMessage } from '@/stores/acp-store'
import { describeToolCall } from './tool-call-summary'

/** Options bounding the derived summary. */
export interface HandoffSummaryOptions {
  /**
   * Maximum number of conversation turns kept in the summary (the last N;
   * default `DEFAULT_MAX_TURNS`). The first user message is always retained
   * as the intent anchor even when its turn falls outside the window.
   */
  maxTurns?: number
}

/** Everything the builder needs from the old session at switch time. */
export interface HandoffSummaryInput {
  /** Old session's transcript messages. */
  messages: ChatMessage[]
  /** Old session's tool calls, merged into turns by arrival order. */
  toolCalls: ToolCall[]
  /** Display name of the agent the conversation is switching away from. */
  agentName: string | null
  /** Composer draft carried over to the new agent's first turn. */
  pendingText: string
  options?: HandoffSummaryOptions
}

/** The summary/wire/display triple the store dispatches at switch time. */
export interface HandoffSummaryResult {
  /**
   * Framed summary section alone (header + preamble + capped turns). Empty
   * string when the transcript yields no summary. Never includes the
   * pending message.
   */
  summaryText: string
  /**
   * Wire blocks for the new session's first `sendPrompt`: one text block
   * with the summary plus the pending user message (summary-only when the
   * pending text is empty, pending-only when there is no summary).
   */
  wireBlocks: ContentBlock[]
  /**
   * Display blocks for the user bubble: the pending user prompt only (raw
   * text, tokens intact), or an empty array when there is none.
   */
  displayBlocks: ContentBlock[]
}

/** Default turn cap: the tail window kept in the summary. */
export const DEFAULT_MAX_TURNS = 12

const GENERIC_AGENT_LABEL = 'the previous agent'
/** Placeholder for a user turn that carried only non-text blocks. */
const ATTACHMENT_ONLY = '[shared an attachment]'
const HANDOFF_HEADER = '# Conversation handoff'
/** Wire separator between the handoff summary and the pending draft. */
const HANDOFF_DRAFT_SEP = '\n\n---\n\n'

/** Exact producer framing: header line followed by a blank line. A bare
 * `startsWith('# Conversation handoff')` would also match user-authored text
 * like `# Conversation handoff!` — gate on the emitted prefix only. */
const HANDOFF_PREFIX = `${HANDOFF_HEADER}\n\n`

/**
 * spec-agent-switch-separator-redesign: strip a handoff preamble from a
 * persisted/replayed `user_prompt` text block. Legacy (pre-fix) records stored
 * the wire framing verbatim — `summary + --- + draft`; on replay the bubble
 * must show only the draft. `null` when the record IS the summary (a
 * summary-only switch's echo) → the caller drops the whole user row.
 * Non-handoff text returns unchanged.
 */
export function stripHandoffPreamble(text: string): string | null {
  if (!text.startsWith(HANDOFF_PREFIX)) return text
  const sep = text.indexOf(HANDOFF_DRAFT_SEP)
  if (sep === -1) return null
  const draft = text.slice(sep + HANDOFF_DRAFT_SEP.length).trim()
  return draft.length > 0 ? draft : null
}

/** The wire preamble line between the header and the turn list. */
const HANDOFF_PREAMBLE_RE =
  /^You are taking over a conversation previously handled by .+ Summary of the prior conversation:$/

/**
 * Strip the wire framing from a handoff summary for the summary card — the
 * `# Conversation handoff` header line AND the `You are taking over a
 * conversation previously handled by <agent>. Summary of the prior
 * conversation:` preamble. The card's `old → new` chip already carries the
 * handoff identity; rendering the wire sentence again reads as a stray log
 * line, not a label. Single canonical definition — the Rust fold keys off
 * the same `header + '\n\n'` prefix. Non-handoff text returns unchanged.
 */
export function stripHandoffHeader(text: string): string {
  if (!text.startsWith(HANDOFF_PREFIX)) return text
  const body = text.slice(HANDOFF_PREFIX.length)
  // Drop a leading wire preamble line (matches the emitted
  // `preamble + '\n\n'` exactly — a corrupt/empty preamble stays as body
  // rather than eating a real turn line).
  const firstBreak = body.indexOf('\n\n')
  if (firstBreak === -1) return body
  const firstLine = body.slice(0, firstBreak)
  return HANDOFF_PREAMBLE_RE.test(firstLine) ? body.slice(firstBreak + 2) : body
}

type HandoffItem = { kind: 'message'; message: ChatMessage } | { kind: 'tool'; tool: ToolCall }

interface Stamped {
  item: HandoffItem
  seq?: number
  ts: number
  order: number
}

/**
 * Merge messages and tool calls into one arrival-ordered list — the same
 * ordering model as `buildTimeline`: `seq` first, then `timestamp`, stable
 * input order breaking ties (seqless history sorts before any seq-stamped
 * live item).
 */
function mergeByArrival(messages: ChatMessage[], toolCalls: ToolCall[]): HandoffItem[] {
  const stamped: Stamped[] = []
  messages.forEach((message, i) => {
    stamped.push({
      item: { kind: 'message', message },
      seq: message.seq,
      ts: message.timestamp,
      order: i
    })
  })
  toolCalls.forEach((tc, i) => {
    stamped.push({
      item: { kind: 'tool', tool: tc },
      seq: typeof tc.seq === 'number' ? tc.seq : undefined,
      ts: typeof tc.timestamp === 'number' ? tc.timestamp : 0,
      order: 1000 + i
    })
  })
  stamped.sort((a, b) => {
    const aHas = a.seq != null
    const bHas = b.seq != null
    if (aHas !== bHas) return aHas ? 1 : -1
    if (a.seq != null && b.seq != null) return a.seq - b.seq
    if (a.ts !== b.ts) return a.ts - b.ts
    return a.order - b.order
  })
  return stamped.map((s) => s.item)
}

/**
 * The non-printing chars a token can carry: private-use sentinels
 * `\uE000`–`\uE007` (skill/command/file token markers), the file-token unit
 * separator `\u001F`, and the skill-token padding char `\u2007`. The token
 * parsers treat malformed leftovers (a stray start sentinel with no closing
 * partner, an empty-name token, a file token with no separator) as plain
 * text, so a corrupted or pasted value could still leak them. The wire
 * contract here is absolute — none of these ever reach the agent — so any
 * survivor is dropped. (A char-code filter, not a regex literal: Biome
 * rejects `\u001F` in a regex pattern.)
 */
const TOKEN_NOISE_CODES = new Set<number>()
for (let c = 0xe000; c <= 0xe007; c++) TOKEN_NOISE_CODES.add(c)
TOKEN_NOISE_CODES.add(0x001f) // file-token unit separator
TOKEN_NOISE_CODES.add(0x2007) // skill-token padding (figure space)

/** True when the char is a token sentinel/separator/padding leftover. */
const isTokenNoise = (char: string): boolean => TOKEN_NOISE_CODES.has(char.charCodeAt(0))

/**
 * `sanitizeDisplayText` plus the residual noise sweep: sentinel-free text.
 * Used for free-form wire content (the pending user message, the agent
 * label) where the composer's own formatting — including newlines — is
 * preserved, matching the plain-text send path.
 */
function sanitizeWireText(value: string): string {
  return sanitizeDisplayText(value)
    .split('')
    .filter((ch) => !isTokenNoise(ch))
    .join('')
}

/**
 * Wire-block form of {@link sanitizeWireText} for callers that carry the
 * composer's structured blocks into a handoff dispatch (story 3): each text
 * block's text is swept sentinel-free exactly like the builder's own wire
 * output; non-text blocks (image/resource) pass through unchanged.
 */
export function sanitizeHandoffWireBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) =>
    block.type === 'text' && typeof block.text === 'string'
      ? { type: 'text', text: sanitizeWireText(block.text) }
      : block
  )
}
/**
 * `sanitizeWireText` plus whitespace collapse for summary fragments: any
 * run of whitespace (including the newlines a multi-line agent/tool
 * fragment would otherwise inject) becomes one space. The summary is
 * line-oriented — one turn line per fragment — so a newline inside a
 * fragment would break the `User:`/`Agent:`/`- ` line grammar.
 */
function sanitizeFragment(value: string): string {
  return sanitizeWireText(value).replace(/\s+/g, ' ')
}

/** Max characters of one summary fragment (message text or tool one-liner). */
const MAX_FRAGMENT_CHARS = 200

/**
 * Clamp one summary fragment to `MAX_FRAGMENT_CHARS` so a single huge turn
 * (a 4000-char command, a pasted log) cannot blow the summary budget — the
 * turn cap bounds turn count, not line length.
 */
function truncateFragment(value: string): string {
  if (value.length <= MAX_FRAGMENT_CHARS) return value
  return `${value.slice(0, MAX_FRAGMENT_CHARS)}…`
}

/** Sanitized, collapsed, truncated text of a message's text blocks. */
function messageText(message: ChatMessage): string {
  return truncateFragment(
    sanitizeFragment(
      message.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
    ).trim()
  )
}

/** Compact tool one-liner via `describeToolCall`, e.g. "Read auth.ts L1-40". */
function toolOneLiner(tc: ToolCall): string {
  const { verb, primary, detail } = describeToolCall(tc)
  const parts = [verb, primary, detail].filter((p) => p != null && p.trim().length > 0)
  return truncateFragment(sanitizeFragment(parts.join(' ')).trim())
}

/** One user-to-user conversation turn as the summary renders it. */
interface HandoffTurn {
  /**
   * Sanitized text of the user message that opened this turn, or null when
   * the turn opened without user text (agent/tool prelude, or a user message
   * with no text).
   */
  userText: string | null
  /** `Agent: …` lines and `- <tool one-liner>` bullets, in arrival order. */
  lines: string[]
}

const hasUserText = (t: HandoffTurn): t is HandoffTurn & { userText: string } => t.userText != null

function partitionTurns(items: HandoffItem[]): HandoffTurn[] {
  const turns: HandoffTurn[] = []
  let current: HandoffTurn | null = null

  const openTurn = (): HandoffTurn => {
    if (!current) {
      current = { userText: null, lines: [] }
      turns.push(current)
    }
    return current
  }

  for (const it of items) {
    if (it.kind === 'tool') {
      // `think` tool calls carry internal reasoning (`rawInput.thought`) —
      // the same content the `thought` message role excludes. Never a
      // one-liner: reasoning is not conversation.
      if (it.tool.kind === 'think') continue
      const oneLiner = toolOneLiner(it.tool)
      if (oneLiner.length > 0) openTurn().lines.push(`- ${oneLiner}`)
      continue
    }
    const message = it.message
    if (message.role === 'thought') continue
    // In-flight text is not settled conversation: a message still marked
    // streaming contributes nothing to the summary.
    if (message.streaming) continue
    const text = messageText(message)
    if (message.role === 'user') {
      // An attachment-only user turn (no text blocks) still counts: the
      // attachment is conversation content, so emit a placeholder rather
      // than letting the turn vanish from the summary.
      const hasNonText = message.blocks.some((b) => b.type !== 'text')
      current = {
        userText: text.length > 0 ? text : hasNonText ? ATTACHMENT_ONLY : null,
        lines: []
      }
      turns.push(current)
    } else if (text.length > 0) {
      openTurn().lines.push(`Agent: ${text}`)
    }
  }

  // Skip turns with no substantive content (trailing empty/streaming tails).
  return turns.filter((t) => hasUserText(t) || t.lines.length > 0)
}

/** Render one turn as `User: …` + `Agent: …`/tool lines. */
const turnSection = (turn: HandoffTurn): string =>
  [turn.userText != null ? `User: ${turn.userText}` : null, ...turn.lines]
    .filter((s): s is string => s != null)
    .join('\n')

function resolveMaxTurns(options: HandoffSummaryOptions | undefined): number {
  const raw = options?.maxTurns
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_TURNS
  return Math.floor(raw)
}

/** Total character budget for the summary body (header/preamble excluded). */
const MAX_SUMMARY_BODY_CHARS = 4000
const SUMMARY_TRUNCATED_MARKER = '[… summary truncated …]'

/**
 * Fit the assembled body to `MAX_SUMMARY_BODY_CHARS`. `maxTurns` bounds turn
 * count, not total size: one turn can hold many tool calls and agent
 * messages (each up to `MAX_FRAGMENT_CHARS`), so the body needs its own
 * budget. When the budget is hit, the oldest turn lines are dropped — every
 * line is self-labeled (`User:`/`Agent:`/`- `), so line-level truncation
 * preserves meaning — while the front matter (anchor + omission lines) and
 * the first user line stay pinned, and an explicit truncation marker marks
 * the cut.
 */
function fitBodyBudget(frontMatter: string[], turnSections: string[]): string {
  const sections = [...frontMatter, ...turnSections]
  if (sections.join('\n\n').length <= MAX_SUMMARY_BODY_CHARS) return sections.join('\n\n')

  const turnLines = turnSections.flatMap((section) => section.split('\n'))
  const firstUserIdx = turnLines.findIndex((line) => line.startsWith('User: '))
  const pinned = firstUserIdx >= 0 ? [...frontMatter, turnLines[firstUserIdx]] : frontMatter
  const rest = turnLines.filter((_, i) => i !== firstUserIdx)

  const kept: string[] = []
  for (const line of [...rest].reverse()) {
    const candidate = [...pinned, SUMMARY_TRUNCATED_MARKER, line, ...kept].join('\n')
    if (candidate.length > MAX_SUMMARY_BODY_CHARS) break
    kept.unshift(line)
  }
  const droppedAny = kept.length < rest.length
  return [pinned.join('\n'), ...(droppedAny ? [SUMMARY_TRUNCATED_MARKER] : []), ...kept].join('\n')
}

/**
 * Build the handoff summary/wire/display triple from the old session's
 * transcript. Pure and deterministic: identical inputs yield byte-identical
 * outputs.
 */
export function buildHandoffSummary(input: HandoffSummaryInput): HandoffSummaryResult {
  const maxTurns = resolveMaxTurns(input.options)
  const turns = partitionTurns(mergeByArrival(input.messages, input.toolCalls))

  const capped = turns.length > maxTurns ? turns.slice(turns.length - maxTurns) : turns

  // Keep the first user message as the intent anchor when truncation drops
  // its turn, and mark the omitted span so the new agent (and the persisted
  // summary) knows history is elided, not absent. The anchor turn, when
  // surfaced, is present in the summary — the omission count hides only the
  // turns neither capped nor anchored.
  let anchorLine: string | null = null
  let omissionLine: string | null = null
  if (turns.length > maxTurns) {
    const firstUserTurn = turns.find(hasUserText)
    const anchorDropped = firstUserTurn != null && !capped.includes(firstUserTurn)
    if (anchorDropped) anchorLine = `User: ${firstUserTurn.userText}`
    // Hidden count = turns outside the capped tail, minus the anchor turn
    // when its line is surfaced.
    const dropped = turns.length - capped.length - (anchorDropped ? 1 : 0)
    if (dropped > 0) {
      omissionLine = `[… ${dropped} earlier turn${dropped === 1 ? '' : 's'} omitted …]`
    }
  }

  // `maxTurns` bounds turn count, not total size: one turn can hold many
  // tool calls and agent messages (each up to MAX_FRAGMENT_CHARS). Cap the
  // total body budget too, dropping from the oldest retained content while
  // keeping the header, preamble, first-user anchor, and the most recent
  // turns; mark the cut explicitly when hit.
  const body = fitBodyBudget(
    [anchorLine, omissionLine].filter((s): s is string => s != null && s.length > 0),
    capped.map(turnSection)
  )

  // The label sits in the one-line preamble: collapse whitespace so a
  // newline in the name cannot break the preamble line.
  const agentLabel = sanitizeFragment(input.agentName ?? '').trim() || GENERIC_AGENT_LABEL
  const preamble = `You are taking over a conversation previously handled by ${agentLabel}. Summary of the prior conversation:`
  const summaryText = body.length > 0 ? `${HANDOFF_HEADER}\n\n${preamble}\n\n${body}` : ''

  const pendingDisplay = input.pendingText.trim()
  const pendingWire = sanitizeWireText(input.pendingText).trim()

  let wireText: string
  if (summaryText.length > 0 && pendingWire.length > 0) {
    wireText = `${summaryText}\n\n---\n\n${pendingWire}`
  } else if (summaryText.length > 0) {
    wireText = summaryText
  } else {
    wireText = pendingWire
  }

  return {
    summaryText,
    wireBlocks: wireText.length > 0 ? [{ type: 'text', text: wireText }] : [],
    displayBlocks: pendingDisplay.length > 0 ? [{ type: 'text', text: pendingDisplay }] : []
  }
}
