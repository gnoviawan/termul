import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import {
  endedState,
  type SubagentRecordOverrides,
  subagentToolCall
} from '@/lib/test-utils/subagent'
import {
  countSubagents,
  formatSubagentElapsed,
  formatTokens,
  runningBackgroundSubagents,
  selectCurrentTurnSubagents,
  subagentDurationMs,
  subagentStatus,
  subagentTitle,
  subagentType
} from './subagent-strip'

/** A dispatch call; the record mirrors the call (running while pending). */
function sub(partial: Partial<ToolCall> = {}, record: SubagentRecordOverrides = {}): ToolCall {
  return subagentToolCall({ role: 'general-purpose', ...record }, { toolCallId: 'a1', ...partial })
}

/** A foreground call the host settled from the tool-call status. */
function settled(
  reason: 'completed' | 'failed',
  partial: Partial<ToolCall> = {},
  record: SubagentRecordOverrides = {}
): ToolCall {
  return sub({ status: reason, ...partial }, { state: endedState(reason), ...record })
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
  it('maps a running record by the turn and an idle record by its end', () => {
    expect(subagentStatus(sub({ status: 'pending' }), 'active')).toBe('running')
    expect(subagentStatus(sub({ status: undefined }), 'active')).toBe('running')
    expect(subagentStatus(settled('completed'), 'active')).toBe('done')
    expect(subagentStatus(settled('failed'), 'active')).toBe('failed')
    expect(subagentStatus(sub({}, { state: endedState('cancelled') }), 'active')).toBe('stopped')
    expect(subagentStatus(sub({}, { state: endedState('unexplained') }), 'active')).toBe('stopped')
  })

  it('shows an unknown record as stopped, not failed', () => {
    expect(subagentStatus(sub({}, { state: { activity: 'unknown' } }), 'active')).toBe('stopped')
  })

  it('counts waiting for input as running', () => {
    expect(subagentStatus(sub({}, { state: { activity: 'requires_action' } }), 'active')).toBe(
      'running'
    )
  })

  it('classifies in-flight calls as stopped after the turn ended, apart from failed', () => {
    expect(subagentStatus(sub({ status: 'pending' }), 'ended')).toBe('stopped')
    expect(subagentStatus(sub({ status: 'in_progress' }), 'ended')).toBe('stopped')
    const list = [sub({ toolCallId: '1' }), settled('failed', { toolCallId: '2' })]
    expect(countSubagents(list.map((tc) => subagentStatus(tc, 'ended')))).toEqual({
      running: 0,
      done: 0,
      failed: 1,
      stopped: 1
    })
  })

  it('counts each bucket', () => {
    const list = [
      sub({ toolCallId: '1', status: 'in_progress' }),
      settled('completed', { toolCallId: '2' }),
      settled('completed', { toolCallId: '3' }),
      settled('failed', { toolCallId: '4' })
    ]
    expect(countSubagents(list.map((tc) => subagentStatus(tc, 'active')))).toEqual({
      running: 1,
      done: 2,
      failed: 1,
      stopped: 0
    })
  })
})

describe('title and type', () => {
  it('reads the record title', () => {
    expect(subagentTitle(sub({}, { title: 'Audit code' }))).toBe('Audit code')
    expect(subagentTitle({ toolCallId: 'x', title: 'Spawn agent' })).toBe('Spawn agent')
    expect(subagentTitle({ toolCallId: 'x' })).toBe('Subagent')
  })

  it('reads the role, then the description', () => {
    expect(subagentType(sub())).toBe('general-purpose')
    expect(subagentType(sub({}, { role: undefined, description: 'reviewer' }))).toBe('reviewer')
    expect(subagentType(sub({}, { role: undefined }))).toBeUndefined()
  })
})

describe('formatters', () => {
  it('formats elapsed as 42s, 3m 05s and 1h 02m', () => {
    expect(formatSubagentElapsed(0)).toBe('0s')
    expect(formatSubagentElapsed(42_900)).toBe('42s')
    expect(formatSubagentElapsed(185_000)).toBe('3m 05s')
    expect(formatSubagentElapsed(3_600_000)).toBe('1h 00m')
    expect(formatSubagentElapsed(3_725_000)).toBe('1h 02m')
    expect(formatSubagentElapsed(-5)).toBe('0s')
  })

  it('formats tokens compactly', () => {
    expect(formatTokens(842)).toBe('842 tok')
    expect(formatTokens(37847)).toBe('37.8k tok')
    expect(formatTokens(2000)).toBe('2k tok')
    expect(formatTokens(1_250_000)).toBe('1.3M tok')
  })
})

describe('background subagents', () => {
  const background = (partial: Partial<ToolCall> = {}, record: SubagentRecordOverrides = {}) =>
    sub({ status: 'completed', ...partial }, { background: true, ...record })

  it('keeps running after the turn ends even though the launch call completed', () => {
    expect(subagentStatus(background(), 'active')).toBe('running')
    expect(subagentStatus(background(), 'ended')).toBe('running')
    expect(
      countSubagents(
        [background(), settled('completed', { toolCallId: 'f' })].map((tc) =>
          subagentStatus(tc, 'ended')
        )
      )
    ).toEqual({ running: 1, done: 1, failed: 0, stopped: 0 })
  })

  it('lets a known end state win over an active turn', () => {
    const ended = (reason: 'completed' | 'failed' | 'cancelled') =>
      background({}, { state: endedState(reason) })
    expect(subagentStatus(ended('completed'), 'active')).toBe('done')
    expect(subagentStatus(ended('failed'), 'active')).toBe('failed')
    expect(subagentStatus(ended('cancelled'), 'active')).toBe('stopped')
  })

  it('reads a background launch that lost its end as done, a foreground one as stopped', () => {
    expect(subagentStatus(background({ status: 'in_progress' }), 'ended')).toBe('done')
    expect(subagentStatus(sub({ status: 'in_progress' }), 'ended')).toBe('stopped')
  })

  it('stays running after the turn when the source reports progress live', () => {
    const live = sub({ status: 'in_progress' }, { source: 'acp-rfd', caps: { liveProgress: true } })
    expect(subagentStatus(live, 'ended')).toBe('running')
  })

  it('times a background row from the host start stamp to its end, not by the launch duration', () => {
    const call = background(
      { timestamp: 500 },
      {
        startedAt: 1_000,
        usage: { durationMs: 4_000 },
        state: endedState('completed'),
        endedAt: 181_000
      }
    )
    expect(subagentDurationMs(call, 'done', 0, undefined)).toBe(180_000)
    expect(subagentDurationMs(background({ timestamp: 1_000 }), 'running', 61_000, undefined)).toBe(
      60_000
    )
    expect(subagentDurationMs(background({ timestamp: 1_000 }), 'done', 0, 91_000)).toBe(90_000)
  })

  it('times a running row from the host start stamp on a reopened chat', () => {
    const reopened = sub({ timestamp: 90_000 }, { startedAt: 30_000 })
    expect(subagentDurationMs(reopened, 'running', 100_000, undefined)).toBe(70_000)
  })

  it('keeps the reported total for a foreground row', () => {
    const call = settled('completed', { timestamp: 1_000 }, { usage: { durationMs: 4_000 } })
    expect(subagentDurationMs(call, 'done', 0, 99_000)).toBe(4_000)
  })
})

describe('runningBackgroundSubagents', () => {
  const user = (seq: number) => ({ role: 'user', seq, timestamp: seq })
  const agentReply = { role: 'agent', seq: 9, timestamp: 9 }
  const launch = (toolCallId: string, seq: number, record: SubagentRecordOverrides) =>
    sub({ toolCallId, seq, status: 'completed' }, record)
  const live = { caps: { liveProgress: true } }
  const ids = (calls: ToolCall[]) => calls.map((tc) => tc.toolCallId)

  it('lists the background launches of the latest turn that have not ended', () => {
    const calls = [
      launch('earlier-launch', 2, { background: true }),
      launch('earlier-live', 3, { background: true, ...live }),
      launch('launch', 6, { background: true }),
      launch('live', 7, live),
      launch('live-waiting', 7, { ...live, state: { activity: 'requires_action' } }),
      launch('completed', 7, { background: true, state: endedState('completed') }),
      launch('cancelled', 7, { background: true, state: endedState('cancelled') }),
      launch('unknown', 7, { background: true, state: { activity: 'unknown' } }),
      sub({ toolCallId: 'launch-failed', seq: 7, status: 'failed' }, { background: true }),
      sub({ toolCallId: 'foreground', seq: 8, status: 'in_progress' })
    ]
    expect(ids(runningBackgroundSubagents(calls, [user(1), user(5), agentReply]))).toEqual([
      'earlier-live',
      'launch',
      'live',
      'live-waiting'
    ])
  })

  it('counts every launch when the chat has no user message', () => {
    const calls = [launch('a', 2, { background: true })]
    expect(ids(runningBackgroundSubagents(calls, []))).toEqual(['a'])
  })

  it('is empty without tool calls', () => {
    expect(runningBackgroundSubagents(undefined, [user(1)])).toEqual([])
    expect(
      ids(runningBackgroundSubagents([launch('a', 2, { background: true })], [user(1)]))
    ).toEqual(['a'])
  })
})

describe('Codex rows', () => {
  it('shows one row per record, not per control call', () => {
    const control = (id: string, seq: number): ToolCall => ({
      toolCallId: id,
      title: 'wait',
      kind: 'other',
      status: 'completed',
      seq,
      subagentControl: { subagentIds: [] }
    })
    const picked = selectCurrentTurnSubagents(
      [
        sub({ toolCallId: 'spawn-1', seq: 1 }, { source: 'codex-collab', background: true }),
        control('wait-1', 2),
        control('send-1', 3)
      ],
      null
    )
    expect(picked.map((t) => t.toolCallId)).toEqual(['spawn-1'])
  })
})
