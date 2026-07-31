import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'

export type TimelineItem =
  | {
      kind: 'message'
      key: string
      message: ChatMessage
      /** True when this visible reply ends its turn. */
      isTurnTail?: boolean
      /** All agent narration in the turn, used by the turn-level copy action. */
      turnText?: string
    }
  | { kind: 'tool'; key: string; tool: ToolCall }
  | { kind: 'thought-group'; key: string; messages: ChatMessage[] }

export interface TurnActivityItem {
  kind: 'activity'
  key: string
  items: TimelineItem[]
  active: boolean
  durationMs: number | null
  attentionRequired: boolean
  hasFinalResponse: boolean
}

export type TurnTimelineItem = TimelineItem | TurnActivityItem

interface Stamped {
  item: TimelineItem
  /** Monotonic arrival seq, or undefined for history persisted before seq. */
  seq?: number
  ts: number
  /** Source order, stable tiebreaker for equal timestamps. */
  order: number
}

/** Arrival timestamp for a tool call (stamped in the store), with a fallback. */
function toolTs(tool: ToolCall): number {
  return typeof tool.timestamp === 'number' ? tool.timestamp : 0
}

/**
 * Merge messages and tool calls into one timeline in true chronological arrival
 * order, so text and tool calls interleave exactly as the agent emitted them
 * (`text → tool → tool → text`).
 *
 * Ordering key, in priority: monotonic `seq` (stamped at append time, robust
 * against same-millisecond ties); items lacking a seq (history persisted before
 * seq existed) sort first, by `timestamp`; source order breaks any remaining
 * ties.
 */
export function buildTimeline(messages: ChatMessage[], toolCalls: ToolCall[]): TimelineItem[] {
  const stamped: Stamped[] = []

  messages.forEach((message, i) => {
    stamped.push({
      item: { kind: 'message', key: message.id, message },
      seq: message.seq,
      ts: message.timestamp,
      order: i
    })
  })

  toolCalls.forEach((tool, i) => {
    stamped.push({
      item: { kind: 'tool', key: tool.toolCallId, tool },
      seq: typeof tool.seq === 'number' ? tool.seq : undefined,
      ts: toolTs(tool),
      order: 1000 + i
    })
  })

  stamped.sort((a, b) => {
    const aHas = a.seq != null
    const bHas = b.seq != null
    // Seqless history sorts before any seq-stamped (live) item.
    if (aHas !== bHas) return aHas ? 1 : -1
    if (aHas && bHas) return a.seq! - b.seq!
    if (a.ts !== b.ts) return a.ts - b.ts
    return a.order - b.order
  })

  return stamped.map((s) => s.item)
}

/**
 * Merge adjacent thought messages into a single display group (one Reasoning
 * block per thinking stretch, per AI SDK Elements pattern).
 */
export function consolidateThoughtGroups(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = []
  let batch: ChatMessage[] = []

  const flush = (): void => {
    if (batch.length === 0) return
    out.push({
      kind: 'thought-group',
      // Stable key: the first message id of the run. Using every id in the
      // batch would change the key each time a new thought chunk arrives and
      // remount the ThoughtGroup, dropping its local open/userOverride state.
      key: batch[0]!.id,
      messages: batch
    })
    batch = []
  }

  for (const it of items) {
    if (it.kind === 'message' && it.message.role === 'thought') {
      batch.push(it.message)
    } else {
      flush()
      out.push(it)
    }
  }
  flush()

  return out
}

/** Per-turn metadata for agent replies in a timeline. */
export interface AgentTurnMeta {
  /** Message ids that end an agent turn (the last agent reply before the next user turn). */
  tail: Set<string>
  /** Full turn text per tail id — every agent reply in that turn joined together. */
  text: Map<string, string>
}

function agentText(message: ChatMessage): string {
  return message.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

function hasSubstantiveText(message: ChatMessage): boolean {
  return message.blocks.some(
    (block) => block.type === 'text' && (block.text ?? '').trim().length > 0
  )
}

function hasMediaContent(message: ChatMessage): boolean {
  return message.blocks.some((block) => block.type !== 'text')
}

function itemTimestamp(item: TimelineItem | undefined): number | null {
  if (!item) return null
  if (item.kind === 'tool') {
    return typeof item.tool.timestamp === 'number' && item.tool.timestamp > 0
      ? item.tool.timestamp
      : null
  }
  if (item.kind === 'thought-group') {
    const timestamps = item.messages.map((message) => message.timestamp).filter((ts) => ts > 0)
    return timestamps.length > 0 ? Math.max(...timestamps) : null
  }
  if (item.kind === 'message') {
    return item.message.timestamp > 0 ? item.message.timestamp : null
  }
  return null
}

function activityNeedsAttention(items: TimelineItem[]): boolean {
  return items.some(
    (item) =>
      item.kind === 'tool' &&
      (item.tool.status === 'failed' ||
        item.tool.status === 'pending' ||
        item.tool.status === 'in_progress')
  )
}

/**
 * Partition user-to-user turns into one activity disclosure plus visible
 * assistant response content. Media-bearing agent messages always remain
 * outside completed activity. While a turn is live, substantive agent messages
 * also stay outside so later tools update the stable activity row instead of
 * moving/remounting the readable response; completion performs the one final
 * partition of text-only narration.
 */
export function groupTurnActivity(items: TimelineItem[], activeTurn: boolean): TurnTimelineItem[] {
  const out: TurnTimelineItem[] = []
  let user: TimelineItem | null = null
  let turn: TimelineItem[] = []
  let turnIndex = 0

  const flush = (active: boolean): void => {
    if (!user && turn.length === 0 && !active) return

    let finalTextIndex = -1
    if (!active) {
      for (let i = turn.length - 1; i >= 0; i--) {
        const item = turn[i]!
        if (item.kind !== 'message' || item.message.role !== 'agent') break
        if (hasSubstantiveText(item.message)) {
          finalTextIndex = i
          break
        }
        // Empty text-only tails and attachment-only replies are skipped: they
        // stay visible independently and don't disqualify the preceding final text.
      }
    }

    const visibleResponseIndices = new Set<number>()
    turn.forEach((item, index) => {
      if (item.kind !== 'message' || item.message.role !== 'agent') return
      if (hasMediaContent(item.message)) visibleResponseIndices.add(index)
      // Live intermediate + streaming text renders INSIDE the activity collapsible;
      // only the final response (finalTextIndex, computed when !active) stays outside.
    })
    if (finalTextIndex >= 0) visibleResponseIndices.add(finalTextIndex)

    const visibleResponses = turn.filter(
      (item, index): item is Extract<TimelineItem, { kind: 'message' }> =>
        visibleResponseIndices.has(index) && item.kind === 'message'
    )
    const activityItems = turn.filter((item, index) => {
      if (visibleResponseIndices.has(index)) return false
      // Keep only the TRAILING empty streaming live tail inside the collapsible
      // (so the caret renders there); non-trailing empty streaming messages are
      // dropped to avoid spurious blank bubbles. finalizeStreaming clears
      // `streaming` when activeTurn flips false, so this only applies while live.
      return !(
        item.kind === 'message' &&
        item.message.role === 'agent' &&
        !hasSubstantiveText(item.message) &&
        !hasMediaContent(item.message) &&
        !(index === turn.length - 1 && item.message.streaming)
      )
    })
    const allAgentText = turn
      .filter((item) => item.kind === 'message' && item.message.role === 'agent')
      .map((item) => (item.kind === 'message' ? agentText(item.message) : ''))
      .filter((text) => text.length > 0)
      .join('\n\n')

    if (user) out.push(user)

    if (activityItems.length > 0 || active) {
      const startedAt =
        user?.kind === 'message' && user.message.timestamp > 0 ? user.message.timestamp : null
      const endTimestamps = turn
        .map((turnItem) => itemTimestamp(turnItem))
        .filter((timestamp): timestamp is number => timestamp !== null)
      const endedAt = endTimestamps.length > 0 ? Math.max(...endTimestamps) : null
      const durationMs =
        !active && startedAt !== null && endedAt !== null && endedAt > startedAt
          ? endedAt - startedAt
          : null

      out.push({
        kind: 'activity',
        key: `activity:${user?.key ?? turn[0]?.key ?? turnIndex}`,
        items: activityItems,
        active,
        durationMs,
        attentionRequired: activityNeedsAttention(activityItems),
        hasFinalResponse: visibleResponses.length > 0
      })
    }

    // The turn tail carries the turn-level copy action. Prefer the last visible
    // response with substantive text so attachment-only positional tails don't
    // receive copy text; fall back to the final positional response when none of
    // the visible responses contain text.
    let turnTailIndex = visibleResponses.length - 1
    for (let i = visibleResponses.length - 1; i >= 0; i--) {
      if (hasSubstantiveText(visibleResponses[i]!.message)) {
        turnTailIndex = i
        break
      }
    }
    visibleResponses.forEach((response, index) => {
      const isTurnTail = index === turnTailIndex
      out.push({
        ...response,
        isTurnTail,
        turnText: isTurnTail && allAgentText.length > 0 ? allAgentText : undefined
      })
    })

    user = null
    turn = []
    turnIndex += 1
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'message' && item.message.role === 'user') {
      if (user || turn.length > 0) flush(false)
      user = item
    } else {
      turn.push(item)
    }

    if (i === items.length - 1) flush(activeTurn)
  }

  if (items.length === 0 && activeTurn) flush(true)

  return out
}

/**
 * Group consecutive agent replies into turns. Retained for callers that only
 * need action metadata without the activity presentation grouping.
 */
export function agentTurnMeta(items: TimelineItem[]): AgentTurnMeta {
  const tail = new Set<string>()
  const text = new Map<string, string>()

  let lastAgentId: string | null = null
  let turnTexts: string[] = []

  const flush = (): void => {
    if (lastAgentId) {
      tail.add(lastAgentId)
      text.set(lastAgentId, turnTexts.filter((t) => t.length > 0).join('\n\n'))
    }
    lastAgentId = null
    turnTexts = []
  }

  for (const it of items) {
    if (it.kind !== 'message') continue
    if (it.message.role === 'user') {
      flush()
      continue
    }
    if (it.message.role === 'agent') {
      lastAgentId = it.message.id
      turnTexts.push(agentText(it.message))
    }
  }
  flush()

  return { tail, text }
}
