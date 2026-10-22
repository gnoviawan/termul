/**
 * Subagent lifecycle at ingest: a background launch completes its tool call
 * long before the agent ends, so the store keeps the agent state apart from
 * the tool-call status (Claude launch receipt, host marker, Codex states).
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

import { subagentStatus } from '@/components/chat/subagent-strip'
import { isSubagentRunning } from '@/components/chat/tool-call-summary'
import type { ToolCall } from '@/lib/acp-api'
import {
  _flushCoalescedForTesting,
  _resetCoalesceForTesting,
  useAcpStore
} from '@/stores/acp-store'
import {
  _resetSubagentLifecycleLogsForTesting,
  applyCodexThreadStates,
  cancelRunningSubagents,
  extractSubagentLifecycle,
  mergeSubagentLifecycle
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

const claudeAgentInput = {
  description: 'Audit the renderer',
  prompt: 'Read every file under src/renderer and report.',
  subagent_type: 'general-purpose',
  run_in_background: true
}

const asyncReceipt = {
  claudeCode: {
    toolName: 'Agent',
    toolResponse: {
      status: 'async_launched',
      isAsync: true,
      agentId: 'agent-abc',
      description: 'Audit the renderer',
      prompt: 'Read every file under src/renderer and report.',
      outputFile: '/tmp/agent-abc.output'
    }
  }
}

describe('subagent lifecycle ingest (Claude)', () => {
  beforeEach(() => {
    logMock.mockClear()
    _resetCoalesceForTesting()
    _resetSubagentLifecycleLogsForTesting()
    useAcpStore.setState(FRESH)
    seedSession('s1', 'agent-1')
  })

  it('keeps a background launch running after its tool call completes', () => {
    ingest('call', { toolCallId: 'tc-1', status: 'pending', rawInput: claudeAgentInput })
    ingest('update', { toolCallId: 'tc-1', _meta: asyncReceipt })
    // The adapter's next update replaces `_meta` wholesale.
    ingest('update', { toolCallId: 'tc-1', status: 'completed', _meta: { claudeCode: {} } })

    const call = stored('tc-1')
    expect(call.status).toBe('completed')
    expect(call.subagentLifecycle).toEqual({
      background: true,
      agentId: 'agent-abc',
      outputFile: '/tmp/agent-abc.output'
    })
    expect(isSubagentRunning(call, true)).toBe(true)
    expect(subagentStatus(call, true)).toBe('running')
    // Coarse end: the agent counts as done once the held parent turn ends.
    expect(subagentStatus(call, false)).toBe('done')
    expect(logMock).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', source: 'acp-store.subagentLifecycle' })
    )
  })

  it('detects the receipt without the run_in_background input', () => {
    ingest('call', {
      toolCallId: 'tc-2',
      status: 'completed',
      rawInput: { description: 'd', prompt: 'p' },
      _meta: asyncReceipt
    })
    expect(stored('tc-2').subagentLifecycle?.background).toBe(true)
    expect(isSubagentRunning(stored('tc-2'), true)).toBe(true)
  })

  it('keeps a foreground agent done when its tool call completes', () => {
    ingest('call', {
      toolCallId: 'tc-3',
      status: 'pending',
      rawInput: { description: 'd', prompt: 'p', subagent_type: 'Explore' }
    })
    ingest('update', {
      toolCallId: 'tc-3',
      status: 'completed',
      _meta: { claudeCode: { toolResponse: { status: 'completed', totalDurationMs: 90_000 } } }
    })
    const call = stored('tc-3')
    expect(call.subagentLifecycle).toBeUndefined()
    expect(subagentStatus(call, true)).toBe('done')
  })

  it('ends a background agent on the host marker while the turn is still active', () => {
    ingest('call', { toolCallId: 'tc-4', status: 'completed', rawInput: claudeAgentInput })
    expect(subagentStatus(stored('tc-4'), true)).toBe('running')
    ingest('update', {
      toolCallId: 'tc-4',
      _meta: { 'termul/subagent': { state: 'completed', sessionId: 'child-1', endedAt: 5000 } }
    })
    const call = stored('tc-4')
    expect(call.subagentLifecycle).toEqual({
      background: true,
      state: 'completed',
      agentId: 'child-1',
      endedAt: 5000
    })
    expect(subagentStatus(call, true)).toBe('done')
  })

  it('maps failed and cancelled host states', () => {
    ingest('call', { toolCallId: 'f', status: 'completed', rawInput: claudeAgentInput })
    ingest('call', { toolCallId: 'c', status: 'completed', rawInput: claudeAgentInput })
    ingest('update', { toolCallId: 'f', _meta: { 'termul/subagent': { state: 'failed' } } })
    ingest('update', { toolCallId: 'c', _meta: { 'termul/subagent': { state: 'cancelled' } } })
    expect(subagentStatus(stored('f'), true)).toBe('failed')
    expect(subagentStatus(stored('c'), true)).toBe('stopped')
  })

  it('keeps a Cursor background task running after its result arrives', () => {
    ingest('call', {
      toolCallId: 'cursor-1',
      status: 'pending',
      rawInput: { _toolName: 'task', description: 'Explore', prompt: 'Map the repo' }
    })
    ingest('update', {
      toolCallId: 'cursor-1',
      status: 'completed',
      rawOutput: { isBackground: true }
    })
    const call = stored('cursor-1')
    expect(call.subagentLifecycle).toEqual({ background: true })
    expect(subagentStatus(call, true)).toBe('running')
    expect(subagentStatus(call, false)).toBe('done')
  })

  it('keeps a Cursor foreground task done when its result arrives', () => {
    ingest('call', {
      toolCallId: 'cursor-2',
      status: 'completed',
      rawInput: { _toolName: 'task', description: 'Explore', prompt: 'Map the repo' },
      rawOutput: { durationMs: 95_000, isBackground: false }
    })
    expect(stored('cursor-2').subagentLifecycle).toBeUndefined()
    expect(subagentStatus(stored('cursor-2'), true)).toBe('done')
  })

  it('keeps an OpenCode background subagent running after its launch returns', () => {
    ingest('call', {
      toolCallId: 'oc-1',
      status: 'completed',
      rawInput: { agent: 'general', description: 'Explore', prompt: 'p', background: true }
    })
    expect(subagentStatus(stored('oc-1'), true)).toBe('running')
  })

  it('keeps the lifecycle when an oversized call degrades to the structural subset', () => {
    ingest('call', { toolCallId: 'tc-5', status: 'completed', rawInput: claudeAgentInput })
    ingest('update', { toolCallId: 'tc-5', blob: 'x'.repeat(500_000) })
    expect(stored('tc-5').blob).toBeUndefined()
    expect(stored('tc-5').subagentLifecycle?.background).toBe(true)
  })
})

describe('extractSubagentLifecycle', () => {
  it('ignores unknown states and over-long strings', () => {
    expect(
      extractSubagentLifecycle({
        toolCallId: 't',
        _meta: { 'termul/subagent': { state: 'idle', sessionId: 'x'.repeat(600) } }
      })
    ).toBeUndefined()
  })

  it('returns undefined for a plain tool call', () => {
    expect(
      extractSubagentLifecycle({ toolCallId: 't', rawInput: { command: 'ls' } })
    ).toBeUndefined()
  })
})

describe('mergeSubagentLifecycle', () => {
  it('adds fields and never clears them', () => {
    expect(
      mergeSubagentLifecycle({ background: true, agentId: 'a' }, { state: 'completed' })
    ).toEqual({ background: true, agentId: 'a', state: 'completed' })
  })

  it('drops the end stamp when the agent runs again', () => {
    expect(
      mergeSubagentLifecycle({ state: 'completed', endedAt: 10 }, { state: 'running' })
    ).toEqual({ state: 'running' })
  })
})

describe('applyCodexThreadStates', () => {
  const spawn = (agentsStates: Record<string, unknown>, extra: Partial<ToolCall> = {}) =>
    ({
      toolCallId: 'spawn-1',
      title: 'spawnAgent',
      kind: 'other',
      status: 'completed',
      seq: 1,
      rawInput: {
        prompt: 'Check the weather',
        senderThreadId: 'parent',
        receiverThreadIds: ['child-1'],
        agentsStates
      },
      ...extra
    }) as ToolCall

  const wait = (status: string, seq = 2): ToolCall => ({
    toolCallId: `wait-${seq}`,
    title: 'wait',
    kind: 'other',
    status: 'completed',
    seq,
    rawInput: {
      senderThreadId: 'parent',
      receiverThreadIds: ['child-1'],
      agentsStates: { 'child-1': { status, message: null } }
    }
  })

  it('keeps a spawned agent running until a later call reports it done', () => {
    const running = applyCodexThreadStates([spawn({ 'child-1': { status: 'running' } })])
    expect(running[0]?.subagentLifecycle).toEqual({
      background: true,
      state: 'running',
      agentId: 'child-1'
    })
    expect(subagentStatus(running[0]!, true)).toBe('running')

    const done = applyCodexThreadStates([
      spawn({ 'child-1': { status: 'running' } }),
      wait('completed')
    ])
    expect(done[0]?.subagentLifecycle?.state).toBe('completed')
    expect(subagentStatus(done[0]!, true)).toBe('done')
  })

  it('keeps a completed agent completed after closeAgent shuts it down', () => {
    const calls = applyCodexThreadStates([
      spawn({ 'child-1': { status: 'running' } }),
      wait('completed', 2),
      { ...wait('shutdown', 3), title: 'closeAgent' }
    ])
    expect(calls[0]?.subagentLifecycle?.state).toBe('completed')
  })

  it('maps errored and interrupted threads', () => {
    expect(
      applyCodexThreadStates([spawn({ 'child-1': { status: 'errored' } })])[0]?.subagentLifecycle
        ?.state
    ).toBe('failed')
    expect(
      applyCodexThreadStates([spawn({ 'child-1': { status: 'interrupted' } })])[0]
        ?.subagentLifecycle?.state
    ).toBe('cancelled')
  })

  it('reads activity cards', () => {
    const activity = (kind: string, seq: number): ToolCall => ({
      toolCallId: `act-${kind}`,
      title: `${kind} subagent weather`,
      kind: 'other',
      status: 'completed',
      seq,
      rawInput: { agentThreadId: 'child-1', agentPath: '/root/weather', activityKind: kind }
    })
    const calls = applyCodexThreadStates([
      spawn({ 'child-1': { status: 'pendingInit' } }),
      activity('started', 2),
      activity('completed', 3)
    ])
    expect(calls[0]?.subagentLifecycle?.state).toBe('completed')
    expect(calls[1]?.subagentLifecycle?.state).toBe('completed')
  })

  it('returns the same array when nothing changes', () => {
    const plain: ToolCall[] = [{ toolCallId: 'read', kind: 'read', rawInput: { path: 'a' } }]
    expect(applyCodexThreadStates(plain)).toBe(plain)
    const once = applyCodexThreadStates([spawn({ 'child-1': { status: 'running' } })])
    expect(applyCodexThreadStates(once)).toBe(once)
  })

  it('patches the spawn card through store ingest', () => {
    logMock.mockClear()
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
    seedSession('s1', 'agent-1')
    ingest('call', {
      ...spawn({ 'child-1': { status: 'running' } }),
      seq: undefined
    } as unknown as Record<string, unknown>)
    expect(stored('spawn-1').subagentLifecycle?.state).toBe('running')
    ingest('call', { ...wait('completed'), seq: undefined } as unknown as Record<string, unknown>)
    expect(stored('spawn-1').subagentLifecycle?.state).toBe('completed')
  })
})

describe('cancelRunningSubagents', () => {
  it('cancels only calls the host still marks running', () => {
    const running: ToolCall = {
      toolCallId: 'child-1',
      status: 'in_progress',
      subagentLifecycle: { state: 'running', agentId: 'child-1' }
    }
    const done: ToolCall = {
      toolCallId: 'child-2',
      status: 'completed',
      subagentLifecycle: { state: 'completed', endedAt: 5 }
    }
    const toolCalls = { s1: [running, done], s2: [running] }
    const settled = cancelRunningSubagents(toolCalls, ['s1'], 20)
    expect(settled).not.toBe(toolCalls)
    expect(settled.s1[0]?.subagentLifecycle).toEqual({
      state: 'cancelled',
      agentId: 'child-1',
      endedAt: 20
    })
    expect(settled.s1[1]).toBe(done)
    expect(settled.s2).toBe(toolCalls.s2)
    expect(cancelRunningSubagents(settled, ['s1'], 30)).toBe(settled)
  })
})
