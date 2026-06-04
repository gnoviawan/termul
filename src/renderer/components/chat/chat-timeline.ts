import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'

export type TimelineItem =
  | { kind: 'message'; key: string; message: ChatMessage }
  | { kind: 'tool'; key: string; tool: ToolCall }

interface Stamped {
  item: TimelineItem
  ts: number
  /** Source order, stable tiebreaker for equal timestamps. */
  order: number
  /** True for the agent's final text response (sorts last within its turn). */
  isAgentText: boolean
}

/** Arrival timestamp for a tool call (stamped in the store), with a fallback. */
function toolTs(tool: ToolCall): number {
  return typeof tool.timestamp === 'number' ? tool.timestamp : 0
}

/**
 * Merge messages and tool calls into one timeline where, within each turn,
 * non-response items (thinking, tool calls) precede the agent's final text
 * response.
 *
 * A "turn" starts at a user message. Items are ordered chronologically across
 * turns, but agent text is pinned to the end of its own turn so tool calls and
 * thinking that share (or slightly trail) its timestamp still render first.
 */
export function buildTimeline(messages: ChatMessage[], toolCalls: ToolCall[]): TimelineItem[] {
  const stamped: Stamped[] = []

  messages.forEach((message, i) => {
    stamped.push({
      item: { kind: 'message', key: message.id, message },
      ts: message.timestamp,
      order: i,
      isAgentText: message.role === 'agent'
    })
  })

  toolCalls.forEach((tool, i) => {
    stamped.push({
      item: { kind: 'tool', key: tool.toolCallId, tool },
      ts: toolTs(tool),
      order: 1000 + i,
      isAgentText: false
    })
  })

  // Base chronological order (stable on equal timestamps via source order).
  stamped.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.order - b.order))

  // Assign each item a turn index: increments at every user message.
  let turn = 0
  const turnOf = new Map<Stamped, number>()
  for (const s of stamped) {
    if (s.item.kind === 'message' && s.item.message.role === 'user') turn += 1
    turnOf.set(s, turn)
  }

  // Re-sort: by turn, then agent-text last within the turn, then chronological.
  return stamped
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ta = turnOf.get(a.s) ?? 0
      const tb = turnOf.get(b.s) ?? 0
      if (ta !== tb) return ta - tb
      if (a.s.isAgentText !== b.s.isAgentText) return a.s.isAgentText ? 1 : -1
      return a.i - b.i
    })
    .map(({ s }) => s.item)
}
