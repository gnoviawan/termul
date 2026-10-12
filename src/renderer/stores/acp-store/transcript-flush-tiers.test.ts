import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, warning: toastWarning }
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => false),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
vi.mock('@/lib/acp-agents-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    // Keep the REAL full loader: in server-history mode it reads through the
    // fake transport's `getSessionPayload` (the "host-owned" durable record).
    loadSessionPayload: actual.loadSessionPayload,
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {}),
    syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
  }
})

vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  getAllLeafPanes: () => [],
  findPaneContainingTab: () => null,
  useWorkspaceStore: {
    getState: () => ({ addAgentChatTab: vi.fn(), root: null })
  }
}))

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

const { mockPersistenceApi } = vi.hoisted(() => ({
  mockPersistenceApi: {
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true }))
  }
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: mockPersistenceApi
  }
})

import {
  _flushCoalescedForTesting,
  _isCoalescePendingForTesting,
  _resetCoalesceForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { BACKGROUND_FLUSH_MS, WATCHED_FLUSH_MS } from './slices/transcript-flush-clock'
import { FRESH, seedSession } from './testkit'

function chunk(sessionId: string, text: string): void {
  useAcpStore.getState()._onMessageChunk({
    agentId: 'agent-1',
    sessionId,
    role: 'agent',
    content: { type: 'text', text }
  })
}

const text = (sessionId: string): string =>
  (useAcpStore.getState().messages[sessionId] ?? [])
    .flatMap((m) => m.blocks.map((b) => b.text ?? ''))
    .join('')

/** Two live sessions streaming; `watched` is the active (on-screen) one. */
function seedTwo(): void {
  seedSession('watched', 'agent-1', true)
  const watched = useAcpStore.getState().sessions.watched
  seedSession('background', 'agent-1', true)
  useAcpStore.setState((s) => ({
    activeSessionId: 'watched',
    sessions: { ...s.sessions, watched },
    messages: { ...s.messages, watched: [] }
  }))
}

describe('transcript render clocks (store integration)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetCoalesceForTesting()
    useAcpStore.setState(FRESH)
    seedTwo()
  })
  afterEach(() => {
    _resetCoalesceForTesting()
    vi.useRealTimers()
  })

  it('the watched session paints within ~30 ms while a background session waits for its 100 ms clock', () => {
    chunk('watched', 'hello')
    chunk('background', 'quiet')
    vi.advanceTimersByTime(WATCHED_FLUSH_MS + 20)
    expect(text('watched')).toBe('hello')
    expect(text('background')).toBe('')
    vi.advanceTimersByTime(BACKGROUND_FLUSH_MS)
    expect(text('background')).toBe('quiet')
  })

  it('a permission request flushes buffered text first and never waits on a clock', () => {
    chunk('watched', 'before approval')
    chunk('background', 'also buffered')
    useAcpStore.getState()._onPermissionRequest({
      agentId: 'agent-1',
      sessionId: 'watched',
      requestId: 'r1',
      toolCall: { toolCallId: 'tc1' },
      options: []
    } as never)
    expect(useAcpStore.getState().pendingPermissions.r1).toBeDefined()
    expect(text('watched')).toBe('before approval')
    expect(text('background')).toBe('also buffered')
    expect(_isCoalescePendingForTesting()).toBe(false)
  })

  it('a question flushes immediately too', () => {
    chunk('watched', 'asking')
    useAcpStore.getState()._onQuestionRequest({
      agentId: 'agent-1',
      sessionId: 'watched',
      questionId: 'q1',
      question: 'Which?',
      options: []
    } as never)
    expect(useAcpStore.getState().pendingQuestions.q1).toBeDefined()
    expect(text('watched')).toBe('asking')
  })

  it('visibilitychange flushes every session at once', () => {
    chunk('watched', 'w')
    chunk('background', 'b')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(text('watched')).toBe('w')
    expect(text('background')).toBe('b')
    expect(_isCoalescePendingForTesting()).toBe(false)
  })

  it('switching the watched session re-tiers buffered updates', () => {
    chunk('background', 'now watched')
    useAcpStore.setState({ activeSessionId: 'background' })
    chunk('background', '!')
    vi.advanceTimersByTime(WATCHED_FLUSH_MS + 20)
    expect(text('background')).toBe('now watched!')
    _flushCoalescedForTesting()
  })
})
