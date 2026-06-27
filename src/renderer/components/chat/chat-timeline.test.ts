import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import { buildTimeline } from './chat-timeline'

function msg(id: string, role: ChatMessage['role'], timestamp: number, seq?: number): ChatMessage {
  return { id, role, blocks: [{ type: 'text', text: id }], streaming: false, timestamp, seq }
}

function tool(id: string, timestamp: number, seq?: number): ToolCall {
  return { toolCallId: id, title: id, status: 'completed', timestamp, seq }
}

describe('buildTimeline', () => {
  it('interleaves text and tool calls in arrival (seq) order', () => {
    // Agent emits: text → tool → tool → text, all within one turn.
    const messages = [
      msg('user', 'user', 100, 1),
      msg('a1', 'agent', 110, 2),
      msg('a2', 'agent', 130, 5)
    ]
    const tools = [tool('t1', 115, 3), tool('t2', 120, 4)]
    const order = buildTimeline(messages, tools).map((i) =>
      i.kind === 'tool' ? i.tool.toolCallId : i.message.id
    )
    expect(order).toEqual(['user', 'a1', 't1', 't2', 'a2'])
  })

  it('orders thinking, tools, and text strictly by seq', () => {
    const messages = [
      msg('user', 'user', 100, 1),
      msg('thought', 'thought', 110, 2),
      msg('agent', 'agent', 110, 4)
    ]
    const tools = [tool('t1', 110, 3), tool('t2', 115, 5)]
    const order = buildTimeline(messages, tools).map((i) =>
      i.kind === 'tool' ? i.tool.toolCallId : i.message.id
    )
    expect(order).toEqual(['user', 'thought', 't1', 'agent', 't2'])
  })

  it('keeps multiple turns in chronological order', () => {
    const messages = [
      msg('u1', 'user', 10, 1),
      msg('a1', 'agent', 20, 2),
      msg('u2', 'user', 30, 3),
      msg('a2', 'agent', 50, 5)
    ]
    const tools = [tool('t1', 40, 4)]
    const order = buildTimeline(messages, tools).map((i) =>
      i.kind === 'tool' ? i.tool.toolCallId : i.message.id
    )
    expect(order).toEqual(['u1', 'a1', 'u2', 't1', 'a2'])
  })

  it('sorts seqless history before seq-stamped items, by timestamp', () => {
    // Legacy persisted messages have no seq; live tools do.
    const messages = [msg('h1', 'user', 10), msg('h2', 'agent', 20)]
    const tools = [tool('t1', 5, 1)]
    const order = buildTimeline(messages, tools).map((i) =>
      i.kind === 'tool' ? i.tool.toolCallId : i.message.id
    )
    expect(order).toEqual(['h1', 'h2', 't1'])
  })

  it('returns an empty timeline when there is nothing', () => {
    expect(buildTimeline([], [])).toEqual([])
  })
})
