import { describe, expect, it } from 'vitest'
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import type { ChatMessage } from '@/stores/acp-store'
import { buildTimeline, consolidateThoughtGroups, groupTurnActivity } from './chat-timeline'

function msg(
  id: string,
  role: ChatMessage['role'],
  timestamp: number,
  seq?: number,
  text = id
): ChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], streaming: false, timestamp, seq }
}

function agentBlocks(
  id: string,
  timestamp: number,
  seq: number,
  blocks: ContentBlock[],
  streaming = false
): ChatMessage {
  return { id, role: 'agent', blocks, streaming, timestamp, seq }
}

function tool(
  id: string,
  timestamp: number,
  seq?: number,
  status: ToolCall['status'] = 'completed'
): ToolCall {
  return { toolCallId: id, title: id, status, timestamp, seq }
}

function timelineItemId(i: ReturnType<typeof buildTimeline>[number]): string {
  if (i.kind === 'tool') return i.tool.toolCallId
  if (i.kind === 'thought-group') return i.key
  return i.message.id
}

describe('buildTimeline', () => {
  it('interleaves text and tool calls in arrival (seq) order', () => {
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

describe('groupTurnActivity', () => {
  it('groups each user turn and leaves the final substantive reply outside activity', () => {
    const items = consolidateThoughtGroups(
      buildTimeline(
        [
          msg('u1', 'user', 1_000, 1),
          msg('thought', 'thought', 1_200, 2),
          msg('narration', 'agent', 1_500, 3, 'Checking files'),
          msg('final', 'agent', 4_200, 5, 'Final answer'),
          msg('u2', 'user', 5_000, 6),
          msg('final-2', 'agent', 6_000, 7, 'Second answer')
        ],
        [tool('read', 2_000, 4)]
      )
    )

    const grouped = groupTurnActivity(items, false)
    expect(grouped.map((item) => item.kind)).toEqual([
      'message',
      'activity',
      'message',
      'message',
      'message'
    ])
    const activity = grouped[1]
    expect(activity.kind).toBe('activity')
    if (activity.kind === 'activity') {
      expect(activity.items.map(timelineItemId)).toEqual(['thought', 'narration', 'read'])
      expect(activity.durationMs).toBe(3_200)
    }
    const final = grouped[2]
    expect(final.kind).toBe('message')
    if (final.kind === 'message') {
      expect(final.message.id).toBe('final')
      expect(final.turnText).toBe('Checking files\n\nFinal answer')
    }
  })

  it('moves narration into activity when a later tool means it is not final', () => {
    const items = buildTimeline(
      [msg('user', 'user', 100, 1), msg('narration', 'agent', 110, 2, 'Trying this')],
      [tool('failed', 120, 3, 'failed')]
    )
    const grouped = groupTurnActivity(items, false)
    expect(grouped.map((item) => item.kind)).toEqual(['message', 'activity'])
    const activity = grouped[1]
    expect(activity.kind).toBe('activity')
    if (activity.kind === 'activity') {
      expect(activity.attentionRequired).toBe(true)
      expect(activity.hasFinalResponse).toBe(false)
      expect(activity.items.map(timelineItemId)).toEqual(['narration', 'failed'])
    }
  })

  it('keeps every media-bearing reply visible when later text and an empty tail arrive', () => {
    const items = buildTimeline(
      [
        msg('user', 'user', 100, 1),
        agentBlocks('attachment-only', 110, 2, [
          { type: 'resource_link', uri: 'file:///tmp/report.pdf', name: 'report.pdf' }
        ]),
        msg('narration', 'agent', 120, 3, 'Preparing the summary'),
        agentBlocks('image-and-caption', 130, 4, [
          { type: 'image', data: 'base64-image', mimeType: 'image/png' },
          { type: 'text', text: 'Chart preview' }
        ]),
        msg('final', 'agent', 150, 6, 'Final answer'),
        msg('empty-tail', 'agent', 160, 7, '   ')
      ],
      [tool('read', 140, 5)]
    )

    const grouped = groupTurnActivity(items, false)
    expect(grouped.map((item) => item.kind)).toEqual([
      'message',
      'activity',
      'message',
      'message',
      'message'
    ])
    const activity = grouped[1]
    expect(activity.kind).toBe('activity')
    if (activity.kind === 'activity') {
      expect(activity.items.map(timelineItemId)).toEqual(['narration', 'read'])
      expect(activity.hasFinalResponse).toBe(true)
    }
    expect(
      grouped
        .filter((item) => item.kind === 'message' && item.message.role === 'agent')
        .map((item) => (item.kind === 'message' ? item.message.id : ''))
    ).toEqual(['attachment-only', 'image-and-caption', 'final'])
    expect(grouped.some((item) => item.key === 'empty-tail')).toBe(false)
  })

  it('keeps the last substantive text visible when a media-only response follows it', () => {
    const items = buildTimeline(
      [
        msg('user', 'user', 100, 1),
        msg('final-text', 'agent', 120, 2, 'Final answer'),
        agentBlocks('attachment-tail', 130, 3, [
          { type: 'resource_link', uri: 'file:///tmp/report.pdf', name: 'report.pdf' }
        ])
      ],
      []
    )

    const grouped = groupTurnActivity(items, false)
    expect(
      grouped
        .filter((item) => item.kind === 'message' && item.message.role === 'agent')
        .map((item) => (item.kind === 'message' ? item.message.id : ''))
    ).toEqual(['final-text', 'attachment-tail'])

    const finalTextItem = grouped.find(
      (item) => item.kind === 'message' && item.message.id === 'final-text'
    )
    expect(finalTextItem?.kind).toBe('message')
    if (finalTextItem?.kind === 'message') {
      expect(finalTextItem.isTurnTail).toBe(true)
      expect(finalTextItem.turnText).toBe('Final answer')
    }
    const attachmentItem = grouped.find(
      (item) => item.kind === 'message' && item.message.id === 'attachment-tail'
    )
    expect(attachmentItem?.kind).toBe('message')
    if (attachmentItem?.kind === 'message') {
      expect(attachmentItem.isTurnTail).toBe(false)
      expect(attachmentItem.turnText).toBeUndefined()
    }
  })

  it('keeps a live response at a stable key when later activity arrives', () => {
    const liveResponse = msg('live-response', 'agent', 120, 2, 'Readable live answer')
    liveResponse.streaming = true
    const beforeTool = groupTurnActivity(
      buildTimeline([msg('user', 'user', 100, 1), liveResponse], []),
      true
    )
    const afterTool = groupTurnActivity(
      buildTimeline([msg('user', 'user', 100, 1), liveResponse], [tool('read', 130, 3)]),
      true
    )

    expect(beforeTool.map((item) => item.key)).toEqual(['user', 'activity:user', 'live-response'])
    expect(afterTool.map((item) => item.key)).toEqual(['user', 'activity:user', 'live-response'])
    const activity = afterTool[1]
    expect(activity.kind).toBe('activity')
    if (activity.kind === 'activity') {
      expect(activity.items.map(timelineItemId)).toEqual(['read'])
    }
  })

  it('keeps an active empty turn represented and omits duration without timestamps', () => {
    const source = buildTimeline([msg('user', 'user', 0, 1)], [])
    const grouped = groupTurnActivity(source, true)
    expect(grouped.map((item) => item.kind)).toEqual(['message', 'activity'])
    const activity = grouped[1]
    expect(activity.kind).toBe('activity')
    if (activity.kind === 'activity') {
      expect(activity.active).toBe(true)
      expect(activity.durationMs).toBeNull()
    }
  })
})
