/**
 * The host's canonical subagent record at ingest: parsed off
 * `_meta["termul/subagent"]`, replaced when present, kept when absent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn(async () => undefined) }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: logMock }))
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    loadSessionPayload: vi.fn(async () => null),
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

import { SUBAGENT_CONTROL_META_KEY, SUBAGENT_META_KEY } from '@shared/types/subagent'
import { subagentStatus } from '@/components/chat/subagent-strip'
import type { ToolCall } from '@/lib/acp-api'
import {
  endedState,
  subagentMeta,
  subagentRecord,
  subagentToolCall
} from '@/lib/test-utils/subagent'
import {
  _flushCoalescedForTesting,
  _resetCoalesceForTesting,
  useAcpStore
} from '@/stores/acp-store'
import {
  _resetSubagentRecordLogsForTesting,
  cancelRunningSubagents,
  parseSubagent,
  parseSubagentControl
} from './subagent-lifecycle'
import { FRESH, seedSession } from './testkit'

function ingest(kind: 'call' | 'update', payload: Record<string, unknown>): void {
  const store = useAcpStore.getState()
  if (kind === 'call') {
    store._onToolCall({
      agentId: 'agent-1',
      sessionId: 's1',
      toolCall: payload as { toolCallId: string }
    })
  } else {
    store._onToolCallUpdate({
      agentId: 'agent-1',
      sessionId: 's1',
      update: payload as { toolCallId: string }
    })
  }
  _flushCoalescedForTesting()
}

const stored = (id: string): ToolCall => {
  const call = useAcpStore.getState().toolCalls.s1?.find((tc) => tc.toolCallId === id)
  if (!call) throw new Error(`no tool call ${id}`)
  return call
}

const warnings = () =>
  logMock.mock.calls
    .map(([entry]) => entry as unknown as { level: string; source: string; message: string })
    .filter((entry) => entry.level === 'warn' && entry.source === 'acp-store.subagentRecord')

const record = subagentRecord({
  dispatchToolCallId: 'tc-1',
  background: true,
  role: 'general-purpose',
  prompt: 'Read every file under src/renderer and report.',
  startedAt: 1_000,
  usage: { totalTokens: 1_200, durationMs: 4_000 },
  outputFile: '/tmp/agent-abc.output'
})

beforeEach(() => {
  logMock.mockClear()
  _resetSubagentRecordLogsForTesting()
})

describe('parseSubagent', () => {
  it('reads a valid record', () => {
    expect(parseSubagent('tc-1', subagentMeta(record))).toEqual(record)
    const ended = subagentRecord({
      state: { activity: 'idle', end: { reason: 'failed', error: 'boom' } }
    })
    expect(parseSubagent('tc-1', subagentMeta(ended))).toEqual(ended)
  })

  it('is undefined without the key, and drops fields the contract does not name', () => {
    expect(parseSubagent('tc-1', { claudeCode: {} })).toBeUndefined()
    expect(parseSubagent('tc-1', undefined)).toBeUndefined()
    expect(
      parseSubagent('tc-1', subagentMeta({ ...record, extra: 'x' } as never))
    ).not.toHaveProperty('extra')
    expect(warnings()).toEqual([])
  })

  it.each([
    ['a missing id', { ...record, id: undefined }],
    ['an unknown source', { ...record, source: 'other' }],
    ['an unknown activity', { ...record, activity: 'done' }],
    ['a non-finite number', { ...record, startedAt: Number.NaN }],
    ['a bad caps.stop', { ...record, caps: { ...record.caps, stop: 'kill' } }],
    ['an end on a running record', { ...record, end: { reason: 'completed' } }],
    ['an idle record without an end', { ...record, activity: 'idle' }],
    ['an unknown end reason', { ...record, activity: 'idle', end: { reason: 'gone' } }]
  ])('drops a record with %s', (_label, bad) => {
    expect(parseSubagent('tc-1', { [SUBAGENT_META_KEY]: bad })).toBeUndefined()
    expect(warnings()).toHaveLength(1)
  })

  it('warns once per tool call id', () => {
    const bad = { [SUBAGENT_META_KEY]: { ...record, activity: 'idle' } }
    parseSubagent('tc-1', bad)
    parseSubagent('tc-1', bad)
    parseSubagent('tc-2', bad)
    expect(warnings().map((entry) => entry.message)).toEqual([
      'Dropped malformed termul/subagent on tool call tc-1: bad end',
      'Dropped malformed termul/subagent on tool call tc-2: bad end'
    ])
  })
})

describe('parseSubagentControl', () => {
  it('reads the steered ids and drops a malformed marker', () => {
    expect(
      parseSubagentControl('w1', { [SUBAGENT_CONTROL_META_KEY]: { subagentIds: ['t1', 't2'] } })
    ).toEqual({ subagentIds: ['t1', 't2'] })
    expect(
      parseSubagentControl('w1', { [SUBAGENT_CONTROL_META_KEY]: { subagentIds: [1] } })
    ).toBeUndefined()
    expect(warnings()).toHaveLength(1)
  })
})

describe('subagent record ingest', () => {
  beforeEach(() => {
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
    seedSession('s1', 'agent-1')
  })

  it('lifts the record on a live tool call and replaces it on an update', () => {
    ingest('call', { toolCallId: 'tc-1', status: 'pending', _meta: subagentMeta(record) })
    expect(stored('tc-1').subagent).toEqual(record)

    const ended = { ...record, ...endedState('completed'), endedAt: 9_000 }
    ingest('update', { toolCallId: 'tc-1', _meta: subagentMeta(ended) })
    expect(stored('tc-1').subagent).toEqual(ended)
    expect(subagentStatus(stored('tc-1'), 'active')).toBe('done')
  })

  it('keeps the record when an update does not carry it, or carries a malformed one', () => {
    ingest('call', { toolCallId: 'tc-1', status: 'pending', _meta: subagentMeta(record) })
    // The adapter's next update replaces `_meta` wholesale.
    ingest('update', { toolCallId: 'tc-1', status: 'completed', _meta: { claudeCode: {} } })
    expect(stored('tc-1').status).toBe('completed')
    expect(stored('tc-1').subagent).toEqual(record)
    expect(subagentStatus(stored('tc-1'), 'ended')).toBe('running')

    ingest('update', { toolCallId: 'tc-1', _meta: { [SUBAGENT_META_KEY]: { activity: 'idle' } } })
    expect(stored('tc-1').subagent).toEqual(record)
    expect(warnings()).toHaveLength(1)
  })

  it('lifts the control marker', () => {
    ingest('call', {
      toolCallId: 'w1',
      title: 'wait',
      _meta: { [SUBAGENT_CONTROL_META_KEY]: { subagentIds: ['t1'] } }
    })
    expect(stored('w1').subagentControl).toEqual({ subagentIds: ['t1'] })
    expect(stored('w1').subagent).toBeUndefined()
  })

  it('keeps the record when an oversized call degrades to the structural subset', () => {
    ingest('call', { toolCallId: 'tc-1', status: 'completed', _meta: subagentMeta(record) })
    ingest('update', { toolCallId: 'tc-1', blob: 'x'.repeat(500_000) })
    expect(stored('tc-1').blob).toBeUndefined()
    expect(stored('tc-1').subagent).toEqual(record)
  })
})

describe('cancelRunningSubagents', () => {
  const user = { id: 'u', role: 'user' as const, blocks: [], timestamp: 5, seq: 5 }

  it('ends records a live source still reports running', () => {
    const running = subagentToolCall(
      { caps: { liveProgress: true }, state: { activity: 'requires_action' } },
      { toolCallId: 'child-1', status: 'in_progress' }
    )
    const done = subagentToolCall(
      { caps: { liveProgress: true }, state: endedState(), endedAt: 5 },
      { toolCallId: 'child-2', status: 'completed' }
    )
    const toolCalls = { s1: [running, done], s2: [running] }
    const settled = cancelRunningSubagents({ toolCalls, messages: {} }, ['s1'], 20)
    expect(settled).not.toBe(toolCalls)
    expect(settled.s1[0]?.subagent).toEqual({
      ...running.subagent,
      activity: 'idle',
      end: { reason: 'unexplained' },
      endedAt: 20
    })
    expect(subagentStatus(settled.s1[0] as ToolCall, 'ended')).toBe('stopped')
    expect(settled.s1[1]).toBe(done)
    expect(settled.s2).toBe(toolCalls.s2)
    expect(cancelRunningSubagents({ toolCalls: settled, messages: {} }, ['s1'], 30)).toBe(settled)
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        message: 'Cancelled 1 running subagents on chat s1: the agent process is gone'
      })
    )
  })

  it('ends a background launch of the latest turn, and leaves older ones', () => {
    const launch = (toolCallId: string, seq: number): ToolCall =>
      subagentToolCall({ background: true }, { toolCallId, status: 'completed', seq })
    const earlier = launch('earlier', 2)
    const toolCalls = { s1: [earlier, launch('latest', 6)] }
    const settled = cancelRunningSubagents({ toolCalls, messages: { s1: [user] } }, ['s1'], 20)
    expect(settled.s1[0]).toBe(earlier)
    expect(settled.s1[1]?.subagent).toMatchObject({
      background: true,
      activity: 'idle',
      end: { reason: 'unexplained' },
      endedAt: 20
    })
  })
})
