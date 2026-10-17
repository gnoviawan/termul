/**
 * Subagent usage scalars survive the adapter's `_meta` replacement: the Claude
 * adapter sends `toolResponse` in one update and a later status update replaces
 * `_meta`, so the store lifts the scalars into `subagentUsage` at ingest.
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

import {
  _flushCoalescedForTesting,
  _resetCoalesceForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { _resetSubagentUsageWarningsForTesting, extractSubagentUsage } from './subagent-usage'
import { FRESH, seedSession } from './testkit'

const meta = (toolResponse?: Record<string, unknown>) => ({
  claudeCode: { toolName: 'Agent', ...(toolResponse ? { toolResponse } : {}) }
})

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

const stored = () => useAcpStore.getState().toolCalls.s1[0]

describe('subagentUsage ingest', () => {
  beforeEach(() => {
    logMock.mockClear()
    _resetCoalesceForTesting()
    _resetSubagentUsageWarningsForTesting()
    useAcpStore.setState(FRESH)
    seedSession('s1', 'agent-1')
  })

  it('keeps usage after a later update replaces _meta (real adapter sequence)', () => {
    ingest('call', {
      toolCallId: 'tc-1',
      status: 'pending',
      rawInput: { description: 'Audit', prompt: 'p', subagent_type: 'general-purpose' },
      _meta: meta()
    })
    ingest('update', {
      toolCallId: 'tc-1',
      _meta: meta({
        status: 'completed',
        agentType: 'general-purpose',
        totalDurationMs: 3574,
        totalTokens: 37847,
        totalToolUseCount: 1,
        prompt: 'the full prompt',
        content: [{ type: 'text', text: 'the report' }],
        usage: { input_tokens: 1 }
      })
    })
    ingest('update', { toolCallId: 'tc-1', status: 'completed', _meta: meta() })

    expect(stored().status).toBe('completed')
    expect(stored().subagentUsage).toEqual({
      totalTokens: 37847,
      totalDurationMs: 3574,
      totalToolUseCount: 1
    })
  })

  it('keeps usage when an oversized call degrades to the structural subset', () => {
    ingest('call', { toolCallId: 'tc-1', status: 'pending' })
    ingest('update', {
      toolCallId: 'tc-1',
      _meta: meta({ totalTokens: 10, totalDurationMs: 20 })
    })
    // An unaccounted extra pushes the merged call over the live total budget.
    ingest('update', { toolCallId: 'tc-1', status: 'completed', blob: 'x'.repeat(500_000) })

    expect(stored().status).toBe('completed')
    expect(stored().blob).toBeUndefined()
    expect(stored().subagentUsage).toEqual({ totalTokens: 10, totalDurationMs: 20 })
  })

  it('warns once per call and field for invalid values and omits them', () => {
    const bad = meta({ totalTokens: '37847', totalDurationMs: -5, totalToolUseCount: 2 })
    expect(extractSubagentUsage('tc-9', bad)).toEqual({ totalToolUseCount: 2 })
    expect(extractSubagentUsage('tc-9', bad)).toEqual({ totalToolUseCount: 2 })
    expect(logMock).toHaveBeenCalledTimes(2)
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'acp-store.subagentUsage' })
    )
  })

  it('returns undefined without a usable toolResponse', () => {
    expect(extractSubagentUsage('t', undefined)).toBeUndefined()
    expect(extractSubagentUsage('t', meta())).toBeUndefined()
    expect(extractSubagentUsage('t', { claudeCode: 1 })).toBeUndefined()
  })
})
