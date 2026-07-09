import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'

export type TimelineItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'tool'; key: string; tool: ToolCall }
  | { kind: 'thought-group'; key: string; messages: ChatMessage[] }

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

/**
 * Group consecutive agent replies into turns. A turn is the run of agent
 * messages following a user message; intervening tool calls and thoughts don't
 * break it. Only the last agent reply of each turn is marked as the `tail`, and
 * carries the concatenated text of every agent reply in that turn — so a single
 * turn-level Copy yields the whole response, not one bubble.
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
    // thoughts: ignore, don't break the turn
  }
  flush()

  return { tail, text }
}

/**
 * Whether the bottom turn-running cue should show.
 *
 * Visible for the whole active turn except when the live tail is already
 * streaming a thought group or agent reply — those own their own in-progress UI.
 * Tools and quiet gaps keep the cue so the turn still reads as in flight.
 */
export function shouldShowTurnRunningIndicator(
  activeTurn: boolean,
  items: TimelineItem[]
): boolean {
  if (!activeTurn) return false
  const tail = items[items.length - 1]
  if (!tail) return true
  if (tail.kind === 'thought-group' && tail.messages.some((m) => m.streaming)) return false
  if (tail.kind === 'message' && tail.message.role === 'agent' && tail.message.streaming) {
    return false
  }
  return true
}
