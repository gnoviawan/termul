/**
 * Subagent work stays inside its subagent: Claude stamps
 * `_meta.claudeCode.parentToolUseId` on every tool call and text chunk a
 * subagent makes. Child calls keep that id, and child text goes to the
 * dispatch card, never to the main reply (live and reconnect recovery).
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

import type { ToolCall } from '@/lib/acp-api'
import {
  _flushCoalescedForTesting,
  _installTransportRecoveryForTesting,
  _resetCoalesceForTesting,
  useAcpStore
} from '@/stores/acp-store'
import {
  _resetSubagentTranscriptLogsForTesting,
  MAX_SUBAGENT_TEXT_CHARS,
  withParentToolCallId
} from './subagent-transcript'
import { FRESH, seedSession } from './testkit'

const dispatchInput = {
  description: 'Audit the renderer',
  prompt: 'Read every file under src/renderer and report.',
  subagent_type: 'general-purpose'
}

const childMeta = (parent: string) => ({ claudeCode: { parentToolUseId: parent } })

function toolCall(payload: Record<string, unknown>): void {
  useAcpStore.getState()._onToolCall({
    agentId: 'agent-1',
    sessionId: 's1',
    toolCall: payload as { toolCallId: string }
  })
  _flushCoalescedForTesting()
}

function chunk(text: string, parentToolCallId?: string, role: 'agent' | 'thought' = 'agent'): void {
  useAcpStore.getState()._onMessageChunk({
    agentId: 'agent-1',
    sessionId: 's1',
    role,
    content: { type: 'text', text },
    ...(parentToolCallId ? { parentToolCallId } : {})
  })
  _flushCoalescedForTesting()
}

const stored = (id: string, sid = 's1'): ToolCall => {
  const call = useAcpStore.getState().toolCalls[sid]?.find((tc) => tc.toolCallId === id)
  if (!call) throw new Error(`no tool call ${id}`)
  return call
}

describe('withParentToolCallId', () => {
  it('lifts the Claude parent stamp and ignores a self or oversized id', () => {
    expect(
      withParentToolCallId({ toolCallId: 'c1', _meta: childMeta('d1') }).parentToolCallId
    ).toBe('d1')
    expect(withParentToolCallId({ toolCallId: 'd1', _meta: childMeta('d1') })).not.toHaveProperty(
      'parentToolCallId'
    )
    expect(
      withParentToolCallId({ toolCallId: 'c1', _meta: childMeta('x'.repeat(513)) })
    ).not.toHaveProperty('parentToolCallId')
    const plain = { toolCallId: 'c1' }
    expect(withParentToolCallId(plain)).toBe(plain)
  })
})

describe('subagent transcript ingest (live)', () => {
  beforeEach(() => {
    logMock.mockClear()
    _resetCoalesceForTesting()
    _resetSubagentTranscriptLogsForTesting()
    useAcpStore.setState(FRESH)
    seedSession('s1', 'agent-1')
  })

  it('keeps the dispatch id on a child tool call', () => {
    toolCall({ toolCallId: 'd1', status: 'in_progress', rawInput: dispatchInput })
    toolCall({
      toolCallId: 'c1',
      kind: 'read',
      title: 'Read src/main.tsx',
      status: 'completed',
      _meta: childMeta('d1')
    })
    expect(stored('c1').parentToolCallId).toBe('d1')
    expect(stored('d1').parentToolCallId).toBeUndefined()
  })

  it('appends subagent text to its dispatch card and not to the main reply', () => {
    chunk('Starting the audit. ')
    toolCall({ toolCallId: 'd1', status: 'in_progress', rawInput: dispatchInput })
    chunk('Found 3 issues', 'd1')
    chunk(' in the renderer.', 'd1')
    chunk('internal thinking', 'd1', 'thought')

    expect(stored('d1').subagentText).toBe('Found 3 issues in the renderer.')
    const messages = useAcpStore.getState().messages.s1
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([{ type: 'text', text: 'Starting the audit. ' }])
  })

  it('drops text for an unknown dispatch and logs it once', () => {
    chunk('orphan one', 'missing')
    chunk('orphan two', 'missing')
    expect(useAcpStore.getState().messages.s1).toEqual([])
    const orphanLogs = logMock.mock.calls.filter(
      (call) => (call as unknown[])[0] && JSON.stringify(call).includes('acp-store.subagentText')
    )
    expect(orphanLogs).toHaveLength(1)
  })

  it('keeps only the newest tail of a long subagent text', () => {
    toolCall({ toolCallId: 'd1', status: 'in_progress', rawInput: dispatchInput })
    chunk('a'.repeat(MAX_SUBAGENT_TEXT_CHARS), 'd1')
    chunk('END', 'd1')
    const text = stored('d1').subagentText ?? ''
    expect(text).toHaveLength(MAX_SUBAGENT_TEXT_CHARS)
    expect(text.endsWith('END')).toBe(true)
  })
})

describe('subagent transcript ingest (reconnect recovery)', () => {
  beforeEach(() => {
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
  })

  it('rebuilds child ids, child text, and the background state from the snapshot', async () => {
    seedSession('s-rec', 'agent-1', false)
    await _installTransportRecoveryForTesting({
      sessionId: 's-rec',
      watermark: 20,
      events: [
        {
          sid: 's-rec',
          seq: 10,
          type: 'user_prompt',
          payload: { turnId: 't1', content: [{ type: 'text', text: 'Audit it' }] }
        },
        {
          sid: 's-rec',
          seq: 11,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'Launching. ' } }
        },
        {
          sid: 's-rec',
          seq: 12,
          type: 'tool_call',
          payload: {
            toolCall: {
              toolCallId: 'd1',
              status: 'pending',
              rawInput: { ...dispatchInput, run_in_background: true }
            }
          }
        },
        {
          sid: 's-rec',
          seq: 13,
          type: 'tool_call',
          payload: {
            toolCall: {
              toolCallId: 'c1',
              kind: 'read',
              status: 'completed',
              _meta: childMeta('d1')
            }
          }
        },
        {
          sid: 's-rec',
          seq: 14,
          type: 'message_chunk',
          payload: {
            role: 'agent',
            parentToolCallId: 'd1',
            content: { type: 'text', text: 'Child report' }
          }
        },
        {
          sid: 's-rec',
          seq: 15,
          type: 'message_chunk',
          payload: { role: 'agent', content: { type: 'text', text: 'Still waiting.' } }
        },
        {
          sid: 's-rec',
          seq: 16,
          type: 'tool_call_update',
          payload: { update: { toolCallId: 'd1', status: 'completed' } }
        }
      ]
    })
    _flushCoalescedForTesting()

    const dispatch = stored('d1', 's-rec')
    expect(dispatch.subagentText).toBe('Child report')
    expect(dispatch.subagentLifecycle?.background).toBe(true)
    expect(dispatch.status).toBe('completed')
    expect(stored('c1', 's-rec').parentToolCallId).toBe('d1')
    const agentText = useAcpStore
      .getState()
      .messages['s-rec'].filter((m) => m.role === 'agent')
      .flatMap((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')))
    expect(agentText.join('|')).not.toContain('Child report')
  })
})
