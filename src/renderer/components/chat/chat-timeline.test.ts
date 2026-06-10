import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import { buildTimeline } from './chat-timeline'

function msg(id: string, role: ChatMessage['role'], timestamp: number): ChatMessage {
  return { id, role, blocks: [{ type: 'text', text: id }], streaming: false, timestamp }
}

function tool(id: string, timestamp: number): ToolCall {
  return { toolCallId: id, title: id, status: 'completed', timestamp }
}

describe('buildTimeline', () => {
  it('places tool calls and thinking before the final agent text in a turn', () => {
    const messages = [
      msg('user', 'user', 100),
      msg('thought', 'thought', 110),
      msg('agent', 'agent', 110)
    ]
    const tools = [tool('t1', 110), tool('t2', 115)]
    const order = buildTimeline(messages, tools).map((i) =>
      i.kind === 'tool' ? i.tool.toolCallId : i.message.id
    )
    // user → thinking/tools (same ts, weight 0) → final agent text (weight 1)
    expect(order).toEqual(['user', 'thought', 't1', 't2', 'agent'])
  })

  it('keeps multiple turns in chronological order', () => {
    const messages = [
      msg('u1', 'user', 10),
      msg('a1', 'agent', 20),
      msg('u2', 'user', 30),
      msg('a2', 'agent', 50)
    ]
    const tools = [tool('t1', 40)]
    const order = buildTimeline(messages, tools).map((i) =>
      i.kind === 'tool' ? i.tool.toolCallId : i.message.id
    )
    expect(order).toEqual(['u1', 'a1', 'u2', 't1', 'a2'])
  })

  it('returns an empty timeline when there is nothing', () => {
    expect(buildTimeline([], [])).toEqual([])
  })

  it('omits thought messages when showThoughts is false', () => {
    const messages = [
      msg('user', 'user', 100),
      msg('thought', 'thought', 110),
      msg('agent', 'agent', 120)
    ]
    const order = buildTimeline(messages, [], { showThoughts: false }).map((i) =>
      i.kind === 'message' ? i.message.id : i.kind
    )
    expect(order).toEqual(['user', 'agent'])
  })
})
