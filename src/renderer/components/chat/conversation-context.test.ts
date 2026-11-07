import { describe, expect, it } from 'vitest'
import { conversationToken } from '@/lib/skill-tokens'
import type { ChatMessage } from '@/stores/acp-store'
import { buildConversationContext, stripHandoffPreamble } from './handoff-summary'

function msg(id: string, role: ChatMessage['role'], seq: number, text: string): ChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], streaming: false, timestamp: seq * 10, seq }
}

describe('buildConversationContext', () => {
  it('serializes the chat as labelled turns under a non-handoff intro', () => {
    const text = buildConversationContext({
      title: 'Fix web reconnect',
      agentName: 'Claude',
      toolCalls: [{ toolCallId: 't1', seq: 2, timestamp: 20, kind: 'read', title: 'ws.ts' }],
      messages: [
        msg('u1', 'user', 1, `why does ${conversationToken('Other', 'x')} drop?`),
        msg('a1', 'agent', 3, 'Backoff resets too early.')
      ]
    })
    expect(text).toBe(
      'Transcript of the Troupe chat "Fix web reconnect" with Claude, attached by the user as context.\n\n' +
        'User: why does (conversation: Other) drop?\n' +
        '- Read ws.ts\n' +
        'Agent: Backoff resets too early.'
    )
    expect(text.startsWith('# Conversation handoff')).toBe(false)
    expect(stripHandoffPreamble(text)).toBe(text)
  })

  it('keeps the final agent answer whole but clamps earlier long fragments', () => {
    const long = 'x'.repeat(3000)
    const text = buildConversationContext({
      title: 'Long',
      agentName: null,
      toolCalls: [],
      messages: [
        msg('u1', 'user', 1, 'q1'),
        msg('a1', 'agent', 2, long),
        msg('u2', 'user', 3, 'q2'),
        msg('a2', 'agent', 4, long)
      ]
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe(
      'Transcript of the Troupe chat "Long" with an agent, attached by the user as context.'
    )
    expect(lines[3]).toBe(`Agent: ${'x'.repeat(1500)}…`)
    expect(lines[6]).toBe(`Agent: ${long}`)
  })

  it('says so when the chat has no messages', () => {
    expect(
      buildConversationContext({ title: 'Empty', agentName: 'Codex', toolCalls: [], messages: [] })
    ).toBe(
      'Transcript of the Troupe chat "Empty" with Codex, attached by the user as context.\n\n(This chat has no messages yet.)'
    )
  })
})

describe('buildConversationContext budget edges', () => {
  it('caps a long agent name in the intro', () => {
    const text = buildConversationContext({
      title: 'Named',
      agentName: 'n'.repeat(2000),
      toolCalls: [],
      messages: []
    })
    expect(text).toBe(
      `Transcript of the Troupe chat "Named" with ${'n'.repeat(1500)}…, attached by the user as context.\n\n(This chat has no messages yet.)`
    )
  })

  it('keeps the final reply when long pinned lines leave no room for it whole', () => {
    const messages: ChatMessage[] = []
    for (let turn = 0; turn < 14; turn++) {
      messages.push(msg(`u${turn}`, 'user', turn * 2 + 1, `${turn}`.padEnd(2000, 'q')))
      messages.push(msg(`a${turn}`, 'agent', turn * 2 + 2, `answer ${turn}`))
    }
    messages.push(msg('u-final', 'user', 100, 'last question'))
    messages.push(msg('a-final', 'agent', 101, 'f'.repeat(9500)))
    const lines = buildConversationContext({
      title: 'Pinned',
      agentName: null,
      toolCalls: [],
      messages
    }).split('\n')
    expect(lines.at(-2)).toBe('User: last question')
    expect(lines.at(-1)).toBe(`Agent: ${'f'.repeat(1500)}…`)
  })

  it('shortens the final reply when the tool lines after it leave no room for it whole', () => {
    const tools = [1, 2, 3, 4].map((n) => ({
      toolCallId: `t${n}`,
      seq: 2 + n,
      timestamp: (2 + n) * 10,
      kind: 'read' as const,
      title: `${n}`.padEnd(1400, 'p')
    }))
    const lines = buildConversationContext({
      title: 'Tail',
      agentName: null,
      toolCalls: tools,
      messages: [msg('u1', 'user', 1, 'q'), msg('a1', 'agent', 2, 'f'.repeat(8000))]
    }).split('\n')
    expect(lines.slice(2)).toEqual([
      'User: q',
      `Agent: ${'f'.repeat(1500)}…`,
      ...[1, 2, 3, 4].map((n) => `- Read ${`${n}`.padEnd(1400, 'p')}`)
    ])
  })
})
