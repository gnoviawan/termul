import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import {
  countSubagents,
  formatElapsed,
  formatTokens,
  isBackgroundSubagent,
  selectCurrentTurnSubagents,
  subagentDurationMs,
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

  it('drops an unstamped call once a stamped boundary splits the turns', () => {
    // Live ingest always stamps, so an unstamped call is old history.
    const legacy = sub({ toolCallId: 'legacy', seq: undefined, timestamp: undefined })
    expect(selectCurrentTurnSubagents([legacy], { seq: 5, timestamp: 50 })).toEqual([])
  })

  it('keeps an unstamped call when the boundary itself has no stamps', () => {
    const legacy = sub({ toolCallId: 'legacy', seq: undefined, timestamp: undefined })
    const picked = selectCurrentTurnSubagents([legacy], {})
    expect(picked.map((t) => t.toolCallId)).toEqual(['legacy'])
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

describe('background subagents', () => {
  const background = (partial: Partial<ToolCall> = {}) =>
    sub({ status: 'completed', subagentLifecycle: { background: true }, ...partial })

  it('runs while the turn is active even though the launch call completed', () => {
    expect(subagentStatus(background(), true)).toBe('running')
    expect(subagentStatus(background(), false)).toBe('done')
  })

  it('lets a known end state win over an active turn', () => {
    const ended = (state: 'completed' | 'failed' | 'cancelled') =>
      background({ subagentLifecycle: { background: true, state } })
    expect(subagentStatus(ended('completed'), true)).toBe('done')
    expect(subagentStatus(ended('failed'), true)).toBe('failed')
    expect(subagentStatus(ended('cancelled'), true)).toBe('stopped')
  })

  it('stays running after the turn when the host still reports running', () => {
    const live = sub({
      status: 'in_progress',
      subagentLifecycle: { state: 'running', agentId: 'child-1' }
    })
    expect(subagentStatus(live, false)).toBe('running')
  })

  it('times a background row from launch to its end, not by the launch duration', () => {
    const call = background({
      timestamp: 1_000,
      subagentUsage: { totalDurationMs: 4_000 },
      subagentLifecycle: { background: true, state: 'completed', endedAt: 181_000 }
    })
    expect(subagentDurationMs(call, 'done', 0, undefined)).toBe(180_000)
    expect(subagentDurationMs(background({ timestamp: 1_000 }), 'running', 61_000, undefined)).toBe(
      60_000
    )
    expect(subagentDurationMs(background({ timestamp: 1_000 }), 'done', 0, 91_000)).toBe(90_000)
  })

  it('keeps the reported total for a foreground row', () => {
    const call = sub({ timestamp: 1_000, subagentUsage: { totalDurationMs: 4_000 } })
    expect(subagentDurationMs(call, 'done', 0, 99_000)).toBe(4_000)
  })

  it('flags background rows', () => {
    expect(isBackgroundSubagent(background())).toBe(true)
    expect(isBackgroundSubagent(sub())).toBe(false)
  })
})

describe('Codex rows', () => {
  const collab = (id: string, title: string, seq: number, threads: string[]): ToolCall => ({
    toolCallId: id,
    title,
    kind: 'other',
    status: 'completed',
    seq,
    rawInput: {
      prompt: 'p',
      senderThreadId: 'parent',
      receiverThreadIds: threads,
      agentsStates: Object.fromEntries(threads.map((t) => [t, { status: 'running' }]))
    }
  })
  const activity = (id: string, kind: string, thread: string, seq: number): ToolCall => ({
    toolCallId: id,
    title: `${kind} subagent`,
    kind: 'other',
    status: 'completed',
    seq,
    rawInput: { agentThreadId: thread, agentPath: '/root/x', activityKind: kind }
  })

  it('shows one row per spawned agent, not per control call or activity card', () => {
    const picked = selectCurrentTurnSubagents(
      [
        collab('spawn-1', 'spawnAgent', 1, ['t1']),
        activity('start-1', 'started', 't1', 2),
        collab('wait-1', 'wait', 3, ['t1']),
        collab('send-1', 'sendInput', 4, ['t1']),
        activity('done-1', 'completed', 't1', 5)
      ],
      null
    )
    expect(picked.map((t) => t.toolCallId)).toEqual(['spawn-1'])
  })

  it('uses a started activity card when no spawn names its thread', () => {
    const picked = selectCurrentTurnSubagents(
      [activity('start-2', 'started', 't2', 1), activity('done-2', 'completed', 't2', 2)],
      null
    )
    expect(picked.map((t) => t.toolCallId)).toEqual(['start-2'])
  })
})
