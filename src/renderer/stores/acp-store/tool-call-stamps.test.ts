/**
 * A legacy tool call record without ordering stamps adopts the live ones when a
 * live tool_call or tool_call_update merges into it, so it sorts and splits
 * turns like every live-ingested call. Stamped records keep their placement.
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

const stored = () => useAcpStore.getState().toolCalls.s1[0]

function seedLegacy(extra: Record<string, unknown> = {}): void {
  useAcpStore.setState((s) => ({
    toolCalls: { ...s.toolCalls, s1: [{ toolCallId: 'tc-1', status: 'pending', ...extra }] }
  }))
}

describe('ordering stamps on merge', () => {
  beforeEach(() => {
    logMock.mockClear()
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
    seedSession('s1', 'agent-1')
  })

  it('stamps a legacy record when a live update merges into it', () => {
    seedLegacy()
    ingest('update', { toolCallId: 'tc-1', status: 'completed' })
    expect(typeof stored().seq).toBe('number')
    expect(typeof stored().timestamp).toBe('number')
  })

  it('stamps a legacy record when a live tool_call re-emission merges into it', () => {
    seedLegacy()
    ingest('call', { toolCallId: 'tc-1', status: 'in_progress' })
    expect(typeof stored().seq).toBe('number')
    expect(typeof stored().timestamp).toBe('number')
  })

  it('keeps the original stamps of a stamped record', () => {
    seedLegacy({ seq: 3, timestamp: 30 })
    ingest('update', { toolCallId: 'tc-1', status: 'completed' })
    ingest('call', { toolCallId: 'tc-1', status: 'completed' })
    expect(stored().seq).toBe(3)
    expect(stored().timestamp).toBe(30)
  })
})
