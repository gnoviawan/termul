import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() }
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
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {})
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
  return { ...actual, persistenceApi: mockPersistenceApi }
})

import type { AcpTransport } from '@/lib/acp-transport'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  AcpTransportError
} from '@/lib/acp-transport'
import { _flushCoalescedForTesting, _resetAcpAuthForTesting, useAcpStore } from '@/stores/acp-store'
import { FRESH, flushTurnEnd } from './testkit'

const AGENT = 'agent-1'
const LOAD_ONLY = { loadSession: true }
const RESUME_ONLY = { loadSession: false, sessionCapabilities: { resume: {} } }
const LOAD_AND_RESUME = { loadSession: true, sessionCapabilities: { resume: {} } }

type FakeTransport = AcpTransport & {
  loadSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  subscribeSession?: ReturnType<typeof vi.fn>
}

function turnActive(sessionId: string): AcpTransportError {
  return new AcpTransportError('not_implemented', `ACP_REOPEN_TURN_ACTIVE: session ${sessionId}`)
}

function fakeTransport({ subscribe }: { subscribe: boolean }): FakeTransport {
  return {
    loadSession: vi.fn(async () => ({})),
    resumeSession: vi.fn(async () => ({})),
    ...(subscribe ? { subscribeSession: vi.fn(async () => {}) } : {}),
    seedSessionCursor: vi.fn(),
    connect: async () => {},
    dispose: () => {},
    historyMode: () => 'server' as const
  } as unknown as FakeTransport
}

function streamLiveChunk(sessionId: string, text: string): void {
  useAcpStore.getState()._onMessageChunk({
    agentId: AGENT,
    sessionId,
    role: 'agent',
    content: { type: 'text', text }
  })
  _flushCoalescedForTesting()
}

describe('acp-store: discovered reopen while another client runs a turn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetAcpTransportForTests(null)
    _resetAcpAuthForTesting()
    useAcpStore.setState(FRESH)
  })

  function connectAgent(capabilities: Record<string, unknown>): void {
    useAcpStore.setState({
      agents: { [AGENT]: { id: AGENT, capabilities } },
      agentStatus: { [AGENT]: 'connected' }
    })
  }

  it.each([
    {
      name: 'session/load',
      capabilities: LOAD_ONLY,
      reject: (t: FakeTransport, id: string) => t.loadSession.mockRejectedValue(turnActive(id))
    },
    {
      name: 'session/resume',
      capabilities: RESUME_ONLY,
      reject: (t: FakeTransport, id: string) => t.resumeSession.mockRejectedValue(turnActive(id))
    },
    {
      name: 'the session/load fallback after resume missed',
      capabilities: LOAD_AND_RESUME,
      reject: (t: FakeTransport, id: string) => {
        t.resumeSession.mockRejectedValue(new Error('Session not found'))
        t.loadSession.mockRejectedValue(turnActive(id))
      }
    }
  ])('attaches to the live turn when $name is rejected with ACP_REOPEN_TURN_ACTIVE', async ({
    capabilities,
    reject
  }) => {
    const id = 'sess-live'
    const transport = fakeTransport({ subscribe: true })
    reject(transport, id)
    _setAcpTransportForTests(transport)
    connectAgent(capabilities)

    await useAcpStore.getState().openDiscoveredSession(AGENT, id, '/work', 'p1')
    await flushTurnEnd()

    expect(transport.subscribeSession).toHaveBeenCalledWith(id, 0, true)
    const session = useAcpStore.getState().sessions[id]
    expect(session).toMatchObject({
      status: 'active',
      lastError: null,
      activeTurn: true,
      openTurnId: 'turn:live',
      discovered: true
    })
    expect(useAcpStore.getState().discoveredReopenContexts[id]).toBeUndefined()

    streamLiveChunk(id, 'still streaming')
    expect(useAcpStore.getState().messages[id]).toMatchObject([
      { role: 'agent', blocks: [{ type: 'text', text: 'still streaming' }] }
    ])
  })

  it('attaches on a transport without subscribe (desktop Tauri) and shows the broadcast turn', async () => {
    const id = 'sess-desk'
    const transport = fakeTransport({ subscribe: false })
    transport.loadSession.mockRejectedValue(turnActive(id))
    _setAcpTransportForTests(transport)
    connectAgent(LOAD_ONLY)

    await useAcpStore.getState().openDiscoveredSession(AGENT, id, '/work', 'p1')
    await flushTurnEnd()

    expect(useAcpStore.getState().sessions[id]).toMatchObject({
      status: 'active',
      lastError: null,
      activeTurn: true
    })
    streamLiveChunk(id, 'desktop broadcast')
    expect(useAcpStore.getState().messages[id]).toMatchObject([
      { role: 'agent', blocks: [{ type: 'text', text: 'desktop broadcast' }] }
    ])
  })

  it('keeps the retry context and surfaces the error when the live-turn subscribe fails', async () => {
    const id = 'sess-sub-fail'
    const transport = fakeTransport({ subscribe: true })
    transport.loadSession.mockRejectedValue(turnActive(id))
    transport.subscribeSession?.mockRejectedValue(new Error('subscribe refused'))
    _setAcpTransportForTests(transport)
    connectAgent(LOAD_ONLY)

    await expect(
      useAcpStore.getState().openDiscoveredSession(AGENT, id, '/work', 'p1')
    ).rejects.toThrow('subscribe refused')

    expect(useAcpStore.getState().sessions[id]?.lastError).toContain('subscribe refused')
    expect(useAcpStore.getState().discoveredReopenContexts[id]).toEqual({
      agentId: AGENT,
      cwd: '/work',
      projectId: 'p1'
    })
  })
})
