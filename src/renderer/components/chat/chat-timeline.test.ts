import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import { buildTimeline, consolidateThoughtGroups } from './chat-timeline'

function msg(id: string, role: ChatMessage['role'], timestamp: number, seq?: number): ChatMessage {
  return { id, role, blocks: [{ type: 'text', text: id }], streaming: false, timestamp, seq }
}

function tool(id: string, timestamp: number, seq?: number): ToolCall {
  return { toolCallId: id, title: id, status: 'completed', timestamp, seq }
}

function timelineItemId(i: ReturnType<typeof buildTimeline>[number]): string {
  if (i.kind === 'tool') return i.tool.toolCallId
  if (i.kind === 'thought-group') return i.key
  return i.message.id
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
    const order = buildTimeline(messages, tools).map(timelineItemId)
    expect(order).toEqual(['user', 'a1', 't1', 't2', 'a2'])
  })

  it('orders thinking, tools, and text strictly by seq', () => {
    const messages = [
      msg('user', 'user', 100, 1),
      msg('thought', 'thought', 110, 2),
      msg('agent', 'agent', 110, 4)
    ]
    const tools = [tool('t1', 110, 3), tool('t2', 115, 5)]
    const order = buildTimeline(messages, tools).map(timelineItemId)
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
    const order = buildTimeline(messages, tools).map(timelineItemId)
    expect(order).toEqual(['u1', 'a1', 'u2', 't1', 'a2'])
  })

  it('sorts seqless history before seq-stamped items, by timestamp', () => {
    // Legacy persisted messages have no seq; live tools do.
    const messages = [msg('h1', 'user', 10), msg('h2', 'agent', 20)]
    const tools = [tool('t1', 5, 1)]
    const order = buildTimeline(messages, tools).map(timelineItemId)
    expect(order).toEqual(['h1', 'h2', 't1'])
  })

  it('returns an empty timeline when there is nothing', () => {
    expect(buildTimeline([], [])).toEqual([])
  })
})

describe('consolidateThoughtGroups', () => {
  it('merges consecutive thoughts into one group', () => {
    const items = buildTimeline(
      [
        msg('user', 'user', 100, 1),
        msg('t1', 'thought', 110, 2),
        msg('t2', 'thought', 115, 3),
        msg('agent', 'agent', 120, 4)
      ],
      []
    )
    const consolidated = consolidateThoughtGroups(items)
    expect(consolidated.map((i) => i.kind)).toEqual(['message', 'thought-group', 'message'])
    const group = consolidated[1]
    expect(group.kind).toBe('thought-group')
    if (group.kind === 'thought-group') {
      expect(group.messages.map((m) => m.id)).toEqual(['t1', 't2'])
      // Stable key: the first message id of the run (not the joined ids, which
      // would change as new chunks arrive and remount the ThoughtGroup).
      expect(group.key).toBe('t1')
    }
  })

  it('splits thoughts separated by tools into distinct groups', () => {
    const items = buildTimeline(
      [msg('user', 'user', 100, 1), msg('t1', 'thought', 110, 2), msg('agent', 'agent', 130, 4)],
      [tool('tc', 120, 3)]
    )
    const consolidated = consolidateThoughtGroups(items)
    expect(consolidated.map((i) => i.kind)).toEqual(['message', 'thought-group', 'tool', 'message'])
  })

  it('passes non-thought items through unchanged', () => {
    const items = buildTimeline([msg('user', 'user', 100, 1), msg('a1', 'agent', 110, 2)], [])
    expect(consolidateThoughtGroups(items)).toEqual(items)
  })
})
