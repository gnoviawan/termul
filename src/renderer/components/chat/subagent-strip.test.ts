import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import {
  countSubagents,
  formatElapsed,
  formatTokens,
  selectCurrentTurnSubagents,
  subagentMetrics,
  subagentStatus,
  subagentTitle,
  subagentType
} from './subagent-strip'

function sub(partial: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId: 'a1',
    rawInput: {
      description: 'Audit code',
      prompt: 'p',
      subagent_type: 'general-purpose'
    },
    ...partial
  }
}

describe('selectCurrentTurnSubagents', () => {
  const calls = [
    sub({ toolCallId: 'old', seq: 2 }),
    sub({ toolCallId: 'new', seq: 6 }),
    {
      toolCallId: 'read',
      kind: 'read' as const,
      rawInput: { path: 'a' },
      seq: 7
    }
  ]

  it('keeps only subagent calls after the latest user message', () => {
    const picked = selectCurrentTurnSubagents(calls, { seq: 5 })
    expect(picked.map((t) => t.toolCallId)).toEqual(['new'])
  })

  it('uses every subagent call when there is no user message', () => {
    expect(selectCurrentTurnSubagents(calls, null).map((t) => t.toolCallId)).toEqual(['old', 'new'])
  })

  it('falls back to timestamps when seq is missing', () => {
    const picked = selectCurrentTurnSubagents(
      [sub({ toolCallId: 'x', timestamp: 100 }), sub({ toolCallId: 'y', timestamp: 300 })],
      { timestamp: 200 }
    )
    expect(picked.map((t) => t.toolCallId)).toEqual(['y'])
  })

  it('skips restored summaries', () => {
    expect(selectCurrentTurnSubagents([sub({ restoredSummary: true })], null)).toEqual([])
  })
})

describe('subagentStatus and counts', () => {
  it('maps statuses', () => {
    expect(subagentStatus(sub({ status: 'pending' }), true)).toBe('running')
    expect(subagentStatus(sub({ status: 'in_progress' }), true)).toBe('running')
    expect(subagentStatus(sub({ status: 'completed' }), true)).toBe('done')
    expect(subagentStatus(sub({ status: 'failed' }), true)).toBe('failed')
  })

  it('classifies in-flight calls as stopped after the turn ended, counted as failed', () => {
    expect(subagentStatus(sub({ status: 'pending' }), false)).toBe('stopped')
    expect(subagentStatus(sub({ status: 'in_progress' }), false)).toBe('stopped')
    expect(subagentStatus(sub({ status: 'in_progress' }), true)).toBe('running')
    const list = [
      sub({ toolCallId: '1', status: 'in_progress' }),
      sub({ toolCallId: '2', status: 'failed' })
    ]
    expect(countSubagents(list, false)).toEqual({ running: 0, done: 0, failed: 2 })
  })

  it('treats a null status as running only while the turn is active', () => {
    expect(subagentStatus(sub({ status: undefined }), true)).toBe('running')
    expect(subagentStatus(sub({ status: undefined }), false)).toBe('done')
  })

  it('counts each bucket', () => {
    const list = [
      sub({ toolCallId: '1', status: 'in_progress' }),
      sub({ toolCallId: '2', status: 'completed' }),
      sub({ toolCallId: '3', status: 'completed' }),
      sub({ toolCallId: '4', status: 'failed' })
    ]
    expect(countSubagents(list, true)).toEqual({
      running: 1,
      done: 2,
      failed: 1
    })
  })
})

describe('title and type', () => {
  it('prefers description, then title, then a fallback', () => {
    expect(subagentTitle(sub())).toBe('Audit code')
    const codex = sub({
      title: 'Spawn agent',
      rawInput: { receiverThreadIds: ['t-1'] }
    })
    expect(subagentTitle(codex)).toBe('Spawn agent')
    expect(subagentTitle(sub({ title: undefined, rawInput: { receiverThreadIds: ['t'] } }))).toBe(
      'Subagent'
    )
  })

  it('reads subagent_type when present', () => {
    expect(subagentType(sub())).toBe('general-purpose')
    expect(subagentType(sub({ rawInput: { description: 'd', prompt: 'p' } }))).toBeUndefined()
  })
})

describe('subagentMetrics', () => {
  it('reads tokens and duration from subagentUsage', () => {
    expect(
      subagentMetrics(sub({ subagentUsage: { totalTokens: 37847, totalDurationMs: 3574 } }))
    ).toEqual({ totalTokens: 37847, totalDurationMs: 3574 })
  })

  it('returns nothing when subagentUsage is absent', () => {
    expect(subagentMetrics(sub())).toEqual({})
  })
})

describe('formatters', () => {
  it('formats elapsed as mm:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(3574)).toBe('00:03')
    expect(formatElapsed(65_000)).toBe('01:05')
    expect(formatElapsed(3_600_000)).toBe('1:00:00')
    expect(formatElapsed(3_725_000)).toBe('1:02:05')
    expect(formatElapsed(-5)).toBe('00:00')
  })

  it('formats tokens compactly', () => {
    expect(formatTokens(842)).toBe('842 tok')
    expect(formatTokens(37847)).toBe('37.8k tok')
    expect(formatTokens(2000)).toBe('2k tok')
    expect(formatTokens(1_250_000)).toBe('1.3M tok')
  })
})
